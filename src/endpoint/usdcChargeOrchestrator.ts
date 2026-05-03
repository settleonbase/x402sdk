/**
 * PR #4 (USDC charge orchestrator) ── 「USDC settle → 临时钱包 topup → 临时钱包 charge」三段编排
 *
 * 触发：`POST /api/nfcUsdcCharge` 在 `settleBeamioX402ToCardOwner` 成功后立刻 200 返回给 verra-home，
 * 然后 `void runUsdcChargeOrchestrator(...)` 后台执行：
 *
 *   L1 (topup leg)：
 *     1. `ethers.Wallet.createRandom()` 生成 ephemeral EOA（仅在内存）。
 *     2. `nfcTopupPreparePayload({ wallet: tmpEOA, amount: total, currency, cardAddress })`
 *        编码 `mintPointsByAdmin(tmpEOA, points6)` 的 ExecuteForAdmin payload。
 *     3. `nfcTopupPreCheckBUnitFee(cardAddr, data)` 算 issuer 须扣的 B-Unit 服务费（与 NFC topup 路径一致 2%）。
 *     4. **PR #4 v2** 推 session 进 `awaiting_topup_auth` 暴露 pendingTopup* 字段，等 POS 终端用 admin EOA 私钥
 *        `BeamioEthWallet.signExecuteForAdmin` 离线签 ExecuteForAdmin 后 POST 回 `/api/nfcUsdcChargeTopupAuth`。
 *        cluster 验签 recover==session.pos 后注入 `posTopupSignature`，本编排器 `awaitTopupSignature` 解析返回。
 *     5. POST localhost Master `/api/nfcUsdcTopup`，带 `recipientEOA=tmpEOA / topupFeeBUnits / originatingUSDCTx / chargeSessionId / posOperator
 *        + preSignedAdminSignature(=POS 离线签) + preSignedAdminSigner(=POS EOA)`。
 *        Master 跳过 service-admin 签直接 push `executeForAdminPool` → `executeForAdminProcess` 上链（contract recover==POS=admin）；
 *        post-base 阶段 `insertMemberTopupEvent` 写入新增列 `originating_usdc_tx / charge_session_id / pos_operator`。
 *     6. `providerBase.waitForTransaction(topupTx, 1, 60_000)` 等 1 个确认（Master 在 mint 前会 `DeployingSmartAccount` 部署 tmpAA）。
 *
 *   L2 (charge leg)：
 *     6. `resolveBeamioAaForEoaWithFallback(provider, tmpEOA)` 解析 tmpAA（topup 已部署）；带 3×2s 重试以防节点未同步。
 *     7. 链上读 `balanceOf(tmpAA, POINTS_ID=0)` 拿精确余额（避免向上 ceil 残留 dust）。
 *     8. 解析 cardOwner 的 AA（payeeAA）；不存在则 hard error（cardOwner 是商户必然有 AA）。
 *     9. 构造 `ContainerMain { account=tmpAA, to=payeeAA, items=[{ kind:1, asset=cardAddr, amount=balance, tokenId:0, data:'0x' }], nonce, deadline }`，
 *        用 tmpEOA `signTypedData` 签名。
 *    10. POST localhost Master `/api/AAtoEOA`，带 `containerPayload + currency + currencyAmount + originatingUSDCTx + chargeSessionId + posOperator + merchantCardAddress`。
 *        Master pushes `ContainerRelayPool` → `ContainerRelayProcess` → `relayContainerMainRelayed` 上链 → 立即 200 携 chargeTxHash。
 *
 *   L3 (cleanup)：
 *    11. tmpEOA 引用置空（只在内存里）；session 标 `success`。
 *
 * 失败处理：
 *   - awaiting_topup_auth 超时（POS 不在线/未签）⇒ session=error，loyalty 入账缺失等待人工对账（USDC 已结算到 cardOwner，无 ghost dust）。
 *   - L1 fail：session=error，无副作用（USDC 已结算到 cardOwner 是用户期望的目的地，仅 loyalty 入账缺失）。
 *   - L2 fail：5 次指数退避（1s / 2s / 4s / 8s / 16s）；全部失败后 session=error，**tmpEOA 引用立即销毁**。
 *     在 tmpAA 上残留 N currency-points 视为已知 ghost dust，由日志中 `[orchestrator-ghost-dust]` 关键字捕获供日后人工对账（用户接受）。
 *
 * Gas/费用：
 *   - L1 部署 tmpAA + mint：由 Master 持有的 paymaster signer 付（与 NFC topup 链路完全一致，不新增 gas 模型）。
 *   - L1 B-Unit 服务费：issuer（cardOwner）按 NFC topup 同款 2% 扣（PR #4 修补的既存缺口，q3 = a）。
 *   - L2 relay：由 Master paymaster 付 gas；charge 端固定 2 B-Unit 也由 issuer 付（既存机制）。
 *
 * 原子性：
 *   - 「USDC settle 成功 + L1 + L2 全部成功」是 happy path，单 sid 在 in-memory `chargeSessions` 推进至 `success`。
 *   - 中间任一段失败均不会让 USDC 退回（USDC 已实打实到 cardOwner，符合用户语义：USDC 直接付给商户是商业结算，loyalty topup/charge 闭环只是商户内部入账记录）。
 */
import { ethers } from 'ethers'
import { request, type RequestOptions } from 'node:http'
import Colors from 'colors/safe'
import { logger } from '../logger'
import {
	nfcTopupPreparePayload,
	nfcTopupPreCheckBUnitFee,
	hashContainerItems,
	readContainerNonceFromAAStorage,
	type ContainerRelayPayload,
} from '../MemberCard'
import { resolveBeamioAaForEoaWithFallback } from './resolveBeamioAaViaUserCardFactory'

const BASE_CHAIN_ID = 8453
const POINTS_ID = 0n

/** Master 端口与 `postLocalhost` 一致 */
const MASTER_PORT = 1111

/** 「使用既存 QR topup/charge 机制」的渠道标签：写入 `beamio_member_topup_events.topup_source = 'webPosNfcTopup'`，
 *  与 Android NFC topup 渠道在统计上区分明显，对账更友好。 */
const TOPUP_SOURCE_OVERRIDE = 'webPosNfcTopup' as const

/** L2 失败重试预算：5 次指数退避（1s/2s/4s/8s/16s ≈ 总 31s），符合用户 q2 = a「几个 block 周期」。 */
const L2_RETRY_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000] as const

/** L1 topup tx 等待 1 个确认的最长时长：60s（Master 提交后通常 2-6s 出块；30s 缓冲给 RPC 抖动） */
const L1_TX_CONFIRM_TIMEOUT_MS = 60_000

/** L2 解析 tmpAA 重试：Master 上链确认后 RPC 节点偶有同步延迟，3×2s 兜底。 */
const L2_AA_RESOLVE_RETRIES = 3
const L2_AA_RESOLVE_RETRY_INTERVAL_MS = 2000

/** Container deadline：从签名时刻起 5 分钟（与 `payByNfcUidPrepare` 一致） */
const CONTAINER_DEADLINE_OFFSET_SEC = 300

/** 与 beamioServer.jsonStringifyWithBigInt 同款：BigInt → 字符串，避免 `JSON.stringify` 抛 TypeError。 */
const stringifyWithBigInt = (obj: unknown): string =>
	JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))

/** 上层（beamioServer.ts）回调形态：仅推进 sid 的 in-memory `chargeSessions` 状态，
 *  orchestrator 不直接持有 Map（避免循环依赖 / 重复定义）。 */
export type OrchestratorSessionPatch = {
	state?:
		| 'topup_pending'
		| 'awaiting_topup_auth'
		| 'topup_confirmed'
		| 'charge_pending'
		| 'success'
		| 'error'
	error?: string | null
	tmpEOA?: string
	tmpAA?: string
	pointsMinted6?: string
	topupTxHash?: string
	chargeTxHash?: string
	/** PR #4 v2：暴露给 POS 端签 ExecuteForAdmin 用的字段。仅在进入 `awaiting_topup_auth` 时一次性写入；
	 *  `posTopupSignature` 落位后 cluster 会清掉这些字段，避免 session 落地数据无意义膨胀。 */
	pendingTopupCardAddr?: string | null
	pendingTopupRecipientEOA?: string | null
	pendingTopupData?: string | null
	pendingTopupDeadline?: number | null
	pendingTopupNonce?: string | null
	pendingTopupPoints6?: string | null
	pendingTopupBUnitFee?: string | null
}

export interface UsdcChargeOrchestratorContext {
	/** PR #3 sid（UUID v4，POS 用其轮询 `GET /api/nfcUsdcChargeSession`） */
	sid: string
	/** 校验过的 BeamioUserCard 地址（链上 owner 与 currency 已读到） */
	cardAddr: string
	/** card.owner() 链上权威值；orchestrator 把 points 从 tmpAA 转到 cardOwner 的 AA */
	cardOwner: string
	/** 卡链上 currency（与 nfcTopupPreparePayload 内部 cardCurrency 比对一致） */
	currency: string
	/** Charge breakdown total（卡币种文本，eg "12.34"）；这是 topup 给 tmp 钱包的 currency 金额 */
	totalCurrencyAmount: string
	/** 原始 x402 USDC settle 的 base tx，对账三段共享 */
	originatingUSDCTx: string
	/** USDC 结算金额 6 位定点，仅用于日志 */
	usdcAmount6: string
	/** 客户钱包地址（USDC 付款方），仅用于日志 */
	payer: string
	/** POS 终端钱包（admin / owner of card），作为 operator 进入 admin 记账 */
	posOperator: string | null
	/** POS / session id（USDC 编排 L2 与 NFC 一致的 nfc* 记账拆项） */
	nfcSubtotalCurrencyAmount: string
	nfcRequestCurrency: string
	nfcTipCurrencyAmount?: string
	nfcTipRateBps?: number
	nfcDiscountAmountFiat6?: string
	nfcDiscountRateBps?: number
	nfcTaxAmountFiat6?: string
	nfcTaxRateBps?: number
	/** Base chain provider；orchestrator 用它等 tx 确认 + 解析 AA + 读余额 */
	provider: ethers.JsonRpcProvider
	/** 进度推送回调（推 sid 的 in-memory `chargeSessions`） */
	updateSession: (patch: OrchestratorSessionPatch) => void
	/** PR #4 v2：阻塞等待 POS 端 POST `/api/nfcUsdcChargeTopupAuth` 注入的 admin 签名。
	 *  cluster 端实现：定期 read `chargeSessions[sid].posTopupSignature`（POS POST 时已 verify recover==session.pos），
	 *  返回 65-byte hex。超时（默认 120 s）⇒ `{ ok: false }`，orchestrator 写 session=error 并退出（不会走到 L2，
	 *  接受 USDC 已结算到 cardOwner / loyalty 入账缺失的 reconcile_pending 语义，符合用户 q3 = a 选择）。 */
	awaitTopupSignature: (timeoutMs: number) => Promise<{ ok: true; signature: string; signer: string } | { ok: false; error: string }>
	/** 默认 120s。POS 在 USDC settle 后若 1-2 拍轮询拿到 awaiting_topup_auth，本地 secp256k1 签 ~10ms，
	 *  实际 RTT 约 200-400ms。120s 足够覆盖 POS 端临时网络抖动 + 商户手指未点确认的 worst-case。 */
	topupSignatureTimeoutMs?: number
}

/** 内部：把对象 POST 到本机 Master，返回 { status, body }。与 beamioServer.postLocalhost 不同：
 *  postLocalhost 会把 master 响应直接 pipe 给客户端，不可消费；orchestrator 必须自己拿到响应继续推进。 */
const callMasterJson = async (
	path: string,
	body: object
): Promise<{ status: number; body: string }> => {
	return new Promise((resolve, reject) => {
		const opts: RequestOptions = {
			hostname: 'localhost',
			path,
			port: MASTER_PORT,
			method: 'POST',
			protocol: 'http:',
			headers: { 'Content-Type': 'application/json' },
		}
		const req = request(opts, (res) => {
			const chunks: Buffer[] = []
			res.on('data', (chunk: Buffer) => chunks.push(chunk))
			res.on('end', () => {
				const buf = Buffer.concat(chunks)
				resolve({ status: res.statusCode ?? 0, body: buf.toString('utf8') })
			})
			res.on('error', (err) => reject(err))
		})
		req.once('error', (err) => reject(err))
		req.write(stringifyWithBigInt(body))
		req.end()
	})
}

/** 把 Master JSON 响应里的 txHash 字段解析出来（topup 路径返回 `txHash`，container 路径返回 `USDC_tx`） */
const extractTxHash = (raw: string, fields: readonly string[]): string | null => {
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>
		for (const f of fields) {
			const v = parsed[f]
			if (typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v)) return v
		}
	} catch {
		/* swallow */
	}
	return null
}

/** Master 响应里的 success 字段（true 或 'true'） */
const isSuccess = (raw: string): boolean => {
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>
		return parsed.success === true
	} catch {
		return false
	}
}

/** Master 响应里的 error 字段（用于失败原因冒泡到 session.error） */
const extractError = (raw: string): string | null => {
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>
		const e = parsed.error
		if (typeof e === 'string' && e.trim()) return e.trim()
	} catch {
		/* swallow */
	}
	return null
}

/** 解析 mint 回执里 tmpEOA 实际入账的 points 数量（链上 `_mint(acct, POINTS_ID, points6, "")` 唯一来源）。
 *  优先链上读 `balanceOf(tmpAA, POINTS_ID)`：避免依赖 receipt log 解析，且能吸收任何后续操作（理论上首次 topup 后 == 本次 mint 数量）。 */
const readTmpAaPointsBalance = async (
	provider: ethers.Provider,
	cardAddr: string,
	tmpAA: string
): Promise<bigint> => {
	const cardErc1155 = new ethers.Contract(
		cardAddr,
		['function balanceOf(address,uint256) view returns (uint256)'],
		provider
	)
	return (await cardErc1155.balanceOf(tmpAA, POINTS_ID)) as bigint
}

/** 解析 cardOwner 的 AA：商户必然在 Beamio 体系内活跃（owner 自己已 mint/charge 多次），AA 必已部署。
 *  PR #4：若极端情况下 cardOwner AA 还没部署（首张卡刚 deploy 没任何活动），hard error 让 session 进 error，
 *  避免用 cardOwner EOA 当 `to`（ERC1155 转给 EOA 在 onERC1155Received 端会 revert）。 */
const resolveCardOwnerAA = async (
	provider: ethers.Provider,
	cardOwner: string
): Promise<string | null> => {
	for (let attempt = 0; attempt < L2_AA_RESOLVE_RETRIES; attempt++) {
		try {
			const aa = await resolveBeamioAaForEoaWithFallback(provider, cardOwner)
			if (aa) return aa
		} catch {
			/* tolerate */
		}
		if (attempt < L2_AA_RESOLVE_RETRIES - 1) {
			await new Promise((r) => setTimeout(r, L2_AA_RESOLVE_RETRY_INTERVAL_MS))
		}
	}
	return null
}

/** 解析 tmpEOA 的 AA：topup 已上链且 Master 已 DeployingSmartAccount，但 RPC 节点可能略晚同步。 */
const resolveTmpAaWithRetry = async (
	provider: ethers.Provider,
	tmpEOA: string
): Promise<string | null> => {
	for (let attempt = 0; attempt < L2_AA_RESOLVE_RETRIES; attempt++) {
		try {
			const aa = await resolveBeamioAaForEoaWithFallback(provider, tmpEOA)
			if (aa) return aa
		} catch {
			/* tolerate */
		}
		if (attempt < L2_AA_RESOLVE_RETRIES - 1) {
			await new Promise((r) => setTimeout(r, L2_AA_RESOLVE_RETRY_INTERVAL_MS))
		}
	}
	return null
}

/** PR #4 v2 默认值：POS 终端临时离线/锁屏的容忍上限。120 s 足够一次完整 retry 提示用户解锁后再签。 */
const DEFAULT_TOPUP_SIG_TIMEOUT_MS = 120_000

/** 内部：从 mintPointsByAdmin(data) 解析 points6，POS UI 显示用（避免 POS 再去做 ABI 解码）。 */
const tryParseMintPoints6 = (dataHex: string): bigint | null => {
	try {
		const iface = new ethers.Interface(['function mintPointsByAdmin(address toEOA, uint256 amount)'])
		const parsed = iface.parseTransaction({ data: dataHex })
		if (!parsed || parsed.name !== 'mintPointsByAdmin') return null
		return parsed.args[1] as bigint
	} catch {
		return null
	}
}

/** L1：tmp wallet topup（mintPointsByAdmin(tmpEOA, points6) via POS-signed ExecuteForAdmin → Master executeForAdmin）
 *
 *  PR #4 v2 流程：
 *  1. server `nfcTopupPreparePayload` → 拿 cardAddr/data/deadline/nonce + 算 B-Unit fee。
 *  2. updateSession 推 `awaiting_topup_auth` + 全部 pendingTopup* 字段；POS 轮询拿到后用 admin EOA 私钥
 *     `BeamioEthWallet.signExecuteForAdmin(...)` 签名，POST 回 `/api/nfcUsdcChargeTopupAuth`。
 *  3. cluster verify recover==session.pos 后写入 `posTopupSignature`，本函数 awaitTopupSignature 解析返回。
 *  4. 转发 Master `/api/nfcUsdcTopup`，把 POS sig 作为 `preSignedAdminSignature` 透传，Master 跳过 service-admin 签直接 push pool。
 *  5. 等 1 个确认。
 */
const runTopupLeg = async (
	ctx: UsdcChargeOrchestratorContext,
	tmpEOA: string
): Promise<{ ok: true; topupTxHash: string } | { ok: false; error: string }> => {
	if (!ctx.posOperator) {
		// no-NFC USDC charge 必须有 POS（cluster 已校验过；这里是防御性兜底）。无 POS ⇒ 没人能签 admin auth。
		return { ok: false, error: 'POS operator missing; cannot solicit topup admin signature' }
	}
	const prepared = await nfcTopupPreparePayload({
		wallet: tmpEOA,
		amount: ctx.totalCurrencyAmount,
		currency: ctx.currency,
		cardAddress: ctx.cardAddr,
	})
	if ('error' in prepared) {
		return { ok: false, error: `topup prepare: ${prepared.error}` }
	}

	const bunit = await nfcTopupPreCheckBUnitFee(ctx.cardAddr, prepared.data)
	if (!bunit.success) {
		return { ok: false, error: `topup B-Unit pre-check: ${bunit.error}` }
	}

	const points6 = tryParseMintPoints6(prepared.data)

	// 让 POS 看到要签什么：每个字段都得跟链上 ExecuteForAdmin 验签一致，签完回填 posTopupSignature。
	ctx.updateSession({
		state: 'awaiting_topup_auth',
		pendingTopupCardAddr: prepared.cardAddr,
		pendingTopupRecipientEOA: tmpEOA,
		pendingTopupData: prepared.data,
		pendingTopupDeadline: prepared.deadline,
		pendingTopupNonce: prepared.nonce,
		pendingTopupPoints6: points6 != null ? points6.toString() : null,
		pendingTopupBUnitFee: bunit.feeAmount?.toString() ?? '0',
	})
	logger(Colors.cyan(
		`[orchestrator] sid=${ctx.sid.slice(0, 8)}… awaiting_topup_auth: tmpEOA=${tmpEOA.slice(0, 10)}… ` +
		`points6=${points6?.toString() ?? 'n/a'} feeBUnits=${bunit.feeAmount?.toString() ?? 'n/a'} ` +
		`deadline=${prepared.deadline} expecting POS=${ctx.posOperator.slice(0, 10)}…`
	))

	const sigWait = await ctx.awaitTopupSignature(ctx.topupSignatureTimeoutMs ?? DEFAULT_TOPUP_SIG_TIMEOUT_MS)
	if (!sigWait.ok) {
		return { ok: false, error: `awaiting POS topup auth: ${sigWait.error}` }
	}
	logger(Colors.green(
		`[orchestrator] sid=${ctx.sid.slice(0, 8)}… POS topup auth received signer=${sigWait.signer.slice(0, 10)}…`
	))

	let resp: { status: number; body: string }
	try {
		resp = await callMasterJson('/api/nfcUsdcTopup', {
			cardAddr: prepared.cardAddr,
			data: prepared.data,
			deadline: prepared.deadline,
			nonce: prepared.nonce,
			recipientEOA: tmpEOA,
			cardOwner: ctx.cardOwner,
			currency: ctx.currency,
			currencyAmount: ctx.totalCurrencyAmount,
			payer: ctx.payer,
			USDC_tx: ctx.originatingUSDCTx,
			usdcAmount6: ctx.usdcAmount6,
			topupFeeBUnits: bunit.feeAmount?.toString() ?? '0',
			originatingUSDCTx: ctx.originatingUSDCTx,
			chargeSessionId: ctx.sid,
			posOperator: ctx.posOperator,
			topupSourceOverride: TOPUP_SOURCE_OVERRIDE,
			/** PR #4 v2：携 POS 离线签的 admin sig；Master 跳过 service-admin 签，contract recover==POS=admin。 */
			preSignedAdminSignature: sigWait.signature,
			preSignedAdminSigner: sigWait.signer,
		})
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err)
		return { ok: false, error: `topup forward to master failed: ${msg}` }
	}

	if (resp.status !== 200 || !isSuccess(resp.body)) {
		const m = extractError(resp.body) ?? `HTTP ${resp.status}`
		return { ok: false, error: `topup master rejected: ${m}` }
	}

	const txHash = extractTxHash(resp.body, ['txHash', 'USDC_tx'])
	if (!txHash) {
		return { ok: false, error: 'topup master returned no txHash' }
	}

	try {
		const receipt = await ctx.provider.waitForTransaction(txHash, 1, L1_TX_CONFIRM_TIMEOUT_MS)
		if (!receipt || receipt.status !== 1) {
			return { ok: false, error: `topup tx ${txHash.slice(0, 10)}… not confirmed (status=${receipt?.status ?? 'null'})` }
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err)
		return { ok: false, error: `topup waitForTransaction: ${msg}` }
	}

	return { ok: true, topupTxHash: txHash }
}

/** L2：tmp wallet charge（offline-sign ContainerMain via Master AAtoEOA → relayContainerMainRelayed）
 *  注：`ethers.Wallet.createRandom()` 实际返回 `HDNodeWallet`（带 mnemonic 派生路径），不是 `Wallet`，
 *  这里收 `BaseWallet` 联合类型同时兼容两者；只用 `signTypedData`，不依赖 HD 派生 API。 */
const runChargeLegOnce = async (
	ctx: UsdcChargeOrchestratorContext,
	tmpWallet: ethers.HDNodeWallet | ethers.Wallet,
	tmpAA: string,
	payeeAA: string
): Promise<{ ok: true; chargeTxHash: string; pointsMinted6: bigint } | { ok: false; error: string; retriable: boolean }> => {
	let pointsBalance: bigint
	try {
		pointsBalance = await readTmpAaPointsBalance(ctx.provider, ctx.cardAddr, tmpAA)
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err)
		return { ok: false, error: `read tmpAA balance: ${msg}`, retriable: true }
	}
	if (pointsBalance <= 0n) {
		return {
			ok: false,
			error: `tmpAA points balance == 0 (mint not visible yet?)`,
			retriable: true,
		}
	}

	let nonce: bigint
	try {
		nonce = await readContainerNonceFromAAStorage(ctx.provider, tmpAA, 'relayed')
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err)
		return { ok: false, error: `read tmpAA container nonce: ${msg}`, retriable: true }
	}

	const deadline = BigInt(Math.floor(Date.now() / 1000) + CONTAINER_DEADLINE_OFFSET_SEC)
	const items = [
		{
			kind: 1,
			asset: ctx.cardAddr,
			amount: pointsBalance.toString(),
			tokenId: '0',
			data: '0x',
		},
	]
	const itemsHash = hashContainerItems(items)

	const domain = {
		name: 'BeamioAccount',
		version: '1',
		chainId: BASE_CHAIN_ID,
		verifyingContract: tmpAA as `0x${string}`,
	}
	const types = {
		ContainerMain: [
			{ name: 'account', type: 'address' },
			{ name: 'to', type: 'address' },
			{ name: 'itemsHash', type: 'bytes32' },
			{ name: 'nonce', type: 'uint256' },
			{ name: 'deadline', type: 'uint256' },
		],
	}
	const message = {
		account: tmpAA,
		to: payeeAA,
		itemsHash,
		nonce,
		deadline,
	}

	let signature: string
	try {
		signature = await tmpWallet.signTypedData(domain, types, message)
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err)
		return { ok: false, error: `tmp wallet signTypedData: ${msg}`, retriable: false }
	}

	const containerPayload: ContainerRelayPayload = {
		account: tmpAA,
		to: payeeAA,
		items,
		nonce: nonce.toString(),
		deadline: deadline.toString(),
		signature,
	}

	let resp: { status: number; body: string }
	try {
		resp = await callMasterJson('/api/AAtoEOA', {
			containerPayload,
			currency: ctx.currency,
			currencyAmount: ctx.totalCurrencyAmount,
			merchantCardAddress: ctx.cardAddr,
			forText: `USDC charge orchestrator sid=${ctx.sid.slice(0, 8)}…`,
			originatingUSDCTx: ctx.originatingUSDCTx,
			chargeSessionId: ctx.sid,
			posOperator: ctx.posOperator ?? undefined,
			nfcSubtotalCurrencyAmount: ctx.nfcSubtotalCurrencyAmount,
			nfcRequestCurrency: ctx.nfcRequestCurrency,
			...(ctx.nfcTipCurrencyAmount != null && String(ctx.nfcTipCurrencyAmount).trim() !== ''
				? { nfcTipCurrencyAmount: String(ctx.nfcTipCurrencyAmount).trim() }
				: {}),
			...(ctx.nfcTipRateBps != null && ctx.nfcTipRateBps > 0 ? { nfcTipRateBps: ctx.nfcTipRateBps } : {}),
			...(ctx.nfcDiscountAmountFiat6 != null && String(ctx.nfcDiscountAmountFiat6).trim() !== ''
				? { nfcDiscountAmountFiat6: String(ctx.nfcDiscountAmountFiat6).trim() }
				: {}),
			...(ctx.nfcDiscountRateBps != null && ctx.nfcDiscountRateBps > 0
				? { nfcDiscountRateBps: ctx.nfcDiscountRateBps }
				: {}),
			...(ctx.nfcTaxAmountFiat6 != null && String(ctx.nfcTaxAmountFiat6).trim() !== ''
				? { nfcTaxAmountFiat6: String(ctx.nfcTaxAmountFiat6).trim() }
				: {}),
			...(ctx.nfcTaxRateBps != null && ctx.nfcTaxRateBps > 0 ? { nfcTaxRateBps: ctx.nfcTaxRateBps } : {}),
		})
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err)
		return { ok: false, error: `charge forward to master failed: ${msg}`, retriable: true }
	}

	if (resp.status !== 200 || !isSuccess(resp.body)) {
		const m = extractError(resp.body) ?? `HTTP ${resp.status}`
		// Master 端 nonce mismatch / link block / B-Unit 不足等多为 transient 或可恢复，标 retriable
		return { ok: false, error: `charge master rejected: ${m}`, retriable: true }
	}

	const chargeTxHash = extractTxHash(resp.body, ['USDC_tx', 'txHash'])
	if (!chargeTxHash) {
		return { ok: false, error: 'charge master returned no txHash', retriable: false }
	}

	return { ok: true, chargeTxHash, pointsMinted6: pointsBalance }
}

/** 编排器主入口 */
export const runUsdcChargeOrchestrator = async (
	ctx: UsdcChargeOrchestratorContext
): Promise<void> => {
	const t0 = Date.now()
	const tmpWallet = ethers.Wallet.createRandom()
	const tmpEOA = await tmpWallet.getAddress()
	logger(Colors.cyan(
		`[orchestrator] sid=${ctx.sid.slice(0, 8)}… USDC_tx=${ctx.originatingUSDCTx.slice(0, 10)}… ` +
		`card=${ctx.cardAddr.slice(0, 10)}… owner=${ctx.cardOwner.slice(0, 10)}… ` +
		`pos=${ctx.posOperator ? ctx.posOperator.slice(0, 10) + '…' : 'n/a'} ` +
		`total=${ctx.totalCurrencyAmount} ${ctx.currency} tmpEOA=${tmpEOA.slice(0, 10)}…`
	))
	ctx.updateSession({ state: 'topup_pending', tmpEOA })

	// L1 ------------------------------------------------------------------
	const l1 = await runTopupLeg(ctx, tmpEOA)
	if (!l1.ok) {
		logger(Colors.red(`[orchestrator] sid=${ctx.sid.slice(0, 8)}… L1 topup FAIL: ${l1.error}`))
		ctx.updateSession({ state: 'error', error: `Topup leg: ${l1.error}` })
		return
	}
	logger(Colors.green(
		`[orchestrator] sid=${ctx.sid.slice(0, 8)}… L1 topup tx=${l1.topupTxHash} confirmed (+${Date.now() - t0}ms)`
	))
	ctx.updateSession({ state: 'topup_confirmed', topupTxHash: l1.topupTxHash })

	// L2 setup -------------------------------------------------------------
	ctx.updateSession({ state: 'charge_pending' })
	const tmpAA = await resolveTmpAaWithRetry(ctx.provider, tmpEOA)
	if (!tmpAA) {
		logger(Colors.red(
			`[orchestrator-ghost-dust] sid=${ctx.sid.slice(0, 8)}… tmpEOA=${tmpEOA} cannot resolve tmpAA after topup tx=${l1.topupTxHash}; ` +
			`points minted on-chain but charge leg cannot proceed (tmp key dropped, dust permanent)`
		))
		ctx.updateSession({ state: 'error', error: 'Cannot resolve tmp wallet AA after topup' })
		return
	}
	const payeeAA = await resolveCardOwnerAA(ctx.provider, ctx.cardOwner)
	if (!payeeAA) {
		logger(Colors.red(
			`[orchestrator-ghost-dust] sid=${ctx.sid.slice(0, 8)}… cardOwner=${ctx.cardOwner} has NO AA on Base; ` +
			`tmpEOA=${tmpEOA} tmpAA=${tmpAA} holds points minted by L1 tx=${l1.topupTxHash} (dust permanent)`
		))
		ctx.updateSession({ state: 'error', error: 'Card owner has no AA on Base; cannot route ERC1155 points' })
		return
	}
	ctx.updateSession({ tmpAA })

	// L2 with retry --------------------------------------------------------
	let lastErr: string | null = null
	for (let attempt = 0; attempt < L2_RETRY_BACKOFF_MS.length; attempt++) {
		const l2 = await runChargeLegOnce(ctx, tmpWallet, tmpAA, payeeAA)
		if (l2.ok) {
			logger(Colors.green(
				`[orchestrator] sid=${ctx.sid.slice(0, 8)}… L2 charge tx=${l2.chargeTxHash} ` +
				`points=${l2.pointsMinted6.toString()} (+${Date.now() - t0}ms total) ✓`
			))
			ctx.updateSession({
				state: 'success',
				chargeTxHash: l2.chargeTxHash,
				pointsMinted6: l2.pointsMinted6.toString(),
				error: null,
			})
			return
		}
		lastErr = l2.error
		logger(Colors.yellow(
			`[orchestrator] sid=${ctx.sid.slice(0, 8)}… L2 attempt ${attempt + 1}/${L2_RETRY_BACKOFF_MS.length} FAIL ` +
			`(${l2.retriable ? 'retriable' : 'fatal'}): ${l2.error}`
		))
		if (!l2.retriable) break
		if (attempt < L2_RETRY_BACKOFF_MS.length - 1) {
			await new Promise((r) => setTimeout(r, L2_RETRY_BACKOFF_MS[attempt]))
		}
	}

	logger(Colors.red(
		`[orchestrator-ghost-dust] sid=${ctx.sid.slice(0, 8)}… L2 charge exhausted ${L2_RETRY_BACKOFF_MS.length} retries; ` +
		`tmpEOA=${tmpEOA} tmpAA=${tmpAA} holds points minted by L1 tx=${l1.topupTxHash} (dust permanent). ` +
		`payeeAA=${payeeAA} card=${ctx.cardAddr} lastError=${lastErr ?? 'unknown'}`
	))
	ctx.updateSession({ state: 'error', error: `Charge leg failed after retries: ${lastErr ?? 'unknown'}` })
}

/** POS + `sid` 的 USDC NFC Topup：USDC 已由顾客 x402 settle 至 cardOwner；挂点 mint 需 POS admin 签 ExecuteForAdmin（与 charge 编排器的 L1 同形，但 recipient 为 NFC 持卡人 EOA，无临时钱包 / 无 L2）。 */
export interface UsdcNfcTopupPosOrchestratorContext {
	sid: string
	cardAddr: string
	cardOwner: string
	currency: string
	currencyAmount: string
	recipientEOA: string
	prepared: { cardAddr: string; data: string; deadline: number; nonce: string }
	originatingUSDCTx: string
	usdcAmount6: string
	payer: string
	posOperator: string
	nfcUid: string
	nfcTagIdHex: string | null
	provider: ethers.JsonRpcProvider
	updateSession: (patch: OrchestratorSessionPatch) => void
	awaitTopupSignature: (timeoutMs: number) => Promise<
		{ ok: true; signature: string; signer: string } | { ok: false; error: string }
	>
	topupSignatureTimeoutMs?: number
}

export const runUsdcNfcTopupPosOrchestrator = async (ctx: UsdcNfcTopupPosOrchestratorContext): Promise<void> => {
	if (!ctx.posOperator) {
		ctx.updateSession({ state: 'error', error: 'POS operator missing; cannot solicit topup admin signature' })
		return
	}
	const prepared = ctx.prepared
	const bunit = await nfcTopupPreCheckBUnitFee(ctx.cardAddr, prepared.data)
	if (!bunit.success) {
		ctx.updateSession({ state: 'error', error: `topup B-Unit pre-check: ${bunit.error}` })
		return
	}
	const points6 = tryParseMintPoints6(prepared.data)
	ctx.updateSession({
		state: 'awaiting_topup_auth',
		pendingTopupCardAddr: prepared.cardAddr,
		pendingTopupRecipientEOA: ctx.recipientEOA,
		pendingTopupData: prepared.data,
		pendingTopupDeadline: prepared.deadline,
		pendingTopupNonce: prepared.nonce,
		pendingTopupPoints6: points6 != null ? points6.toString() : null,
		pendingTopupBUnitFee: bunit.feeAmount?.toString() ?? '0',
	})
	logger(
		Colors.cyan(
			`[orchestrator-USDC-topup] sid=${ctx.sid.slice(0, 8)}… awaiting_topup_auth: recipient=${ctx.recipientEOA.slice(0, 10)}… ` +
				`points6=${points6?.toString() ?? 'n/a'} feeBUnits=${bunit.feeAmount?.toString() ?? 'n/a'} ` +
				`deadline=${prepared.deadline} expecting POS=${ctx.posOperator.slice(0, 10)}…`
		)
	)

	const sigWait = await ctx.awaitTopupSignature(ctx.topupSignatureTimeoutMs ?? DEFAULT_TOPUP_SIG_TIMEOUT_MS)
	if (!sigWait.ok) {
		ctx.updateSession({ state: 'error', error: `awaiting POS topup auth: ${sigWait.error}` })
		return
	}
	logger(
		Colors.green(
			`[orchestrator-USDC-topup] sid=${ctx.sid.slice(0, 8)}… POS topup auth received signer=${sigWait.signer.slice(0, 10)}…`
		)
	)

	ctx.updateSession({ state: 'topup_pending' })

	let resp: { status: number; body: string }
	try {
		resp = await callMasterJson('/api/nfcUsdcTopup', {
			cardAddr: prepared.cardAddr,
			data: prepared.data,
			deadline: prepared.deadline,
			nonce: prepared.nonce,
			recipientEOA: ctx.recipientEOA,
			cardOwner: ctx.cardOwner,
			currency: ctx.currency,
			currencyAmount: ctx.currencyAmount,
			payer: ctx.payer,
			USDC_tx: ctx.originatingUSDCTx,
			usdcAmount6: ctx.usdcAmount6,
			nfcUid: ctx.nfcUid,
			...(ctx.nfcTagIdHex ? { nfcTagIdHex: ctx.nfcTagIdHex } : {}),
			topupFeeBUnits: bunit.feeAmount?.toString() ?? '0',
			originatingUSDCTx: ctx.originatingUSDCTx,
			chargeSessionId: ctx.sid,
			posOperator: ctx.posOperator,
			topupSourceOverride: TOPUP_SOURCE_OVERRIDE,
			preSignedAdminSignature: sigWait.signature,
			preSignedAdminSigner: sigWait.signer,
		})
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err)
		ctx.updateSession({ state: 'error', error: `topup forward to master failed: ${msg}` })
		return
	}

	if (resp.status !== 200 || !isSuccess(resp.body)) {
		const m = extractError(resp.body) ?? `HTTP ${resp.status}`
		ctx.updateSession({ state: 'error', error: `topup master rejected: ${m}` })
		return
	}

	const txHash = extractTxHash(resp.body, ['txHash', 'USDC_tx', 'executeForAdmin_tx'])
	if (!txHash) {
		ctx.updateSession({ state: 'error', error: 'topup master returned no txHash' })
		return
	}

	try {
		const receipt = await ctx.provider.waitForTransaction(txHash, 1, L1_TX_CONFIRM_TIMEOUT_MS)
		if (!receipt || receipt.status !== 1) {
			ctx.updateSession({
				state: 'error',
				error: `topup tx ${txHash.slice(0, 10)}… not confirmed (status=${receipt?.status ?? 'null'})`,
			})
			return
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err)
		ctx.updateSession({ state: 'error', error: `topup waitForTransaction: ${msg}` })
		return
	}

	ctx.updateSession({
		state: 'success',
		topupTxHash: txHash,
		pointsMinted6: points6 != null ? points6.toString() : undefined,
		chargeTxHash: undefined,
		error: null,
	})
	logger(Colors.green(`[orchestrator-USDC-topup] sid=${ctx.sid.slice(0, 8)}… done topupTx=${txHash.slice(0, 12)}…`))
}
