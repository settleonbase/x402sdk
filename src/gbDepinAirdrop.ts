/**
 * GBDepinAirdrop — Master pool + Cluster precheck (GBToken V2 consumeGb + protocol cron mint).
 */
import { ethers } from 'ethers'
import type { Response } from 'express'
import Colors from 'colors/safe'
import { logger } from './logger'
import { CONET_GB_ERC20, CONET_GUARDIAN_NODES_INFO_V6, resolveConetGbDepinAirdropAddress } from './chainAddresses'
import {
	Settle_ContractPool,
	ensureSettleContractPoolInitialized,
	hasIdleSettleConet,
	shiftSettleConet,
	unshiftSettleConet,
} from './settleContractPool'
import { resolveBeamioConetHttpRpcUrl } from './util'

ensureSettleContractPoolInitialized()

const GB_DEPIN_AIRDROP_ABI = [
	'function chargeUserGbForGuardianNode(uint256 guardianNodeId, address user, uint256 amount) returns (uint256 freeBurned, uint256 paidBurned)',
	'function airdropDepinPaidAll() returns (uint256 nodesMinted, uint256 nodesRegistered, uint256 totalGbMinted)',
	'function airdropDepinPaidPage(uint256 start, uint256 length, bool advanceGlobalClock) returns (uint256 nodesMinted, uint256 nodesRegistered, uint256 totalGbMinted)',
	'function paidRecipientOfGuardianNode(uint256 guardianNodeId) view returns (address)',
	'function previewStandardPaidOwed(uint256 timestamp) view returns (uint256 owed, uint256 elapsedSeconds, uint256 perSecond)',
	'function paidGbReceivedOf(address beneficiary) view returns (uint256)',
	'function paidGbReceivedOfGuardianNode(uint256 guardianNodeId) view returns (uint256)',
	'function paidGbSummaryOf(address beneficiary, uint256 anchorTs) view returns (tuple(uint256 cumulative, uint256 hour, uint256 day, uint256 week, uint256 month, uint256 year))',
	'function paidGbSummaryOfGuardianNode(uint256 guardianNodeId, uint256 anchorTs) view returns (tuple(uint256 cumulative, uint256 hour, uint256 day, uint256 week, uint256 month, uint256 year))',
] as const

const GUARDIAN_NODES_PAGE_ABI = [
	'function getAllNodes(uint256 start, uint256 length) view returns (tuple(uint256 id,string PGP,string PGPKey,string ip_addr,string regionName)[] allNodes)',
] as const

const GB_TOKEN_BALANCE_ABI = ['function balanceOfAll(address account) view returns (uint256 total, uint256 free, uint256 paid)'] as const

let conetReadProvider: ethers.JsonRpcProvider | undefined

function conetProvider(): ethers.JsonRpcProvider {
	if (!conetReadProvider) {
		conetReadProvider = new ethers.JsonRpcProvider(resolveBeamioConetHttpRpcUrl(), undefined, { batchMaxCount: 1 })
	}
	return conetReadProvider
}

function requireAirdropAddress(): string {
	const addr = resolveConetGbDepinAirdropAddress()
	if (!addr) throw new Error('CONET_GB_DEPIN_AIRDROP not configured')
	return addr
}

export type GbDepinChargeUserPayload = {
	guardianNodeId: bigint
	user: string
	amount: bigint
	res: Response
}

export type GbDepinAirdropAllPayload = {
	res?: Response
	silent?: boolean
	/** Paginated cron: start index into GuardianNodesInfoV6.getAllNodes */
	pageStart?: number
	pageSize?: number
	/** When true, advances GBDepinAirdrop.lastDepinPaidCallAt after this page */
	advanceGlobalClock?: boolean
}

export const gbDepinChargeUserPool: GbDepinChargeUserPayload[] = []
export const gbDepinAirdropAllPool: GbDepinAirdropAllPayload[] = []

let gbDepinChargeUserRunning = false
let gbDepinAirdropAllRunning = false
let gbDepinCronTimer: ReturnType<typeof setTimeout> | undefined
let gbDepinCronInFlight = false
/** Resume index for multi-tick paginated cron (reset when global clock advances). */
let gbDepinCronPageStart = 0
/** Wall-clock ms when cron first skipped due to gas > max (force execute after wait window). */
let gbDepinCronGasWaitStartedAt: number | undefined

export function kickGbDepinChargeUserPoolPress(): void {
	void gbDepinChargeUserPoolPress().catch((error: unknown) => {
		const msg = error instanceof Error ? error.message : String(error)
		logger(Colors.red('[gbDepinChargeUserPoolPress] unhandled:'), msg)
	})
}

function scheduleGbDepinChargeUserPoolPress(): void {
	if (gbDepinChargeUserPool.length === 0) return
	if (hasIdleSettleConet()) kickGbDepinChargeUserPoolPress()
	else setTimeout(() => kickGbDepinChargeUserPoolPress(), 3000)
}

export async function gbDepinChargeUserPoolPress(): Promise<void> {
	if (gbDepinChargeUserRunning) return
	gbDepinChargeUserRunning = true
	const obj = gbDepinChargeUserPool.shift()
	if (!obj) {
		gbDepinChargeUserRunning = false
		return
	}
	const sc = shiftSettleConet()
	if (!sc) {
		gbDepinChargeUserPool.unshift(obj)
		gbDepinChargeUserRunning = false
		return scheduleGbDepinChargeUserPoolPress()
	}
	try {
		const airdrop = requireAirdropAddress()
		const c = new ethers.Contract(airdrop, GB_DEPIN_AIRDROP_ABI, sc.walletConet)
		const tx = await c.chargeUserGbForGuardianNode!(obj.guardianNodeId, obj.user, obj.amount, { gasLimit: 500_000 })
		const receipt = await tx.wait()
		const parsed = receipt?.logs ? parseChargeReceipt(c, receipt.logs) : null
		if (obj.res && !obj.res.headersSent) {
			obj.res.status(200).json({
				success: true,
				hash: tx.hash,
				freeBurned: parsed?.freeBurned.toString() ?? '0',
				paidBurned: parsed?.paidBurned.toString() ?? '0',
			}).end()
		}
	} catch (e: unknown) {
		const err = e as { shortMessage?: string; message?: string }
		const msg = err?.shortMessage ?? err?.message ?? String(e)
		logger(Colors.red('[gbDepinChargeUserPoolPress] failed:'), msg)
		if (obj.res && !obj.res.headersSent) obj.res.status(400).json({ success: false, error: msg }).end()
	} finally {
		unshiftSettleConet(sc)
		gbDepinChargeUserRunning = false
		scheduleGbDepinChargeUserPoolPress()
	}
}

function parseChargeReceipt(
	c: ethers.Contract,
	logs: readonly ethers.Log[],
): { freeBurned: bigint; paidBurned: bigint } | null {
	for (const log of logs) {
		try {
			const parsed = c.interface.parseLog({ topics: [...log.topics], data: log.data })
			if (parsed?.name === 'UserGbFeeCharged') {
				return {
					freeBurned: BigInt(String(parsed.args.freeBurned ?? parsed.args[4] ?? 0)),
					paidBurned: BigInt(String(parsed.args.paidBurned ?? parsed.args[5] ?? 0)),
				}
			}
		} catch {
			/* skip */
		}
	}
	return null
}

export function kickGbDepinAirdropAllPoolPress(): void {
	void gbDepinAirdropAllPoolPress().catch((error: unknown) => {
		const msg = error instanceof Error ? error.message : String(error)
		logger(Colors.red('[gbDepinAirdropAllPoolPress] unhandled:'), msg)
	})
}

function scheduleGbDepinAirdropAllPoolPress(): void {
	if (gbDepinAirdropAllPool.length === 0) return
	if (hasIdleSettleConet()) kickGbDepinAirdropAllPoolPress()
	else setTimeout(() => kickGbDepinAirdropAllPoolPress(), 3000)
}

export async function gbDepinAirdropAllPoolPress(): Promise<void> {
	if (gbDepinAirdropAllRunning) return
	gbDepinAirdropAllRunning = true
	const obj = gbDepinAirdropAllPool.shift()
	if (!obj) {
		gbDepinAirdropAllRunning = false
		return
	}
	const sc = shiftSettleConet()
	if (!sc) {
		gbDepinAirdropAllPool.unshift(obj)
		gbDepinAirdropAllRunning = false
		return scheduleGbDepinAirdropAllPoolPress()
	}
	try {
		const airdrop = requireAirdropAddress()
		const c = new ethers.Contract(airdrop, GB_DEPIN_AIRDROP_ABI, sc.walletConet)
		const usePage = obj.pageStart !== undefined && obj.pageSize !== undefined
		const maxGasLimit = resolveGbDepinAirdropMaxGasLimit()
		let gasLimit = maxGasLimit
		if (usePage) {
			try {
				const est = await c.airdropDepinPaidPage!.estimateGas(
					obj.pageStart,
					obj.pageSize,
					Boolean(obj.advanceGlobalClock),
				)
				gasLimit = (est * 120n) / 100n + 50_000n
				if (gasLimit > maxGasLimit) gasLimit = maxGasLimit
			} catch {
				/* keep maxGasLimit */
			}
		}
		const tx = usePage
			? await c.airdropDepinPaidPage!(obj.pageStart, obj.pageSize, Boolean(obj.advanceGlobalClock), {
					gasLimit,
				})
			: await c.airdropDepinPaidAll!({ gasLimit: maxGasLimit })
		const receipt = await tx.wait()
		if (obj.silent && usePage) {
			if (obj.advanceGlobalClock) gbDepinCronPageStart = 0
			else gbDepinCronPageStart = (obj.pageStart ?? 0) + (obj.pageSize ?? 0)
		}
		if (obj.res && !obj.res.headersSent) {
			obj.res
				.status(200)
				.json({
					success: true,
					hash: tx.hash,
					blockNumber: receipt?.blockNumber,
					pageStart: obj.pageStart,
					pageSize: obj.pageSize,
					advanceGlobalClock: obj.advanceGlobalClock,
				})
				.end()
		} else if (obj.silent) {
			const pageInfo =
				usePage ? ` page=${obj.pageStart}+${obj.pageSize} advance=${obj.advanceGlobalClock ? '1' : '0'}` : ''
			clearGbDepinGasWait()
			logger(Colors.green(`[gbDepinAirdropCron] ok tx=${tx.hash}${pageInfo} admin=${sc.walletConet.address}`))
		}
	} catch (e: unknown) {
		const err = e as { shortMessage?: string; message?: string; reason?: string }
		const msg = err?.shortMessage ?? err?.reason ?? err?.message ?? String(e)
		if (msg.includes('NothingToAirdrop') || msg.includes('Nothing to airdrop')) {
			if (obj.silent) {
				clearGbDepinGasWait()
				logger(Colors.gray('[gbDepinAirdropCron] nothing to airdrop'))
			}
			else if (obj.res && !obj.res.headersSent) obj.res.status(200).json({ success: true, skipped: true, reason: 'nothing_to_airdrop' }).end()
		} else {
			logger(Colors.red('[gbDepinAirdropAllPoolPress] failed:'), msg)
			if (obj.res && !obj.res.headersSent) obj.res.status(400).json({ success: false, error: msg }).end()
		}
	} finally {
		unshiftSettleConet(sc)
		gbDepinAirdropAllRunning = false
		scheduleGbDepinAirdropAllPoolPress()
	}
}

export async function gbDepinChargeUserClusterPreCheck(body: unknown): Promise<
	| { success: true; preChecked: { guardianNodeId: bigint; user: string; amount: bigint } }
	| { success: false; error: string }
> {
	try {
		const b = body as { guardianNodeId?: unknown; user?: unknown; amount?: unknown }
		const nodeIdRaw = b.guardianNodeId
		const nodeId =
			typeof nodeIdRaw === 'bigint'
				? nodeIdRaw
				: typeof nodeIdRaw === 'number'
					? BigInt(nodeIdRaw)
					: BigInt(String(nodeIdRaw ?? ''))
		if (nodeId <= 0n) return { success: false, error: 'invalid guardianNodeId' }
		if (!b.user || !ethers.isAddress(String(b.user))) return { success: false, error: 'invalid user address' }
		const user = ethers.getAddress(String(b.user))
		let amount: bigint
		try {
			amount = BigInt(String(b.amount ?? ''))
		} catch {
			return { success: false, error: 'invalid amount' }
		}
		if (amount <= 0n) return { success: false, error: 'amount must be positive' }

		const airdropAddr = resolveConetGbDepinAirdropAddress()
		if (!airdropAddr) return { success: false, error: 'GBDepinAirdrop not configured' }

		const provider = conetProvider()
		const airdrop = new ethers.Contract(airdropAddr, GB_DEPIN_AIRDROP_ABI, provider)
		const beneficiary = String(await airdrop.paidRecipientOfGuardianNode!(nodeId))
		if (!beneficiary || beneficiary === ethers.ZeroAddress) {
			return { success: false, error: 'guardian node has no redeem beneficiary' }
		}

		const gb = new ethers.Contract(CONET_GB_ERC20, GB_TOKEN_BALANCE_ABI, provider)
		const bal = (await gb.balanceOfAll!(user)) as [bigint, bigint, bigint]
		const total = bal[0] ?? 0n
		if (total < amount) return { success: false, error: 'insufficient GB balance' }

		return { success: true, preChecked: { guardianNodeId: nodeId, user, amount } }
	} catch (e: unknown) {
		const err = e as { shortMessage?: string; message?: string }
		return { success: false, error: err?.shortMessage ?? err?.message ?? 'precheck failed' }
	}
}

export async function gbDepinAirdropAllClusterPreCheck(): Promise<{ success: true } | { success: false; error: string }> {
	if (!resolveConetGbDepinAirdropAddress()) return { success: false, error: 'GBDepinAirdrop not configured' }
	try {
		const airdrop = new ethers.Contract(requireAirdropAddress(), GB_DEPIN_AIRDROP_ABI, conetProvider())
		const preview = (await airdrop.previewStandardPaidOwed!(Math.floor(Date.now() / 1000))) as [bigint, bigint, bigint]
		const owed = preview[0] ?? 0n
		if (owed <= 0n) return { success: false, error: 'nothing to airdrop yet' }
		return { success: true }
	} catch (e: unknown) {
		const err = e as { shortMessage?: string; message?: string }
		return { success: false, error: err?.shortMessage ?? err?.message ?? 'precheck failed' }
	}
}

function resolveGbDepinCronIntervalMs(): number {
	const raw = Number(process.env.CONET_GB_DEPIN_AIRDROP_CRON_MS ?? 60_000)
	return Number.isFinite(raw) && raw >= 15_000 ? Math.floor(raw) : 60_000
}

function resolveGbDepinAirdropPageSize(): number {
	/** ~3M gas @ 10 nodes; pageSize=100 can exceed 18M block gas on mainnet. */
	const raw = Number(process.env.CONET_GB_DEPIN_AIRDROP_PAGE_SIZE ?? 10)
	return Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), 500) : 10
}

function resolveGbDepinAirdropMaxGasLimit(): bigint {
	const raw = Number(process.env.CONET_GB_DEPIN_AIRDROP_MAX_GAS_LIMIT ?? 18_000_000)
	return Number.isFinite(raw) && raw >= 500_000 ? BigInt(Math.floor(raw)) : 18_000_000n
}

/** Only submit when eth_gasPrice ≤ this many gwei (default 2). CONET often sits at exactly 2.0 gwei — use ≤. */
function resolveGbDepinMaxGasPriceWei(): bigint {
	const gwei = Number(process.env.CONET_GB_DEPIN_AIRDROP_MAX_GAS_PRICE_GWEI ?? 2)
	const safe = Number.isFinite(gwei) && gwei > 0 ? gwei : 2
	return ethers.parseUnits(String(safe), 'gwei')
}

/** After this many ms waiting on high gas, force one airdrop at live gasPrice (default 10 min). */
function resolveGbDepinGasWaitForceMs(): number {
	const raw = Number(process.env.CONET_GB_DEPIN_AIRDROP_GAS_WAIT_FORCE_MS ?? 600_000)
	return Number.isFinite(raw) && raw >= 60_000 ? Math.floor(raw) : 600_000
}

function clearGbDepinGasWait(): void {
	gbDepinCronGasWaitStartedAt = undefined
}

function formatGbDepinGasWaitCountdown(elapsedMs: number, forceMs: number): string {
	const leftMs = Math.max(0, forceMs - elapsedMs)
	const elapsedSec = Math.floor(elapsedMs / 1000)
	const leftSec = Math.ceil(leftMs / 1000)
	const forceSec = Math.floor(forceMs / 1000)
	return `${elapsedSec}s/${forceSec}s (force in ${leftSec}s)`
}

async function readConetGasPriceWei(): Promise<bigint> {
	const provider = conetProvider()
	try {
		const fee = await provider.getFeeData()
		if (fee.gasPrice != null && fee.gasPrice > 0n) return fee.gasPrice
		if (fee.maxFeePerGas != null && fee.maxFeePerGas > 0n) return fee.maxFeePerGas
	} catch {
		/* fall through */
	}
	const hex = (await provider.send('eth_gasPrice', [])) as string
	return BigInt(hex)
}

type GbDepinCronGasGate = { run: true; force: boolean; gasPrice: bigint } | { run: false; gasPrice: bigint }

/** Mid-pagination must finish; otherwise wait for gas ≤ max or force after wait window. */
async function resolveGbDepinCronGasGate(): Promise<GbDepinCronGasGate> {
	if (gbDepinCronPageStart > 0) {
		return { run: true, force: false, gasPrice: await readConetGasPriceWei() }
	}

	const maxGas = resolveGbDepinMaxGasPriceWei()
	const gasDustWei = 50_000_000n // 0.05 gwei — CONET quotes e.g. 2.000000007 gwei
	const gasPrice = await readConetGasPriceWei()
	const forceMs = resolveGbDepinGasWaitForceMs()

	if (gasPrice <= maxGas + gasDustWei) {
		clearGbDepinGasWait()
		return { run: true, force: false, gasPrice }
	}

	const now = Date.now()
	if (gbDepinCronGasWaitStartedAt === undefined) gbDepinCronGasWaitStartedAt = now
	const elapsedMs = now - gbDepinCronGasWaitStartedAt
	if (elapsedMs >= forceMs) {
		return { run: true, force: true, gasPrice }
	}

	return { run: false, gasPrice }
}

async function fetchGuardianNodesPageLength(start: number, maxLength: number): Promise<number> {
	const guardian = CONET_GUARDIAN_NODES_INFO_V6
	if (!guardian || !ethers.isAddress(guardian)) return 0
	const c = new ethers.Contract(guardian, GUARDIAN_NODES_PAGE_ABI, conetProvider())
	const page = (await c.getAllNodes!(start, maxLength)) as unknown[]
	return Array.isArray(page) ? page.length : 0
}

async function gbDepinCronTick(): Promise<void> {
	if (gbDepinCronInFlight) return
	if (!resolveConetGbDepinAirdropAddress()) return
	gbDepinCronInFlight = true
	try {
		const gasGate = await resolveGbDepinCronGasGate()
		if (!gasGate.run) {
			const maxGas = resolveGbDepinMaxGasPriceWei()
			const forceMs = resolveGbDepinGasWaitForceMs()
			const elapsedMs = Date.now() - (gbDepinCronGasWaitStartedAt ?? Date.now())
			logger(
				Colors.yellow(
					`[gbDepinAirdropCron] skip tick: gasPrice=${ethers.formatUnits(gasGate.gasPrice, 'gwei')} gwei > max=${ethers.formatUnits(maxGas, 'gwei')} gwei ` +
						`wait ${formatGbDepinGasWaitCountdown(elapsedMs, forceMs)}`
				)
			)
			return
		}
		if (gasGate.force) {
			logger(
				Colors.yellow(
					`[gbDepinAirdropCron] force tick: gasPrice=${ethers.formatUnits(gasGate.gasPrice, 'gwei')} gwei exceeds max=${ethers.formatUnits(resolveGbDepinMaxGasPriceWei(), 'gwei')} gwei after ${Math.floor(resolveGbDepinGasWaitForceMs() / 1000)}s wait`
				)
			)
		}

		if (gbDepinCronPageStart === 0) {
			const pre = await gbDepinAirdropAllClusterPreCheck()
			if (!pre.success) return
		}
		const pageSize = resolveGbDepinAirdropPageSize()
		const pageLen = await fetchGuardianNodesPageLength(gbDepinCronPageStart, pageSize)
		const advanceGlobalClock = pageLen === 0 || pageLen < pageSize
		const effectiveStart = gbDepinCronPageStart
		const effectiveSize = pageLen === 0 ? 1 : pageLen
		gbDepinAirdropAllPool.push({
			silent: true,
			pageStart: effectiveStart,
			pageSize: effectiveSize,
			advanceGlobalClock,
		})
		kickGbDepinAirdropAllPoolPress()
	} finally {
		gbDepinCronInFlight = false
	}
}

function scheduleGbDepinCron(): void {
	if (gbDepinCronTimer !== undefined) clearTimeout(gbDepinCronTimer)
	gbDepinCronTimer = setTimeout(async () => {
		try {
			await gbDepinCronTick()
		} finally {
			scheduleGbDepinCron()
		}
	}, resolveGbDepinCronIntervalMs())
}

/**
 * Master-only: paginated airdropDepinPaidPage cron when CONET_GB_DEPIN_AIRDROP_CRON=1.
 * Uses Settle_ContractPool (settle_contractAdmin ×4) as CoNET gas payers / GBDepinAirdrop admins.
 */
export function startGbDepinAirdropCron(): void {
	if (process.env.CONET_GB_DEPIN_AIRDROP_CRON !== '1') {
		logger(Colors.gray('[gbDepinAirdropCron] disabled (set CONET_GB_DEPIN_AIRDROP_CRON=1)'))
		return
	}
	if (!resolveConetGbDepinAirdropAddress()) {
		logger(Colors.yellow('[gbDepinAirdropCron] disabled: CONET_GB_DEPIN_AIRDROP address missing'))
		return
	}
	logger(
		Colors.cyan(
			`[gbDepinAirdropCron] starting interval=${resolveGbDepinCronIntervalMs()}ms pageSize=${resolveGbDepinAirdropPageSize()} maxGasGwei=${ethers.formatUnits(resolveGbDepinMaxGasPriceWei(), 'gwei')} gasWaitForceMs=${resolveGbDepinGasWaitForceMs()} airdrop=${resolveConetGbDepinAirdropAddress()} settleAdmins=${Settle_ContractPool.length}`
		)
	)
	void gbDepinCronTick().finally(() => scheduleGbDepinCron())
}

export function stopGbDepinAirdropCron(): void {
	if (gbDepinCronTimer !== undefined) {
		clearTimeout(gbDepinCronTimer)
		gbDepinCronTimer = undefined
	}
}
