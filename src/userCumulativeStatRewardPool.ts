/**
 * User cumulative stat (IssuedNft V2) + #13 reward pool (ChargeReward V2) — Cluster 预检与 calldata 构建。
 * Master 写路径：owner/admin 经 executeForOwner；gateway-only 端点见 beamioServer 骨架（501）。
 */
import { ethers } from 'ethers'
import {
	chainIdForUserCardChain,
	hasCoNETUserCardBytecode,
	providerForUserCardChain,
	resolveUserCardChain,
} from './beamioUserCardChain'
import { getBeamioUserCardFactoryGateway } from './MemberCard'

export const ISSUED_NFT_START_ID_MEMBER = 100_000_000_000n

export const USER_CUMULATIVE_STAT_IFACE = new ethers.Interface([
	'function initializeCardUserCumulativeStatTokens()',
	'function bootstrapIssuedNftV2StatTokens(uint256 parentTokenId)',
	'function cardUserCumulativeStatTokensInitialized() view returns (bool)',
	'function recordUserCumulativeStat(address wallet, uint8 metricKind, uint8 targetKind, uint256 issuedParentId, uint256 delta)',
	'function burnUserCumulativeStatByGateway(address wallet, uint8 metricKind, uint8 targetKind, uint256 issuedParentId, uint256 delta)',
	'function resolveUserCumulativeStatTokenId(uint8 metricKind, uint8 targetKind, uint256 issuedParentId) view returns (uint256 globalTokenId, uint256 scopedTokenId)',
])

export const CHARGE_REWARD_V2_IFACE = new ethers.Interface([
	'function configureEventRewardRule(uint256 ruleId, bool active, uint8 eventKind, uint8 targetKind, uint256 issuedParentId, uint256 actorMint13, uint256 refMint13)',
	'function purchaseRewardProgram(address payerEOA, uint8 assetKind, uint256 amount, uint256 budget13PerUnit, uint8 cumulativeTargetKind, uint256 cumulativeIssuedParentId)',
	'function dispatchEventReward13(uint256 ruleId, address actorWallet, address refWallet, uint8 cumulativeTargetKind, uint256 cumulativeIssuedParentId, uint256 cumulativeDelta)',
	'function recordTopupCumulativeStat(address userEOA, uint256 points6)',
	'function rewardMintBudget13() view returns (uint256)',
])

export const INITIALIZE_CARD_USER_CUMUL_STAT_SELECTOR =
	USER_CUMULATIVE_STAT_IFACE.getFunction('initializeCardUserCumulativeStatTokens')?.selector ?? '0xe6848b85'

export const BOOTSTRAP_ISSUED_NFT_V2_STAT_SELECTOR =
	USER_CUMULATIVE_STAT_IFACE.getFunction('bootstrapIssuedNftV2StatTokens')?.selector ?? '0xf5ac2f52'

export const CONFIGURE_EVENT_REWARD_RULE_SELECTOR =
	CHARGE_REWARD_V2_IFACE.getFunction('configureEventRewardRule')?.selector ?? '0x3dd26ef8'

export const RECORD_USER_CUMULATIVE_STAT_SELECTOR =
	USER_CUMULATIVE_STAT_IFACE.getFunction('recordUserCumulativeStat')?.selector ?? '0xba62e9d5'

export const BURN_USER_CUMULATIVE_STAT_SELECTOR =
	USER_CUMULATIVE_STAT_IFACE.getFunction('burnUserCumulativeStatByGateway')?.selector ?? '0x00000000'

/** L1 merchant-card user-like scoped stat token (UserCumulativeStatLib.MERCHANT_CARD_LIKE_TOKEN_ID). */
export const MERCHANT_CARD_USER_LIKE_SCOPED_TOKEN_ID = 19n

export const RECORD_USER_LIKE_EIP712_TYPE = {
	RecordUserLike: [
		{ name: 'cardAddress', type: 'address' },
		{ name: 'userEOA', type: 'address' },
		{ name: 'targetKind', type: 'uint8' },
		{ name: 'issuedParentId', type: 'uint256' },
		{ name: 'liked', type: 'bool' },
		{ name: 'deadline', type: 'uint256' },
		{ name: 'nonce', type: 'bytes32' },
	],
}

/** @deprecated use RECORD_USER_LIKE_EIP712_TYPE */
export const RECORD_MERCHANT_CARD_USER_LIKE_EIP712_TYPE = RECORD_USER_LIKE_EIP712_TYPE

export const RECORD_TOPUP_CUMULATIVE_STAT_SELECTOR =
	CHARGE_REWARD_V2_IFACE.getFunction('recordTopupCumulativeStat')?.selector ?? '0x5a3f1b55'

export const PURCHASE_REWARD_PROGRAM_SELECTOR =
	CHARGE_REWARD_V2_IFACE.getFunction('purchaseRewardProgram')?.selector ?? '0xa9eaf30f'

export const DISPATCH_EVENT_REWARD13_SELECTOR =
	CHARGE_REWARD_V2_IFACE.getFunction('dispatchEventReward13')?.selector ?? '0x19b043d8'

/** UserCumulativeStatLib metric kinds (subset for API validation). */
export const UC_METRIC = {
	TOPUP: 1,
	CHARGE: 2,
	USER_CLICK: 3,
	USER_COMMENT: 4,
	USER_LIKE: 5,
	USER_PURCHASE: 6,
	REF_CLICK: 7,
	REF_CLAIM: 8,
	REF_BURN: 9,
	REF_LIKE: 10,
	REF_COMMENT: 11,
	REF_PURCHASE: 12,
	INSTALL: 13,
	REF_INSTALL: 14,
} as const

export const UC_TARGET = {
	GLOBAL_ONLY: 0,
	MERCHANT_CARD_COUPON: 1,
	ISSUED_COUPON: 2,
} as const

/** RewardPoolStorage asset kinds supported by purchaseRewardProgram (USDC/GB/B-Unit 仍 revert)。 */
export const UC_REWARD_ASSET = {
	POINTS0: 1,
	CHARGE_REWARD2: 2,
	VOUCHER13: 3,
} as const

const EXECUTE_FOR_OWNER_TYPES = {
	ExecuteForOwner: [
		{ name: 'cardAddress', type: 'address' },
		{ name: 'dataHash', type: 'bytes32' },
		{ name: 'deadline', type: 'uint256' },
		{ name: 'nonce', type: 'bytes32' },
	],
}

export function buildInitializeCardUserCumulativeStatCalldata(): string {
	return USER_CUMULATIVE_STAT_IFACE.encodeFunctionData('initializeCardUserCumulativeStatTokens', [])
}

export function buildBootstrapIssuedNftV2StatCalldata(parentTokenId: bigint | string | number): string {
	return USER_CUMULATIVE_STAT_IFACE.encodeFunctionData('bootstrapIssuedNftV2StatTokens', [BigInt(parentTokenId)])
}

export function buildConfigureEventRewardRuleCalldata(args: {
	ruleId: bigint | string | number
	active: boolean
	eventKind: number
	targetKind: number
	issuedParentId: bigint | string | number
	actorMint13: bigint | string | number
	refMint13: bigint | string | number
}): string {
	return CHARGE_REWARD_V2_IFACE.encodeFunctionData('configureEventRewardRule', [
		BigInt(args.ruleId),
		args.active,
		args.eventKind,
		args.targetKind,
		BigInt(args.issuedParentId),
		BigInt(args.actorMint13),
		BigInt(args.refMint13),
	])
}

export function buildRecordUserCumulativeStatCalldata(args: {
	wallet: string
	metricKind: number
	targetKind: number
	issuedParentId: bigint | string | number
	delta: bigint | string | number
}): string {
	return USER_CUMULATIVE_STAT_IFACE.encodeFunctionData('recordUserCumulativeStat', [
		ethers.getAddress(args.wallet),
		args.metricKind,
		args.targetKind,
		BigInt(args.issuedParentId),
		BigInt(args.delta),
	])
}

/** Unlike = burn user-held like stat tokens (ERC1155 `_update` to `address(0)` semantics). */
export function buildBurnUserCumulativeStatCalldata(args: {
	wallet: string
	metricKind: number
	targetKind: number
	issuedParentId: bigint | string | number
	delta: bigint | string | number
}): string {
	return USER_CUMULATIVE_STAT_IFACE.encodeFunctionData('burnUserCumulativeStatByGateway', [
		ethers.getAddress(args.wallet),
		args.metricKind,
		args.targetKind,
		BigInt(args.issuedParentId),
		BigInt(args.delta),
	])
}

export function buildRecordTopupCumulativeStatCalldata(userEOA: string, points6: bigint | string | number): string {
	return CHARGE_REWARD_V2_IFACE.encodeFunctionData('recordTopupCumulativeStat', [
		ethers.getAddress(userEOA),
		BigInt(points6),
	])
}

export function buildPurchaseRewardProgramCalldata(args: {
	payerEOA: string
	assetKind: number
	amount: bigint | string | number
	budget13PerUnit: bigint | string | number
	cumulativeTargetKind: number
	cumulativeIssuedParentId: bigint | string | number
}): string {
	return CHARGE_REWARD_V2_IFACE.encodeFunctionData('purchaseRewardProgram', [
		ethers.getAddress(args.payerEOA),
		args.assetKind,
		BigInt(args.amount),
		BigInt(args.budget13PerUnit),
		args.cumulativeTargetKind,
		BigInt(args.cumulativeIssuedParentId),
	])
}

export function buildDispatchEventReward13Calldata(args: {
	ruleId: bigint | string | number
	actorWallet: string
	refWallet: string
	cumulativeTargetKind: number
	cumulativeIssuedParentId: bigint | string | number
	cumulativeDelta: bigint | string | number
}): string {
	return CHARGE_REWARD_V2_IFACE.encodeFunctionData('dispatchEventReward13', [
		BigInt(args.ruleId),
		ethers.getAddress(args.actorWallet),
		args.refWallet && ethers.isAddress(args.refWallet) ? ethers.getAddress(args.refWallet) : ethers.ZeroAddress,
		args.cumulativeTargetKind,
		BigInt(args.cumulativeIssuedParentId),
		BigInt(args.cumulativeDelta),
	])
}

const FACTORY_GATEWAY_IFACE = new ethers.Interface([
	'function gatewayInvokeCard(address cardAddr, bytes data) returns (bytes)',
])

export function encodeGatewayInvokeCardFactoryCalldata(cardAddress: string, cardCalldata: string): string {
	return FACTORY_GATEWAY_IFACE.encodeFunctionData('gatewayInvokeCard', [
		ethers.getAddress(cardAddress),
		cardCalldata,
	])
}

export async function readCardUserCumulativeStatStatus(cardAddress: string): Promise<{
	ok: true
	cardAddress: string
	initialized: boolean
	owner: string
}> {
	const card = ethers.getAddress(cardAddress)
	if (!(await hasCoNETUserCardBytecode(card))) {
		throw new Error(`No BeamioUserCard bytecode on CoNET at ${card}`)
	}
	const chain = await resolveUserCardChain(card)
	const provider = providerForUserCardChain(chain)
	const reader = new ethers.Contract(
		card,
		[
			'function owner() view returns (address)',
			'function cardUserCumulativeStatTokensInitialized() view returns (bool)',
		],
		provider,
	)
	const [owner, initialized] = await Promise.all([
		reader.owner() as Promise<string>,
		reader.cardUserCumulativeStatTokensInitialized() as Promise<boolean>,
	])
	return { ok: true, cardAddress: card, initialized: !!initialized, owner: ethers.getAddress(owner) }
}

async function verifyExecuteForOwnerOwnerSignature(params: {
	cardAddress: string
	data: string
	deadline: number
	nonce: string
	ownerSignature: string
}): Promise<{ ok: true; owner: string } | { ok: false; error: string }> {
	const card = ethers.getAddress(params.cardAddress)
	const chain = await resolveUserCardChain(card)
	const provider = providerForUserCardChain(chain)
	const code = await provider.getCode(card)
	if (!code || code === '0x') return { ok: false, error: 'Card contract not found on CoNET' }

	const cardReader = new ethers.Contract(card, ['function owner() view returns (address)'], provider)
	const owner = (await cardReader.owner()) as string
	if (!owner || owner === ethers.ZeroAddress) return { ok: false, error: 'Card has no owner' }

	const verifyingContract = await getBeamioUserCardFactoryGateway(card)
	const chainId = chainIdForUserCardChain(chain)
	const domain = {
		name: 'BeamioUserCardFactory',
		version: '1',
		chainId,
		verifyingContract,
	}
	const dataHash = ethers.keccak256(params.data)
	const nonceBytes =
		params.nonce.length === 66 && params.nonce.startsWith('0x')
			? (params.nonce as `0x${string}`)
			: (ethers.keccak256(ethers.toUtf8Bytes(params.nonce)) as `0x${string}`)
	const value = {
		cardAddress: card,
		dataHash,
		deadline: Number(params.deadline),
		nonce: nonceBytes,
	}
	const digest = ethers.TypedDataEncoder.hash(domain, EXECUTE_FOR_OWNER_TYPES, value)
	const signer = ethers.recoverAddress(digest, params.ownerSignature)
	if (signer.toLowerCase() !== ethers.getAddress(owner).toLowerCase()) {
		return { ok: false, error: 'ownerSignature does not match card owner' }
	}
	if (Number(params.deadline) < Math.floor(Date.now() / 1000)) {
		return { ok: false, error: 'deadline expired' }
	}
	return { ok: true, owner: ethers.getAddress(owner) }
}

async function assertAdminStatsRoutesIssuedNftSelector(
	cardAddress: string,
	selector: string,
	label: string,
): Promise<string | null> {
	try {
		const chain = await resolveUserCardChain(cardAddress)
		const provider = providerForUserCardChain(chain)
		const gw = await getBeamioUserCardFactoryGateway(cardAddress)
		const factory = new ethers.Contract(
			gw,
			['function defaultAdminStatsQueryModule() view returns (address)'],
			provider,
		)
		const adminStats = (await factory.defaultAdminStatsQueryModule()) as string
		if (!adminStats || adminStats === ethers.ZeroAddress) {
			return `factory defaultAdminStatsQueryModule not configured (${label})`
		}
		const routeReader = new ethers.Contract(
			adminStats,
			['function selectorModuleKind(bytes4) view returns (uint8)'],
			provider,
		)
		const kind = Number(await routeReader.selectorModuleKind(selector))
		// BeamioUserCardModuleKinds.ISSUED_NFT = 2
		if (kind !== 2) {
			return `AdminStatsQueryModule routes ${label} to kind=${kind}, expected 2 (IssuedNft)`
		}
		return null
	} catch (e: unknown) {
		const err = e as { message?: string }
		return err?.message ?? String(e)
	}
}

async function assertAdminStatsRoutesChargeRewardSelector(
	cardAddress: string,
	selector: string,
	label: string,
): Promise<string | null> {
	try {
		const chain = await resolveUserCardChain(cardAddress)
		const provider = providerForUserCardChain(chain)
		const gw = await getBeamioUserCardFactoryGateway(cardAddress)
		const factory = new ethers.Contract(
			gw,
			['function defaultAdminStatsQueryModule() view returns (address)'],
			provider,
		)
		const adminStats = (await factory.defaultAdminStatsQueryModule()) as string
		if (!adminStats || adminStats === ethers.ZeroAddress) {
			return `factory defaultAdminStatsQueryModule not configured (${label})`
		}
		const routeReader = new ethers.Contract(
			adminStats,
			['function selectorModuleKind(bytes4) view returns (uint8)'],
			provider,
		)
		const kind = Number(await routeReader.selectorModuleKind(selector))
		// BeamioUserCardModuleKinds.CHARGE_REWARD = 5
		if (kind !== 5) {
			return `AdminStatsQueryModule routes ${label} to kind=${kind}, expected 5 (ChargeReward)`
		}
		return null
	} catch (e: unknown) {
		const err = e as { message?: string }
		return err?.message ?? String(e)
	}
}

export type ExecuteForOwnerForwardBody = {
	cardAddress: string
	data: string
	deadline: number
	nonce: string
	ownerSignature: string
}

/** Cluster：卡主 initializeCardUserCumulativeStatTokens（幂等；已初始化则拒绝）。 */
export const cardInitializeUserCumulativeStatPreCheck = async (body: {
	cardAddress?: string
	deadline?: number
	nonce?: string
	ownerSignature?: string
	data?: string
}): Promise<{ success: true; preChecked: ExecuteForOwnerForwardBody } | { success: false; error: string }> => {
	const { cardAddress, deadline, nonce, ownerSignature } = body
	if (!cardAddress || !ethers.isAddress(cardAddress)) return { success: false, error: 'Invalid cardAddress' }
	if (deadline == null || !nonce || !ownerSignature) {
		return { success: false, error: 'Missing deadline, nonce, or ownerSignature' }
	}
	const data =
		body.data && typeof body.data === 'string' && body.data.length >= 10
			? body.data
			: buildInitializeCardUserCumulativeStatCalldata()
	if (data.slice(0, 10).toLowerCase() !== INITIALIZE_CARD_USER_CUMUL_STAT_SELECTOR.toLowerCase()) {
		return { success: false, error: 'data must be initializeCardUserCumulativeStatTokens() calldata' }
	}
	try {
		const card = ethers.getAddress(cardAddress)
		const status = await readCardUserCumulativeStatStatus(card)
		if (status.initialized) {
			return { success: false, error: 'cardUserCumulativeStatTokens already initialized (idempotent no-op on-chain)' }
		}
		const routeErr = await assertAdminStatsRoutesIssuedNftSelector(
			card,
			INITIALIZE_CARD_USER_CUMUL_STAT_SELECTOR,
			'initializeCardUserCumulativeStatTokens',
		)
		if (routeErr) return { success: false, error: routeErr }

		const sig = await verifyExecuteForOwnerOwnerSignature({
			cardAddress: card,
			data,
			deadline: Number(deadline),
			nonce: String(nonce),
			ownerSignature: String(ownerSignature),
		})
		if (!sig.ok) return { success: false, error: sig.error }

		return {
			success: true,
			preChecked: {
				cardAddress: card,
				data,
				deadline: Number(deadline),
				nonce: String(nonce),
				ownerSignature: String(ownerSignature),
			},
		}
	} catch (e: unknown) {
		const err = e as { message?: string }
		return { success: false, error: err?.message ?? String(e) }
	}
}

/** Cluster：旧 issued 系列 bootstrapIssuedNftV2StatTokens(parentTokenId)。 */
export const cardBootstrapIssuedNftV2StatPreCheck = async (body: {
	cardAddress?: string
	parentTokenId?: string | number
	deadline?: number
	nonce?: string
	ownerSignature?: string
	data?: string
}): Promise<{ success: true; preChecked: ExecuteForOwnerForwardBody } | { success: false; error: string }> => {
	const { cardAddress, parentTokenId, deadline, nonce, ownerSignature } = body
	if (!cardAddress || !ethers.isAddress(cardAddress)) return { success: false, error: 'Invalid cardAddress' }
	if (parentTokenId == null && !body.data) return { success: false, error: 'Missing parentTokenId or data' }
	if (deadline == null || !nonce || !ownerSignature) {
		return { success: false, error: 'Missing deadline, nonce, or ownerSignature' }
	}
	const parentId = parentTokenId != null ? BigInt(parentTokenId) : undefined
	if (parentId != null && parentId < ISSUED_NFT_START_ID_MEMBER) {
		return { success: false, error: `parentTokenId must be >= ${ISSUED_NFT_START_ID_MEMBER}` }
	}
	const data =
		body.data && typeof body.data === 'string' && body.data.length >= 10
			? body.data
			: buildBootstrapIssuedNftV2StatCalldata(parentId ?? 0n)
	if (data.slice(0, 10).toLowerCase() !== BOOTSTRAP_ISSUED_NFT_V2_STAT_SELECTOR.toLowerCase()) {
		return { success: false, error: 'data must be bootstrapIssuedNftV2StatTokens(uint256) calldata' }
	}
	try {
		const decoded = USER_CUMULATIVE_STAT_IFACE.parseTransaction({ data })
		if (!decoded || decoded.name !== 'bootstrapIssuedNftV2StatTokens') {
			return { success: false, error: 'Invalid bootstrapIssuedNftV2StatTokens calldata' }
		}
		const decodedParent = BigInt(decoded.args[0])
		if (decodedParent < ISSUED_NFT_START_ID_MEMBER) {
			return { success: false, error: `parentTokenId must be >= ${ISSUED_NFT_START_ID_MEMBER}` }
		}

		const card = ethers.getAddress(cardAddress)
		const status = await readCardUserCumulativeStatStatus(card)
		if (!status.initialized) {
			return {
				success: false,
				error: 'cardUserCumulativeStatTokens not initialized; call cardInitializeUserCumulativeStat first',
			}
		}

		const routeErr = await assertAdminStatsRoutesIssuedNftSelector(
			card,
			BOOTSTRAP_ISSUED_NFT_V2_STAT_SELECTOR,
			'bootstrapIssuedNftV2StatTokens',
		)
		if (routeErr) return { success: false, error: routeErr }

		const sig = await verifyExecuteForOwnerOwnerSignature({
			cardAddress: card,
			data,
			deadline: Number(deadline),
			nonce: String(nonce),
			ownerSignature: String(ownerSignature),
		})
		if (!sig.ok) return { success: false, error: sig.error }

		return {
			success: true,
			preChecked: {
				cardAddress: card,
				data,
				deadline: Number(deadline),
				nonce: String(nonce),
				ownerSignature: String(ownerSignature),
			},
		}
	} catch (e: unknown) {
		const err = e as { message?: string }
		return { success: false, error: err?.message ?? String(e) }
	}
}

/** Cluster：owner 配置 #13 奖励规则 configureEventRewardRule。 */
export const cardConfigureEventRewardRulePreCheck = async (body: {
	cardAddress?: string
	ruleId?: string | number
	active?: boolean
	eventKind?: number
	targetKind?: number
	issuedParentId?: string | number
	actorMint13?: string | number
	refMint13?: string | number
	deadline?: number
	nonce?: string
	ownerSignature?: string
	data?: string
}): Promise<{ success: true; preChecked: ExecuteForOwnerForwardBody } | { success: false; error: string }> => {
	const { cardAddress, deadline, nonce, ownerSignature } = body
	if (!cardAddress || !ethers.isAddress(cardAddress)) return { success: false, error: 'Invalid cardAddress' }
	if (deadline == null || !nonce || !ownerSignature) {
		return { success: false, error: 'Missing deadline, nonce, or ownerSignature' }
	}
	const data =
		body.data && typeof body.data === 'string' && body.data.length >= 10
			? body.data
			: buildConfigureEventRewardRuleCalldata({
					ruleId: body.ruleId ?? 0,
					active: body.active !== false,
					eventKind: Number(body.eventKind ?? 0),
					targetKind: Number(body.targetKind ?? 0),
					issuedParentId: body.issuedParentId ?? 0,
					actorMint13: body.actorMint13 ?? 0,
					refMint13: body.refMint13 ?? 0,
				})
	if (data.slice(0, 10).toLowerCase() !== CONFIGURE_EVENT_REWARD_RULE_SELECTOR.toLowerCase()) {
		return { success: false, error: 'data must be configureEventRewardRule(...) calldata' }
	}
	try {
		const card = ethers.getAddress(cardAddress)
		const routeErr = await assertAdminStatsRoutesChargeRewardSelector(
			card,
			CONFIGURE_EVENT_REWARD_RULE_SELECTOR,
			'configureEventRewardRule',
		)
		if (routeErr) return { success: false, error: routeErr }

		const sig = await verifyExecuteForOwnerOwnerSignature({
			cardAddress: card,
			data,
			deadline: Number(deadline),
			nonce: String(nonce),
			ownerSignature: String(ownerSignature),
		})
		if (!sig.ok) return { success: false, error: sig.error }

		return {
			success: true,
			preChecked: {
				cardAddress: card,
				data,
				deadline: Number(deadline),
				nonce: String(nonce),
				ownerSignature: String(ownerSignature),
			},
		}
	} catch (e: unknown) {
		const err = e as { message?: string }
		return { success: false, error: err?.message ?? String(e) }
	}
}

function validateMetricTargetCombo(metricKind: number, targetKind: number, issuedParentId: bigint): string | null {
	if (metricKind === UC_METRIC.TOPUP || metricKind === UC_METRIC.CHARGE) {
		if (targetKind !== UC_TARGET.GLOBAL_ONLY) {
			return 'topup/charge metrics require targetKind=TARGET_GLOBAL_ONLY (0)'
		}
		return null
	}
	if (targetKind === UC_TARGET.ISSUED_COUPON) {
		if (issuedParentId < ISSUED_NFT_START_ID_MEMBER) {
			return `issuedParentId must be >= ${ISSUED_NFT_START_ID_MEMBER} for TARGET_ISSUED_COUPON`
		}
	}
	if (targetKind !== UC_TARGET.MERCHANT_CARD_COUPON && targetKind !== UC_TARGET.ISSUED_COUPON) {
		return 'targetKind must be 0 (global), 1 (merchant card), or 2 (issued coupon)'
	}
	return null
}

/** Cluster：owner/admin 记账 recordUserCumulativeStat（executeForOwner）。 */
export const cardRecordUserCumulativeStatPreCheck = async (body: {
	cardAddress?: string
	wallet?: string
	metricKind?: number
	targetKind?: number
	issuedParentId?: string | number
	delta?: string | number
	deadline?: number
	nonce?: string
	ownerSignature?: string
	data?: string
}): Promise<{ success: true; preChecked: ExecuteForOwnerForwardBody } | { success: false; error: string }> => {
	const { cardAddress, wallet, deadline, nonce, ownerSignature } = body
	if (!cardAddress || !ethers.isAddress(cardAddress)) return { success: false, error: 'Invalid cardAddress' }
	if (!wallet || !ethers.isAddress(wallet)) return { success: false, error: 'Invalid wallet' }
	if (deadline == null || !nonce || !ownerSignature) {
		return { success: false, error: 'Missing deadline, nonce, or ownerSignature' }
	}
	const metricKind = Number(body.metricKind ?? 0)
	const targetKind = Number(body.targetKind ?? 0)
	const issuedParentId = BigInt(body.issuedParentId ?? 0)
	const delta = BigInt(body.delta ?? 0)
	if (delta <= 0n) return { success: false, error: 'delta must be > 0' }
	const comboErr = validateMetricTargetCombo(metricKind, targetKind, issuedParentId)
	if (comboErr) return { success: false, error: comboErr }

	const data =
		body.data && typeof body.data === 'string' && body.data.length >= 10
			? body.data
			: buildRecordUserCumulativeStatCalldata({
					wallet,
					metricKind,
					targetKind,
					issuedParentId,
					delta,
				})
	if (data.slice(0, 10).toLowerCase() !== RECORD_USER_CUMULATIVE_STAT_SELECTOR.toLowerCase()) {
		return { success: false, error: 'data must be recordUserCumulativeStat(...) calldata' }
	}
	try {
		const card = ethers.getAddress(cardAddress)
		const status = await readCardUserCumulativeStatStatus(card)
		if (!status.initialized) {
			return { success: false, error: 'cardUserCumulativeStatTokens not initialized' }
		}
		const routeErr = await assertAdminStatsRoutesIssuedNftSelector(
			card,
			RECORD_USER_CUMULATIVE_STAT_SELECTOR,
			'recordUserCumulativeStat',
		)
		if (routeErr) return { success: false, error: routeErr }
		const sig = await verifyExecuteForOwnerOwnerSignature({
			cardAddress: card,
			data,
			deadline: Number(deadline),
			nonce: String(nonce),
			ownerSignature: String(ownerSignature),
		})
		if (!sig.ok) return { success: false, error: sig.error }
		return {
			success: true,
			preChecked: {
				cardAddress: card,
				data,
				deadline: Number(deadline),
				nonce: String(nonce),
				ownerSignature: String(ownerSignature),
			},
		}
	} catch (e: unknown) {
		const err = e as { message?: string }
		return { success: false, error: err?.message ?? String(e) }
	}
}

export type GatewayRewardPoolForwardBody = {
	cardAddress: string
	factoryCallData: string
}

async function gatewayRewardPoolBasePreCheck(
	cardAddress: string,
): Promise<{ card: string; needsInit: boolean } | { error: string }> {
	const card = ethers.getAddress(cardAddress)
	if (!(await hasCoNETUserCardBytecode(card))) return { error: 'Card not found on CoNET' }
	const status = await readCardUserCumulativeStatStatus(card)
	return { card, needsInit: !status.initialized }
}

/** Cluster：gateway recordTopupCumulativeStat（Master gatewayInvokeCard 队列）。 */
export const cardRecordTopupCumulativeStatPreCheck = async (body: {
	cardAddress?: string
	userEOA?: string
	points6?: string | number
}): Promise<{ success: true; preChecked: GatewayRewardPoolForwardBody } | { success: false; error: string }> => {
	if (!body.cardAddress || !ethers.isAddress(body.cardAddress)) return { success: false, error: 'Invalid cardAddress' }
	if (!body.userEOA || !ethers.isAddress(body.userEOA)) return { success: false, error: 'Invalid userEOA' }
	const points6 = BigInt(body.points6 ?? 0)
	if (points6 <= 0n) return { success: false, error: 'points6 must be > 0' }
	try {
		const base = await gatewayRewardPoolBasePreCheck(body.cardAddress)
		if ('error' in base) return { success: false, error: base.error }
		if (base.needsInit) {
			const initRouteErr = await assertAdminStatsRoutesIssuedNftSelector(
				base.card,
				INITIALIZE_CARD_USER_CUMUL_STAT_SELECTOR,
				'initializeCardUserCumulativeStatTokens',
			)
			if (initRouteErr) return { success: false, error: initRouteErr }
		}
		const cardCalldata = buildRecordTopupCumulativeStatCalldata(body.userEOA, points6)
		const routeErr = await assertAdminStatsRoutesChargeRewardSelector(
			base.card,
			RECORD_TOPUP_CUMULATIVE_STAT_SELECTOR,
			'recordTopupCumulativeStat',
		)
		if (routeErr) return { success: false, error: routeErr }
		return {
			success: true,
			preChecked: {
				cardAddress: base.card,
				factoryCallData: encodeGatewayInvokeCardFactoryCalldata(base.card, cardCalldata),
			},
		}
	} catch (e: unknown) {
		const err = e as { message?: string }
		return { success: false, error: err?.message ?? String(e) }
	}
}

/** Cluster：gateway purchaseRewardProgram。 */
export const cardPurchaseRewardProgramPreCheck = async (body: {
	cardAddress?: string
	payerEOA?: string
	assetKind?: number
	amount?: string | number
	budget13PerUnit?: string | number
	cumulativeTargetKind?: number
	cumulativeIssuedParentId?: string | number
}): Promise<{ success: true; preChecked: GatewayRewardPoolForwardBody } | { success: false; error: string }> => {
	if (!body.cardAddress || !ethers.isAddress(body.cardAddress)) return { success: false, error: 'Invalid cardAddress' }
	if (!body.payerEOA || !ethers.isAddress(body.payerEOA)) return { success: false, error: 'Invalid payerEOA' }
	const assetKind = Number(body.assetKind ?? 0)
	if (assetKind < 1 || assetKind > 3) {
		return { success: false, error: 'assetKind must be 1 (points), 2 (charge reward), or 3 (voucher #13)' }
	}
	const amount = BigInt(body.amount ?? 0)
	const budget13PerUnit = BigInt(body.budget13PerUnit ?? 0)
	if (amount <= 0n || budget13PerUnit <= 0n) {
		return { success: false, error: 'amount and budget13PerUnit must be > 0' }
	}
	try {
		const base = await gatewayRewardPoolBasePreCheck(body.cardAddress)
		if ('error' in base) return { success: false, error: base.error }
		const cardCalldata = buildPurchaseRewardProgramCalldata({
			payerEOA: body.payerEOA,
			assetKind,
			amount,
			budget13PerUnit,
			cumulativeTargetKind: Number(body.cumulativeTargetKind ?? 0),
			cumulativeIssuedParentId: body.cumulativeIssuedParentId ?? 0,
		})
		const routeErr = await assertAdminStatsRoutesChargeRewardSelector(
			base.card,
			PURCHASE_REWARD_PROGRAM_SELECTOR,
			'purchaseRewardProgram',
		)
		if (routeErr) return { success: false, error: routeErr }
		return {
			success: true,
			preChecked: {
				cardAddress: base.card,
				factoryCallData: encodeGatewayInvokeCardFactoryCalldata(base.card, cardCalldata),
			},
		}
	} catch (e: unknown) {
		const err = e as { message?: string }
		return { success: false, error: err?.message ?? String(e) }
	}
}

/** Cluster：gateway dispatchEventReward13。 */
export const cardDispatchEventReward13PreCheck = async (body: {
	cardAddress?: string
	ruleId?: string | number
	actorWallet?: string
	refWallet?: string
	cumulativeTargetKind?: number
	cumulativeIssuedParentId?: string | number
	cumulativeDelta?: string | number
}): Promise<{ success: true; preChecked: GatewayRewardPoolForwardBody } | { success: false; error: string }> => {
	if (!body.cardAddress || !ethers.isAddress(body.cardAddress)) return { success: false, error: 'Invalid cardAddress' }
	if (!body.actorWallet || !ethers.isAddress(body.actorWallet)) return { success: false, error: 'Invalid actorWallet' }
	const ruleId = BigInt(body.ruleId ?? 0)
	if (ruleId <= 0n) return { success: false, error: 'ruleId must be > 0' }
	const cumulativeDelta = BigInt(body.cumulativeDelta ?? 0)
	const refWallet =
		body.refWallet && ethers.isAddress(body.refWallet) ? ethers.getAddress(body.refWallet) : ethers.ZeroAddress
	try {
		const base = await gatewayRewardPoolBasePreCheck(body.cardAddress)
		if ('error' in base) return { success: false, error: base.error }
		const cardCalldata = buildDispatchEventReward13Calldata({
			ruleId,
			actorWallet: body.actorWallet,
			refWallet,
			cumulativeTargetKind: Number(body.cumulativeTargetKind ?? 0),
			cumulativeIssuedParentId: body.cumulativeIssuedParentId ?? 0,
			cumulativeDelta,
		})
		const routeErr = await assertAdminStatsRoutesChargeRewardSelector(
			base.card,
			DISPATCH_EVENT_REWARD13_SELECTOR,
			'dispatchEventReward13',
		)
		if (routeErr) return { success: false, error: routeErr }
		return {
			success: true,
			preChecked: {
				cardAddress: base.card,
				factoryCallData: encodeGatewayInvokeCardFactoryCalldata(base.card, cardCalldata),
			},
		}
	} catch (e: unknown) {
		const err = e as { message?: string }
		return { success: false, error: err?.message ?? String(e) }
	}
}

/** @deprecated 使用 cardGatewayRewardPool Master 队列；保留常量供 503 回退文案。 */
export const GATEWAY_REWARD_POOL_NOT_WIRED = {
	success: false,
	error: 'Gateway reward-pool write not wired yet; use Master internal queue (purchaseRewardProgram / dispatchEventReward13 / recordUserCumulativeStat).',
	code: 'UC_REWARD_POOL_GATEWAY_STUB',
} as const

async function eip712DomainForRecordUserLike(cardNorm: string) {
	const chain = await resolveUserCardChain(cardNorm)
	return {
		name: 'BeamioUserCardFactory' as const,
		version: '1' as const,
		chainId: chainIdForUserCardChain(chain),
		verifyingContract: await getBeamioUserCardFactoryGateway(cardNorm),
	}
}

/** Read scoped like-stat balance (token 19 for merchant card; parent+offset for issued coupon). */
export async function readUserLikeScopedTokenBalance(
	cardAddress: string,
	userEOA: string,
	targetKind: number,
	issuedParentId: bigint | string | number = 0,
): Promise<bigint | null> {
	try {
		const card = ethers.getAddress(cardAddress)
		const user = ethers.getAddress(userEOA)
		const parentId = BigInt(issuedParentId ?? 0)
		const chain = await resolveUserCardChain(card)
		const provider = providerForUserCardChain(chain)
		const reader = new ethers.Contract(
			card,
			[
				'function balanceOf(address account, uint256 id) view returns (uint256)',
				'function resolveUserCumulativeStatTokenId(uint8 metricKind, uint8 targetKind, uint256 issuedParentId) view returns (uint256 globalTokenId, uint256 scopedTokenId)',
			],
			provider,
		)
		const [, scopedTokenId] = (await reader.resolveUserCumulativeStatTokenId(
			UC_METRIC.USER_LIKE,
			targetKind,
			parentId,
		)) as [bigint, bigint]
		if (scopedTokenId === 0n) return 0n
		return (await reader.balanceOf(user, scopedTokenId)) as bigint
	} catch {
		return null
	}
}

export type CardRecordUserLikeForwardBody = {
	cardAddress: string
	factoryCallData: string
	liked: boolean
	targetKind: number
	issuedParentId: string
}

/**
 * Cluster：用户 EIP-712 签字点赞 / 解除点赞。
 * - Like：`recordUserCumulativeStat` mint 全局 + scoped like stat token 给用户。
 * - Unlike：`burnUserCumulativeStatByGateway` 焚烧用户持有的 like stat token（等同转到 0x0）。
 * 支持 L1 商户卡（targetKind=1）与 L2 优惠券（targetKind=2, issuedParentId=issued tokenId）。
 */
export const cardRecordUserLikePreCheck = async (body: {
	cardAddress?: string
	userEOA?: string
	targetKind?: number
	issuedParentId?: string | number
	liked?: boolean
	deadline?: number
	nonce?: string
	userSignature?: string
}): Promise<{ success: true; preChecked: CardRecordUserLikeForwardBody } | { success: false; error: string }> => {
	const { cardAddress, userEOA, deadline, nonce, userSignature } = body
	if (!cardAddress || !ethers.isAddress(cardAddress)) return { success: false, error: 'Invalid cardAddress' }
	if (!userEOA || !ethers.isAddress(userEOA)) return { success: false, error: 'Invalid userEOA' }
	if (typeof body.liked !== 'boolean') return { success: false, error: 'Missing liked (boolean)' }
	if (deadline == null || !Number.isFinite(Number(deadline)) || Number(deadline) <= Math.floor(Date.now() / 1000)) {
		return { success: false, error: 'Missing or expired deadline' }
	}
	if (!nonce || typeof nonce !== 'string' || !nonce.trim()) return { success: false, error: 'Missing nonce' }
	if (!userSignature || !ethers.isHexString(userSignature)) return { success: false, error: 'Invalid userSignature' }

	const targetKind = Number(body.targetKind ?? UC_TARGET.MERCHANT_CARD_COUPON)
	const issuedParentId = BigInt(body.issuedParentId ?? 0)
	const liked = Boolean(body.liked)
	const comboErr = validateMetricTargetCombo(UC_METRIC.USER_LIKE, targetKind, issuedParentId)
	if (comboErr) return { success: false, error: comboErr }

	const cardNorm = ethers.getAddress(cardAddress)
	const userNorm = ethers.getAddress(userEOA)
	const nonceBytes32 =
		nonce.length === 66 && nonce.startsWith('0x')
			? (nonce as `0x${string}`)
			: (ethers.keccak256(ethers.toUtf8Bytes(nonce)) as `0x${string}`)

	try {
		const base = await gatewayRewardPoolBasePreCheck(cardAddress)
		if ('error' in base) return { success: false, error: base.error }
		const cardNorm = base.card

		if (base.needsInit) {
			const initRouteErr = await assertAdminStatsRoutesIssuedNftSelector(
				cardNorm,
				INITIALIZE_CARD_USER_CUMUL_STAT_SELECTOR,
				'initializeCardUserCumulativeStatTokens',
			)
			if (initRouteErr) return { success: false, error: initRouteErr }
		}

		const domain = await eip712DomainForRecordUserLike(cardNorm)
		const digest = ethers.TypedDataEncoder.hash(domain, RECORD_USER_LIKE_EIP712_TYPE, {
			cardAddress: cardNorm,
			userEOA: userNorm,
			targetKind,
			issuedParentId,
			liked,
			deadline: BigInt(deadline),
			nonce: nonceBytes32,
		})
		const signer = ethers.recoverAddress(digest, userSignature)
		if (ethers.getAddress(signer) !== userNorm) {
			return { success: false, error: 'userSignature signer mismatch' }
		}

		const scopedBal = await readUserLikeScopedTokenBalance(cardNorm, userNorm, targetKind, issuedParentId)
		if (scopedBal == null) return { success: false, error: 'Unable to read like token balance' }
		if (liked && scopedBal > 0n) {
			return { success: false, error: 'User already liked this target' }
		}
		if (!liked && scopedBal <= 0n) {
			return { success: false, error: 'User has not liked this target' }
		}

		const statArgs = {
			wallet: userNorm,
			metricKind: UC_METRIC.USER_LIKE,
			targetKind,
			issuedParentId,
			delta: 1,
		}
		const cardCalldata = liked
			? buildRecordUserCumulativeStatCalldata(statArgs)
			: buildBurnUserCumulativeStatCalldata(statArgs)
		const selector = liked ? RECORD_USER_CUMULATIVE_STAT_SELECTOR : BURN_USER_CUMULATIVE_STAT_SELECTOR
		const routeErr = await assertAdminStatsRoutesIssuedNftSelector(
			cardNorm,
			selector,
			liked ? 'recordUserCumulativeStat' : 'burnUserCumulativeStatByGateway',
		)
		if (routeErr) return { success: false, error: routeErr }

		return {
			success: true,
			preChecked: {
				cardAddress: cardNorm,
				factoryCallData: encodeGatewayInvokeCardFactoryCalldata(cardNorm, cardCalldata),
				liked,
				targetKind,
				issuedParentId: String(issuedParentId),
			},
		}
	} catch (e: unknown) {
		const err = e as { message?: string }
		return { success: false, error: err?.message ?? String(e) }
	}
}
