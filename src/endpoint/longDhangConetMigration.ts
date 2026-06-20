import { ethers } from 'ethers'
import Colors from 'colors/safe'
import { inspect } from 'node:util'
import fs from 'node:fs'
import { resolve } from 'node:path'
import { logger } from '../logger'
import {
	BASE_MAINNET_CHAIN_ID,
	BEAMIO_AA_FACTORY,
	BEAMIO_INDEXER_DIAMOND,
	CONET_AA_FACTORY,
	CONET_BEAMIO_USER_CARD_ADMIN_GATEWAY_LIB,
	CONET_BEAMIO_USER_CARD_FACTORY_EXECUTE_LIB,
	CONET_BEAMIO_USER_CARD_FAUCET_GATEWAY_LIB,
	CONET_BEAMIO_USER_CARD_FORMATTING_LIB,
	CONET_BEAMIO_USER_CARD_GATEWAY_MINT_LIB,
	CONET_BEAMIO_USER_CARD_GOVERNANCE_LIB,
	CONET_BEAMIO_USER_CARD_ISSUED_NFT_GATEWAY_LIB,
	CONET_BEAMIO_USER_CARD_MODULE_ROUTER_LIB,
	CONET_BEAMIO_USER_CARD_REDEEM_GATEWAY_LIB,
	CONET_BEAMIO_USER_CARD_REFERRER_LIB,
	CONET_BEAMIO_USER_CARD_TRANSFER_LIB,
	CONET_BEAMIO_USER_CARD_UPDATE_LIB,
	CONET_BEAMIO_USER_CARD_VIEWS_LIB,
	CONET_CARD_FACTORY,
	CONET_MAINNET_CHAIN_ID,
	CONET_RPC_URL,
} from '../chainAddresses'
import { resolveBeamioBaseHttpRpcUrl } from '../util'
import { Settle_ContractPool } from '../MemberCard'
import { createBeamioCardWithFactoryReturningHash } from '../CCSA'
import BeamioFactoryPaymasterArtifact from '../ABI/BeamioUserCardFactoryPaymaster.json'
import {
	getCardByAddress,
	getPosTerminalCardBindingRow,
	listDistinctCardMemberTopupMembers,
	listPosTerminalCardBindingsByCard,
	registerCardToDb,
	upsertPosTerminalAdminCardBinding,
} from '../db'

const BeamioFactoryPaymasterABI = (
	Array.isArray(BeamioFactoryPaymasterArtifact)
		? BeamioFactoryPaymasterArtifact
		: (BeamioFactoryPaymasterArtifact as { abi?: unknown[] }).abi ?? []
) as ethers.InterfaceAbi

export const LONGDHANG_OLD_BASE_CARD = '0x30d80cD71Fd1FFD346737b387dA11C7412363EFF'
export const LONGDHANG_OLD_CARD_OWNER = '0xA2d21FBd33F7D754D8d7A53fe2B4e5C39A008a1F'
/** Partner merchant EOA — migration test operator + included in Members snapshot when on Base card. */
export const LONGDHANG_MIGRATION_PARTNER_MERCHANT_EOA = '0xedb035E5D244a7bD987B950d3ac8d42afDe2D387'
/** EOAs allowed to open migration UI and sign create / start-migration (production owner + test operator). */
export const LONGDHANG_MIGRATION_AUTHORIZED_OWNER_EOAS = [
	LONGDHANG_OLD_CARD_OWNER,
	LONGDHANG_MIGRATION_PARTNER_MERCHANT_EOA,
] as const
export const LONGDHANG_MIGRATION_VERSION = 'longdhang-conet-migration-v1'
/** Base mainnet deploy block for LONGDHANG_OLD_BASE_CARD (~2026-05-25). Never scan from 0 — pruned RPC rejects ancient eth_getLogs. */
export const LONGDHANG_OLD_BASE_CARD_DEPLOY_BLOCK = 46_475_352

const DEFAULT_BASE_LOG_CHUNK = 15_000
const DEFAULT_MAX_RUN_ITEMS = 25
const CARD_METADATA_BASE_URI = 'https://beamio.app/api/metadata/0x'
const ZERO_INPUT_HASH = ethers.ZeroHash as `0x${string}`

const ERC1155_TRANSFER_ABI = new ethers.Interface([
	'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
	'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)',
	'function balanceOf(address account,uint256 id) view returns (uint256)',
	'function owner() view returns (address)',
	'function currency() view returns (uint8)',
	'function pointsUnitPriceInCurrencyE6() view returns (uint256)',
])

const BEAMIO_ACCOUNT_OWNER_ABI = [
	'function owner() view returns (address)',
	'function getOwner() view returns (address)',
	'function isValidSigner(address signer, bytes calldata data) view returns (bytes4)',
]

const AA_FACTORY_ABI = [
	'function beamioAccountOf(address creator) view returns (address)',
	'function primaryAccountOf(address creator) view returns (address)',
	'function getAddress(address creator,uint256 index) view returns (address)',
	'function createAccountFor(address creator) returns (address)',
]

const USER_CARD_ADMIN_ABI = [
	'function owner() view returns (address)',
	'function isAdmin(address who) view returns (bool)',
	'function balanceOf(address account,uint256 id) view returns (uint256)',
	'function mintPointsByAdmin(address user,uint256 points6)',
]

const ACTION_SYNC_TOKEN_ABI = [
	'function getTransactionActionId(bytes32 txId) view returns (uint256 actionId, bool exists)',
	'function syncTokenAction((bytes32 txId, bytes32 originalPaymentHash, uint256 chainId, bytes32 txCategory, string displayJson, uint64 timestamp, address payer, address payee, uint256 finalRequestAmountFiat6, uint256 finalRequestAmountUSDC6, bool isAAAccount, (address asset, uint256 amountE6, uint8 assetType, uint8 source, uint256 tokenId, uint8 itemCurrencyType, uint256 offsetInRequestCurrencyE6)[] route, (uint16 gasChainType, uint256 gasWei, uint256 gasUSDC6, uint256 serviceUSDC6, uint256 bServiceUSDC6, uint256 bServiceUnits6, address feePayer) fees, (uint256 requestAmountFiat6, uint256 requestAmountUSDC6, uint8 currencyFiat, uint256 discountAmountFiat6, uint16 discountRateBps, uint256 taxAmountFiat6, uint16 taxRateBps, string afterNotePayer, string afterNotePayee) meta, address operator, address[] operatorParentChain, address topAdmin, address subordinate) in_) returns (uint256 actionId)',
] as const

type SnapshotHolder = {
	eoa: string
	oldBaseAA: string
	balanceE6: string
	sourceHolder?: string
}

type SnapshotExcludedHolder = {
	holder: string
	balanceE6: string
	reason: string
}

export type LongDhangMigrationSnapshot = {
	version: string
	oldBaseCard: string
	oldBaseCardOwner: string
	baseChainId: number
	conetChainId: number
	baseRpcUrl: string
	baseFromBlock: number
	baseToBlock: number
	oldBaseAaFactory: string
	holderCount: number
	totalBalanceE6: string
	excludedCount: number
	holders: SnapshotHolder[]
	excluded: SnapshotExcludedHolder[]
	anomalies: SnapshotExcludedHolder[]
	snapshotHash: string
	migrationAdmin: string
	generatedAt: string
}

type RunLongDhangMigrationOptions = {
	newCardAddress: string
	snapshotHash?: string
	limit?: number
}

type RunLongDhangMigrationRow = SnapshotHolder & {
	conetAA?: string
	status: 'minted' | 'skipped' | 'failed'
	reason?: string
	mintTx?: string
	indexerTx?: string
	indexerError?: string
	txId?: string
}

export type RunLongDhangMigrationResult = {
	success: boolean
	newCardAddress: string
	snapshotHash: string
	totalSnapshotRows: number
	processed: number
	minted: number
	skipped: number
	failed: number
	rows: RunLongDhangMigrationRow[]
	admins?: {
		total: number
		registered: number
		skipped: number
		failed: number
		rows: TerminalMigrationRow[]
	}
	/** @deprecated use admins */
	terminals?: {
		total: number
		registered: number
		skipped: number
		failed: number
		rows: TerminalMigrationRow[]
	}
	error?: string
}

export type LongDhangMigrationAutoResult = {
	success: boolean
	newCardAddress: string
	snapshotHash: string
	phases: Array<{ phase: string; ok: boolean; detail?: string }>
	members: { total: number; minted: number; skipped: number; failed: number }
	admins: { total: number; registered: number; skipped: number; failed: number }
	verify?: {
		success: boolean
		memberMatches: number
		memberTotal: number
		adminMatches: number
		adminTotal: number
	}
	error?: string
}

type TerminalMigrationRow = {
	posEoa: string
	metadata: string
	mintLimitE6: string
	status: 'registered' | 'skipped' | 'failed'
	txHash?: string
	reason?: string
}

function bigintJson(_key: string, value: unknown): unknown {
	return typeof value === 'bigint' ? value.toString() : value
}

function conetProvider(): ethers.JsonRpcProvider {
	return new ethers.JsonRpcProvider(CONET_RPC_URL, undefined, { batchMaxCount: 1 })
}

function baseProvider(): ethers.JsonRpcProvider {
	const url = process.env.LONGDHANG_BASE_RPC_URL?.trim() || resolveBeamioBaseHttpRpcUrl()
	return new ethers.JsonRpcProvider(url, undefined, { batchMaxCount: 1 })
}

function resolveLongDhangBaseFromBlock(): number {
	const raw = process.env.LONGDHANG_BASE_OLD_CARD_FROM_BLOCK?.trim()
	if (raw) {
		const n = Number(raw)
		if (Number.isFinite(n) && n >= 0) return Math.floor(n)
	}
	return LONGDHANG_OLD_BASE_CARD_DEPLOY_BLOCK
}

function normalizeAddress(raw: string): string {
	return ethers.getAddress(raw)
}

function migrationLogPrefix(): string {
	return '[LongDhangConetMigration]'
}

export function getLongDhangMigrationAdminAddress(): string {
	const env = process.env.LONGDHANG_MIGRATION_ADMIN_EOA?.trim()
	if (env && ethers.isAddress(env)) return ethers.getAddress(env)
	const sc0 = Settle_ContractPool[0]
	if (sc0?.walletConet?.address && ethers.isAddress(sc0.walletConet.address)) {
		return ethers.getAddress(sc0.walletConet.address)
	}
	return ethers.ZeroAddress
}

export function isLongDhangMigrationAuthorizedOwner(raw?: string | null): boolean {
	try {
		if (!raw?.trim()) return false
		const norm = normalizeAddress(raw).toLowerCase()
		return LONGDHANG_MIGRATION_AUTHORIZED_OWNER_EOAS.some((a) => normalizeAddress(a).toLowerCase() === norm)
	} catch {
		return false
	}
}

export function buildLongDhangMigrationAuthMessage(args: {
	action: 'create-card' | 'run-migration' | 'start-migration'
	ownerEoa: string
	snapshotHash: string
	newCardAddress?: string
}): string {
	const owner = normalizeAddress(args.ownerEoa)
	const snap = args.snapshotHash && ethers.isHexString(args.snapshotHash, 32) ? args.snapshotHash.toLowerCase() : ''
	const newCard =
		args.newCardAddress && ethers.isAddress(args.newCardAddress)
			? normalizeAddress(args.newCardAddress)
			: ethers.ZeroAddress
	return [
		'LongDhang CoNET Migration',
		`version:${LONGDHANG_MIGRATION_VERSION}`,
		`action:${args.action}`,
		`owner:${owner}`,
		`oldBaseCard:${normalizeAddress(LONGDHANG_OLD_BASE_CARD)}`,
		`newConetCard:${newCard}`,
		`snapshotHash:${snap}`,
		`conetChainId:${CONET_MAINNET_CHAIN_ID}`,
	].join('\n')
}

export function verifyLongDhangOwnerAuthorization(args: {
	action: 'create-card' | 'run-migration' | 'start-migration'
	ownerEoa: string
	snapshotHash: string
	signature: string
	newCardAddress?: string
}): { ok: true; signer: string } | { ok: false; error: string } {
	try {
		const owner = normalizeAddress(args.ownerEoa)
		if (!isLongDhangMigrationAuthorizedOwner(owner)) {
			return { ok: false, error: 'Only an authorized LongDhang migration operator can authorize this migration.' }
		}
		if (!ethers.isHexString(args.snapshotHash, 32)) {
			return { ok: false, error: 'Invalid snapshotHash.' }
		}
		const message = buildLongDhangMigrationAuthMessage(args)
		const signer = normalizeAddress(ethers.verifyMessage(message, args.signature))
		if (signer !== owner) {
			return { ok: false, error: 'Migration authorization signer is not the LongDhang owner.' }
		}
		return { ok: true, signer }
	} catch (e: any) {
		return { ok: false, error: e?.message ?? 'Invalid migration authorization.' }
	}
}

async function resolveOldBaseAaFactory(card: ethers.Contract, provider: ethers.Provider): Promise<string> {
	const tryRead = async (sig: string): Promise<string | null> => {
		try {
			const c = new ethers.Contract(await card.getAddress(), [sig], provider)
			const addr = String(await c.getFunction(sig.slice(9, sig.indexOf(')') + 1))())
			return ethers.isAddress(addr) ? ethers.getAddress(addr) : null
		} catch {
			return null
		}
	}
	const fromUnderscore = await tryRead('function _aaFactory() view returns (address)')
	if (fromUnderscore) return fromUnderscore
	const fromPlain = await tryRead('function aaFactory() view returns (address)')
	if (fromPlain) return fromPlain
	return ethers.getAddress(BEAMIO_AA_FACTORY)
}

async function resolveBeamioAccountOwner(holder: string, provider: ethers.Provider): Promise<string | null> {
	const account = new ethers.Contract(holder, BEAMIO_ACCOUNT_OWNER_ABI, provider)
	for (const fn of ['owner', 'getOwner']) {
		try {
			const owner = String(await account.getFunction(fn)())
			if (ethers.isAddress(owner)) return ethers.getAddress(owner)
		} catch {
			/* try next */
		}
	}
	return null
}

async function aaFactoryMatchesHolder(
	factoryAddress: string,
	eoa: string,
	holder: string,
	provider: ethers.Provider
): Promise<boolean> {
	const aaFactory = new ethers.Contract(factoryAddress, AA_FACTORY_ABI, provider)
	const holderNorm = normalizeAddress(holder)
	for (const fn of ['beamioAccountOf', 'primaryAccountOf']) {
		try {
			const addr = String(await aaFactory.getFunction(fn)(eoa))
			if (ethers.isAddress(addr) && ethers.getAddress(addr) === holderNorm) return true
		} catch {
			/* try next */
		}
	}
	try {
		const predicted = String(await aaFactory.getFunction('getAddress')(eoa, 0n))
		return ethers.isAddress(predicted) && ethers.getAddress(predicted) === holderNorm
	} catch {
		return false
	}
}

async function resolveBaseAaForEoa(
	factoryAddress: string,
	eoa: string,
	provider: ethers.Provider
): Promise<string> {
	const aaFactory = new ethers.Contract(factoryAddress, AA_FACTORY_ABI, provider)
	const eoaNorm = normalizeAddress(eoa)
	for (const fn of ['beamioAccountOf', 'primaryAccountOf']) {
		try {
			const addr = String(await aaFactory.getFunction(fn)(eoaNorm))
			if (ethers.isAddress(addr) && ethers.getAddress(addr) !== ethers.ZeroAddress) {
				return ethers.getAddress(addr)
			}
		} catch {
			/* try next */
		}
	}
	const predicted = String(await aaFactory.getFunction('getAddress')(eoaNorm, 0n))
	if (!ethers.isAddress(predicted)) throw new Error(`AA factory returned invalid address for ${eoaNorm}`)
	return ethers.getAddress(predicted)
}

function metadataBaseDir(): string {
	return resolve(process.env.METADATA_BASE ?? '/home/peter/.data/metadata')
}

function metadataFilePathForCard0(cardAddress: string): { dir: string; path: string; filename: string } {
	const dir = metadataBaseDir()
	const filename = `0x${ethers.getAddress(cardAddress).slice(2).toLowerCase()}0.json`
	return { dir, path: resolve(dir, filename), filename }
}

async function fetchOldCardMetadataFromApi(): Promise<Record<string, unknown> | null> {
	const token0 = '0'.repeat(64)
	const url = `${CARD_METADATA_BASE_URI}${ethers.getAddress(LONGDHANG_OLD_BASE_CARD).slice(2).toLowerCase()}${token0}.json`
	try {
		const res = await fetch(url)
		if (!res.ok) return null
		const data = await res.json()
		if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>
	} catch {
		/* network metadata is optional */
	}
	return null
}

function normalizeOldCardMetadataForNewCard(raw: Record<string, unknown> | null): {
	fileMetadata: Record<string, unknown>
	shareTokenMetadata: Record<string, unknown>
	tiers?: Array<Record<string, unknown>>
	upgradeType?: 0 | 1 | 2
	transferWhitelistEnabled?: boolean
} {
	const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {}
	const shareRaw = base.shareTokenMetadata
	const shareTokenMetadata =
		shareRaw && typeof shareRaw === 'object' && !Array.isArray(shareRaw)
			? { ...(shareRaw as Record<string, unknown>) }
			: {}
	if (!shareTokenMetadata.name && typeof base.name === 'string') shareTokenMetadata.name = base.name
	if (!shareTokenMetadata.description && typeof base.description === 'string') {
		shareTokenMetadata.description = base.description
	}
	if (!shareTokenMetadata.image && typeof base.image === 'string') shareTokenMetadata.image = base.image
	if (!shareTokenMetadata.name) shareTokenMetadata.name = 'LongDhang'
	const tiers = Array.isArray(base.tiers) ? (base.tiers as Array<Record<string, unknown>>) : undefined
	const upgradeRaw = Number(base.upgradeType)
	const upgradeType = upgradeRaw === 0 || upgradeRaw === 1 || upgradeRaw === 2 ? (upgradeRaw as 0 | 1 | 2) : undefined
	const transferWhitelistEnabled =
		typeof base.transferWhitelistEnabled === 'boolean' ? base.transferWhitelistEnabled : undefined
	const fileMetadata = {
		...base,
		name: typeof base.name === 'string' && base.name.trim() ? base.name : shareTokenMetadata.name,
		...(typeof base.description === 'string' && base.description.trim()
			? { description: base.description }
			: typeof shareTokenMetadata.description === 'string'
				? { description: shareTokenMetadata.description }
				: {}),
		...(typeof base.image === 'string' && base.image.trim()
			? { image: base.image }
			: typeof shareTokenMetadata.image === 'string'
				? { image: shareTokenMetadata.image }
				: {}),
		shareTokenMetadata,
		...(tiers && tiers.length > 0 && { tiers }),
		...(upgradeType != null && { upgradeType }),
		...(typeof transferWhitelistEnabled === 'boolean' && { transferWhitelistEnabled }),
	}
	return { fileMetadata, shareTokenMetadata, tiers, upgradeType, transferWhitelistEnabled }
}

async function copyLongDhangOldCardMetadataToNewCard(args: {
	newCardAddress: string
	cardOwner: string
	currency: string
	priceInCurrencyE6: string
	txHash: string
}): Promise<void> {
	const dbRow = await getCardByAddress(LONGDHANG_OLD_BASE_CARD).catch(() => null)
	const oldMetadata =
		dbRow?.metadata && typeof dbRow.metadata === 'object'
			? dbRow.metadata
			: await fetchOldCardMetadataFromApi()
	const normalized = normalizeOldCardMetadataForNewCard(oldMetadata)
	const { dir, path, filename } = metadataFilePathForCard0(args.newCardAddress)
	if (!path.startsWith(dir + '/') && path !== dir) throw new Error('Invalid metadata path')
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(path, JSON.stringify(normalized.fileMetadata, null, 2), 'utf-8')
	logger(Colors.green(`${migrationLogPrefix()} copied old card metadata to ${filename}`))
	await registerCardToDb({
		cardAddress: args.newCardAddress,
		cardOwner: args.cardOwner,
		currency: args.currency,
		priceInCurrencyE6: args.priceInCurrencyE6,
		uri: CARD_METADATA_BASE_URI,
		shareTokenMetadata: normalized.shareTokenMetadata as Parameters<typeof registerCardToDb>[0]['shareTokenMetadata'],
		...(normalized.tiers && normalized.tiers.length > 0 && {
			tiers: normalized.tiers as Parameters<typeof registerCardToDb>[0]['tiers'],
		}),
		...(normalized.upgradeType != null && { upgradeType: normalized.upgradeType }),
		...(typeof normalized.transferWhitelistEnabled === 'boolean' && {
			transferWhitelistEnabled: normalized.transferWhitelistEnabled,
		}),
		txHash: args.txHash,
	})
}

const adminManagerIface = new ethers.Interface([
	'function adminManager(address to, bool admin, uint256 newThreshold, string metadata)',
	'function adminManager(address to, bool admin, uint256 newThreshold, string metadata, uint256 mintLimit)',
])

async function collectLongDhangSubAdmins(provider: ethers.Provider): Promise<Array<{
	posEoa: string
	metadata: string
	mintLimitE6: string
}>> {
	const out = new Map<string, { posEoa: string; metadata: string; mintLimitE6: string }>()
	const ownerNorm = normalizeAddress(LONGDHANG_OLD_CARD_OWNER).toLowerCase()
	const dbRows = await listPosTerminalCardBindingsByCard(LONGDHANG_OLD_BASE_CARD)
	for (const row of dbRows) {
		if (!ethers.isAddress(row.posEoa)) continue
		const posNorm = ethers.getAddress(row.posEoa)
		if (posNorm.toLowerCase() === ownerNorm) continue
		const metadataObj =
			row.terminalMetadata && typeof row.terminalMetadata === 'object' && !Array.isArray(row.terminalMetadata)
				? (row.terminalMetadata as Record<string, unknown>)
				: { source: 'longdhangConetMigration', role: 'sub-admin' }
		out.set(posNorm.toLowerCase(), {
			posEoa: posNorm,
			metadata: JSON.stringify({ ...metadataObj, migratedFromCard: ethers.getAddress(LONGDHANG_OLD_BASE_CARD) }),
			mintLimitE6: '0',
		})
	}
	const card = new ethers.Contract(
		LONGDHANG_OLD_BASE_CARD,
		[
			'function getAdminListWithMetadata() view returns (address[] admins, string[] metadatas, address[] parents)',
			'function adminMintLimit(address admin) view returns (uint256)',
		],
		provider
	)
	try {
		const [admins, metadatas] = (await card.getAdminListWithMetadata()) as [string[], string[], string[]]
		for (let i = 0; i < admins.length; i++) {
			const pos = admins[i]
			if (!pos || !ethers.isAddress(pos)) continue
			const posNorm = ethers.getAddress(pos)
			if (posNorm.toLowerCase() === ownerNorm) continue
			const metaRaw = typeof metadatas[i] === 'string' && metadatas[i].trim() ? metadatas[i].trim() : '{}'
			let metaObj: unknown = null
			try {
				metaObj = JSON.parse(metaRaw)
			} catch {
				metaObj = { rawMetadata: metaRaw }
			}
			let limit = 0n
			try {
				limit = BigInt(await card.adminMintLimit(posNorm))
			} catch {
				limit = 0n
			}
			const merged =
				metaObj && typeof metaObj === 'object' && !Array.isArray(metaObj)
					? { ...(metaObj as Record<string, unknown>), migratedFromCard: ethers.getAddress(LONGDHANG_OLD_BASE_CARD) }
					: { source: 'longdhangConetMigration', role: 'sub-admin', migratedFromCard: ethers.getAddress(LONGDHANG_OLD_BASE_CARD) }
			out.set(posNorm.toLowerCase(), {
				posEoa: posNorm,
				metadata: JSON.stringify(merged),
				mintLimitE6: limit > 0n ? limit.toString() : (out.get(posNorm.toLowerCase())?.mintLimitE6 ?? '0'),
			})
		}
	} catch (e: any) {
		logger(Colors.yellow(`${migrationLogPrefix()} getAdminListWithMetadata failed: ${e?.message ?? e}`))
	}
	return [...out.values()].sort((a, b) => a.posEoa.localeCompare(b.posEoa))
}

/** @deprecated use collectLongDhangSubAdmins */
async function collectLongDhangPaymentTerminals(provider: ethers.Provider) {
	return collectLongDhangSubAdmins(provider)
}

function stableSnapshotHash(payload: Omit<LongDhangMigrationSnapshot, 'snapshotHash' | 'generatedAt' | 'migrationAdmin'>): string {
	// Hash only migration payload — exclude scan window (baseFromBlock/baseToBlock/baseRpcUrl) so
	// preview → create-card → addAdmin → executeAuto does not drift when Base head advances.
	const stable = {
		version: payload.version,
		oldBaseCard: normalizeAddress(payload.oldBaseCard),
		oldBaseCardOwner: normalizeAddress(payload.oldBaseCardOwner),
		baseChainId: payload.baseChainId,
		conetChainId: payload.conetChainId,
		oldBaseAaFactory: normalizeAddress(payload.oldBaseAaFactory),
		totalBalanceE6: payload.totalBalanceE6,
		holders: [...payload.holders]
			.sort((a, b) => a.eoa.localeCompare(b.eoa))
			.map((h) => ({
				eoa: normalizeAddress(h.eoa),
				oldBaseAA: normalizeAddress(h.oldBaseAA),
				balanceE6: h.balanceE6,
			})),
	}
	return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(stable)))
}

async function collectToken0HoldersFromTransfers(
	provider: ethers.JsonRpcProvider,
	cardAddress: string,
	fromBlock: number,
	toBlock: number
): Promise<Map<string, bigint>> {
	const balances = new Map<string, bigint>()
	const topicSingle = ERC1155_TRANSFER_ABI.getEvent('TransferSingle')!.topicHash
	const topicBatch = ERC1155_TRANSFER_ABI.getEvent('TransferBatch')!.topicHash
	const chunk = Math.max(1_000, Number(process.env.LONGDHANG_BASE_LOG_CHUNK ?? DEFAULT_BASE_LOG_CHUNK))
	for (let start = fromBlock; start <= toBlock; start += chunk) {
		const end = Math.min(toBlock, start + chunk - 1)
		let logs: ethers.Log[]
		try {
			logs = await provider.getLogs({
				address: cardAddress,
				fromBlock: start,
				toBlock: end,
				topics: [[topicSingle, topicBatch]],
			})
		} catch (e: any) {
			const msg = String(e?.error?.message ?? e?.message ?? e)
			if (/pruned history|pruned/i.test(msg)) {
				throw new Error(
					`Base RPC cannot serve eth_getLogs for blocks ${start}–${end} (pruned history). ` +
						`Set LONGDHANG_BASE_OLD_CARD_FROM_BLOCK to the card deploy block (default ${LONGDHANG_OLD_BASE_CARD_DEPLOY_BLOCK}) ` +
						`or LONGDHANG_BASE_RPC_URL to a full/archive Base node.`,
				)
			}
			throw e
		}
		for (const log of logs) {
			try {
				const parsed = ERC1155_TRANSFER_ABI.parseLog(log)
				if (!parsed) continue
				if (parsed.name === 'TransferSingle') {
					const from = ethers.getAddress(parsed.args[1])
					const to = ethers.getAddress(parsed.args[2])
					const id = BigInt(parsed.args[3])
					const value = BigInt(parsed.args[4])
					if (id !== 0n || value <= 0n) continue
					if (from !== ethers.ZeroAddress) balances.set(from, (balances.get(from) ?? 0n) - value)
					if (to !== ethers.ZeroAddress) balances.set(to, (balances.get(to) ?? 0n) + value)
				} else if (parsed.name === 'TransferBatch') {
					const from = ethers.getAddress(parsed.args[1])
					const to = ethers.getAddress(parsed.args[2])
					const ids = parsed.args[3] as bigint[]
					const values = parsed.args[4] as bigint[]
					for (let i = 0; i < ids.length; i++) {
						const id = BigInt(ids[i] ?? 0n)
						const value = BigInt(values[i] ?? 0n)
						if (id !== 0n || value <= 0n) continue
						if (from !== ethers.ZeroAddress) balances.set(from, (balances.get(from) ?? 0n) - value)
						if (to !== ethers.ZeroAddress) balances.set(to, (balances.get(to) ?? 0n) + value)
					}
				}
			} catch (e: any) {
				logger(Colors.yellow(`${migrationLogPrefix()} failed to parse transfer log: ${e?.message ?? e}`))
			}
		}
	}
	for (const [addr, bal] of [...balances.entries()]) {
		if (bal <= 0n) balances.delete(addr)
	}
	return balances
}

let snapshotCache: { at: number; value: LongDhangMigrationSnapshot } | null = null
const snapshotByHashCache = new Map<string, LongDhangMigrationSnapshot>()
const SNAPSHOT_BY_HASH_TTL_MS = 2 * 60 * 60 * 1000

function rememberSnapshotByHash(snapshot: LongDhangMigrationSnapshot): void {
	snapshotByHashCache.set(snapshot.snapshotHash.toLowerCase(), snapshot)
	const cutoff = Date.now() - SNAPSHOT_BY_HASH_TTL_MS
	for (const [hash, snap] of snapshotByHashCache) {
		if (Date.parse(snap.generatedAt) < cutoff) snapshotByHashCache.delete(hash)
	}
}

async function resolveLongDhangMigrationSnapshot(options: {
	requestedHash?: string
	force?: boolean
}): Promise<LongDhangMigrationSnapshot> {
	const requested = options.requestedHash?.trim().toLowerCase()
	if (requested && ethers.isHexString(requested, 32)) {
		const cached = snapshotByHashCache.get(requested)
		if (cached) return cached
	}
	const snapshot = await previewLongDhangConetMigrationSnapshot({ force: options.force ?? Boolean(requested) })
	if (requested && snapshot.snapshotHash.toLowerCase() !== requested) {
		throw new Error(
			`Snapshot hash mismatch. Current=${snapshot.snapshotHash}, requested=${options.requestedHash}. ` +
				`Members or Base balances changed since preview — refresh and Start Migration again.`
		)
	}
	return snapshot
}

async function upsertMemberHolderFromBaseBalance(args: {
	oldCard: ethers.Contract
	aaFactory: string
	provider: ethers.Provider
	eoa: string
	preferredAa?: string
	holderByEoa: Map<string, SnapshotHolder>
	excluded: SnapshotExcludedHolder[]
}): Promise<void> {
	const eoa = normalizeAddress(args.eoa)
	let oldBaseAA = ''
	if (args.preferredAa && ethers.isAddress(args.preferredAa) && ethers.getAddress(args.preferredAa) !== ethers.ZeroAddress) {
		oldBaseAA = ethers.getAddress(args.preferredAa)
	} else {
		oldBaseAA = await resolveBaseAaForEoa(args.aaFactory, eoa, args.provider)
	}
	const balance = BigInt(await args.oldCard.balanceOf(oldBaseAA, 0n).catch(() => 0n))
	if (balance <= 0n) {
		args.excluded.push({ holder: eoa, balanceE6: '0', reason: 'Member has zero tokenId=0 balance on Base card.' })
		return
	}
	const key = eoa.toLowerCase()
	const existing = args.holderByEoa.get(key)
	if (!existing || BigInt(existing.balanceE6) < balance) {
		args.holderByEoa.set(key, {
			eoa,
			oldBaseAA,
			balanceE6: balance.toString(),
			sourceHolder: 'members-directory',
		})
	}
}

async function buildHoldersFromMembersDirectory(args: {
	oldCard: ethers.Contract
	aaFactory: string
	provider: ethers.Provider
}): Promise<{ holders: SnapshotHolder[]; excluded: SnapshotExcludedHolder[]; anomalies: SnapshotExcludedHolder[] }> {
	const holderByEoa = new Map<string, SnapshotHolder>()
	const excluded: SnapshotExcludedHolder[] = []
	const anomalies: SnapshotExcludedHolder[] = []
	const pageSize = 2000
	let offset = 0
	let total = 0
	do {
		const page = await listDistinctCardMemberTopupMembers(LONGDHANG_OLD_BASE_CARD, { limit: pageSize, offset })
		total = page.total
		for (const m of page.items) {
			if (!m.memberEoa || !ethers.isAddress(m.memberEoa)) continue
			try {
				await upsertMemberHolderFromBaseBalance({
					oldCard: args.oldCard,
					aaFactory: args.aaFactory,
					provider: args.provider,
					eoa: m.memberEoa,
					preferredAa: m.memberAa,
					holderByEoa,
					excluded,
				})
			} catch (e: any) {
				anomalies.push({
					holder: m.memberEoa,
					balanceE6: '0',
					reason: e?.message ?? String(e),
				})
			}
		}
		if (page.items.length < pageSize) break
		offset += pageSize
	} while (offset < total)

	// Ensure partner merchant (e.g. BeamioDemo100) is included when they hold Base token #0.
	try {
		await upsertMemberHolderFromBaseBalance({
			oldCard: args.oldCard,
			aaFactory: args.aaFactory,
			provider: args.provider,
			eoa: LONGDHANG_MIGRATION_PARTNER_MERCHANT_EOA,
			holderByEoa,
			excluded,
		})
	} catch (e: any) {
		anomalies.push({
			holder: LONGDHANG_MIGRATION_PARTNER_MERCHANT_EOA,
			balanceE6: '0',
			reason: e?.message ?? String(e),
		})
	}

	return {
		holders: [...holderByEoa.values()].sort((a, b) => a.eoa.localeCompare(b.eoa)),
		excluded,
		anomalies,
	}
}

export async function previewLongDhangConetMigrationSnapshot(
	options: { force?: boolean } = {}
): Promise<LongDhangMigrationSnapshot> {
	const cacheTtlMs = Number(process.env.LONGDHANG_SNAPSHOT_CACHE_TTL_MS ?? 60_000)
	if (!options.force && snapshotCache && Date.now() - snapshotCache.at < cacheTtlMs) return snapshotCache.value

	const provider = baseProvider()
	const oldCard = new ethers.Contract(LONGDHANG_OLD_BASE_CARD, ERC1155_TRANSFER_ABI, provider)
	const latest = await provider.getBlockNumber()
	const fromBlock = resolveLongDhangBaseFromBlock()
	const toBlock = Number(process.env.LONGDHANG_BASE_OLD_CARD_TO_BLOCK ?? latest)
	const ownerOnChain = normalizeAddress(await oldCard.owner())
	if (ownerOnChain !== normalizeAddress(LONGDHANG_OLD_CARD_OWNER)) {
		throw new Error(`Unexpected LongDhang old card owner: ${ownerOnChain}`)
	}
	const aaFactory = await resolveOldBaseAaFactory(oldCard, provider)
	const useMembersDirectory = String(process.env.LONGDHANG_SNAPSHOT_USE_MEMBERS ?? 'true').toLowerCase() !== 'false'
	let holders: SnapshotHolder[] = []
	let excluded: SnapshotExcludedHolder[] = []
	let anomalies: SnapshotExcludedHolder[] = []

	if (useMembersDirectory) {
		const built = await buildHoldersFromMembersDirectory({ oldCard, aaFactory, provider })
		holders = built.holders
		excluded = built.excluded
		anomalies = built.anomalies
	} else {
		const transferBalances = await collectToken0HoldersFromTransfers(provider, LONGDHANG_OLD_BASE_CARD, fromBlock, toBlock)
		const holderByEoa = new Map<string, SnapshotHolder>()
		for (const [holder, eventBalance] of [...transferBalances.entries()].sort(([a], [b]) => a.localeCompare(b))) {
			let currentBalance = 0n
			try {
				currentBalance = BigInt(await oldCard.balanceOf(holder, 0n))
			} catch (e: any) {
				anomalies.push({ holder, balanceE6: eventBalance.toString(), reason: `balanceOf failed: ${e?.message ?? e}` })
				continue
			}
			if (currentBalance <= 0n) continue
			if (currentBalance !== eventBalance) {
				anomalies.push({
					holder,
					balanceE6: currentBalance.toString(),
					reason: `event replay balance ${eventBalance.toString()} differs from balanceOf`,
				})
			}
			const code = await provider.getCode(holder)
			if (!code || code === '0x') {
				let oldBaseAA = ''
				try {
					oldBaseAA = await resolveBaseAaForEoa(aaFactory, holder, provider)
				} catch (e: any) {
					excluded.push({
						holder,
						balanceE6: currentBalance.toString(),
						reason: `direct EOA holder; could not resolve Base AA: ${e?.message ?? e}`,
					})
					continue
				}
				const aaBalance = BigInt(await oldCard.balanceOf(oldBaseAA, 0n).catch(() => 0n))
				if (aaBalance <= 0n) {
					excluded.push({
						holder,
						balanceE6: currentBalance.toString(),
						reason: `direct EOA holder; Base AA ${oldBaseAA} has zero tokenId=0 balance`,
					})
					continue
				}
				holderByEoa.set(holder.toLowerCase(), {
					eoa: ethers.getAddress(holder),
					oldBaseAA,
					balanceE6: aaBalance.toString(),
					sourceHolder: holder,
				})
				continue
			}
			const eoa = await resolveBeamioAccountOwner(holder, provider)
			if (!eoa) {
				excluded.push({ holder, balanceE6: currentBalance.toString(), reason: 'holder is not a readable BeamioAccount' })
				continue
			}
			const matches = await aaFactoryMatchesHolder(aaFactory, eoa, holder, provider)
			if (!matches) {
				excluded.push({ holder, balanceE6: currentBalance.toString(), reason: 'holder is not the EOA primary/index-0 AA' })
				continue
			}
			const eoaKey = eoa.toLowerCase()
			const existing = holderByEoa.get(eoaKey)
			if (!existing || BigInt(existing.balanceE6) < currentBalance) {
				holderByEoa.set(eoaKey, { eoa, oldBaseAA: holder, balanceE6: currentBalance.toString(), sourceHolder: holder })
			}
		}
		holders = [...holderByEoa.values()].sort((a, b) => a.eoa.localeCompare(b.eoa))
	}
	let total = 0n
	for (const row of holders) total += BigInt(row.balanceE6)

	const basePayload = {
		version: LONGDHANG_MIGRATION_VERSION,
		oldBaseCard: normalizeAddress(LONGDHANG_OLD_BASE_CARD),
		oldBaseCardOwner: normalizeAddress(LONGDHANG_OLD_CARD_OWNER),
		baseChainId: BASE_MAINNET_CHAIN_ID,
		conetChainId: CONET_MAINNET_CHAIN_ID,
		baseRpcUrl: resolveBeamioBaseHttpRpcUrl(),
		baseFromBlock: fromBlock,
		baseToBlock: toBlock,
		oldBaseAaFactory: aaFactory,
		holderCount: holders.length,
		totalBalanceE6: total.toString(),
		excludedCount: excluded.length,
		holders,
		excluded,
		anomalies,
	}
	const snapshot: LongDhangMigrationSnapshot = {
		...basePayload,
		snapshotHash: stableSnapshotHash(basePayload),
		migrationAdmin: getLongDhangMigrationAdminAddress(),
		generatedAt: new Date().toISOString(),
	}
	snapshotCache = { at: Date.now(), value: snapshot }
	rememberSnapshotByHash(snapshot)
	return snapshot
}

function currencyEnumToSymbol(n: number): 'CAD' | 'USD' | 'JPY' | 'CNY' | 'USDC' | 'HKD' | 'EUR' | 'SGD' | 'TWD' {
	const symbols = ['CAD', 'USD', 'JPY', 'CNY', 'USDC', 'HKD', 'EUR', 'SGD', 'TWD'] as const
	return symbols[n] ?? 'CAD'
}

export async function createLongDhangConetMigrationCard(options?: {
	/** When set (and authorized), new CoNET card `owner()` is this EOA — required for test-operator dry runs. */
	cardOwnerEoa?: string
}): Promise<{
	success: true
	cardAddress: string
	txHash: string
	ownerEoa: string
	migrationAdmin: string
} | { success: false; error: string }> {
	const sc = Settle_ContractPool.shift()
	if (!sc) return { success: false, error: 'Settle_ContractPool is busy or not initialized.' }
	let cardOwner = normalizeAddress(LONGDHANG_OLD_CARD_OWNER)
	if (options?.cardOwnerEoa && ethers.isAddress(options.cardOwnerEoa)) {
		const candidate = normalizeAddress(options.cardOwnerEoa)
		if (!isLongDhangMigrationAuthorizedOwner(candidate)) {
			return { success: false, error: 'cardOwnerEoa is not an authorized migration operator.' }
		}
		cardOwner = candidate
	}
	try {
		const base = baseProvider()
		const oldCard = new ethers.Contract(LONGDHANG_OLD_BASE_CARD, ERC1155_TRANSFER_ABI, base)
		const currencyEnum = Number(await oldCard.currency().catch(() => 0n))
		const price = BigInt(await oldCard.pointsUnitPriceInCurrencyE6().catch(() => 1_000_000n))
		const currency = currencyEnumToSymbol(currencyEnum)
		const factory = new ethers.Contract(CONET_CARD_FACTORY, BeamioFactoryPaymasterABI, sc.walletConet)
		const result = await createBeamioCardWithFactoryReturningHash(
			factory,
			cardOwner,
			currency,
			price,
			{
				uri: CARD_METADATA_BASE_URI,
				contractName: 'LongDhang',
				upgradeType: 0,
				transferWhitelistEnabled: false,
				libraryAddresses: {
					BeamioUserCardAdminGatewayLib: CONET_BEAMIO_USER_CARD_ADMIN_GATEWAY_LIB,
					BeamioUserCardFaucetGatewayLib: CONET_BEAMIO_USER_CARD_FAUCET_GATEWAY_LIB,
					BeamioUserCardFormattingLib: CONET_BEAMIO_USER_CARD_FORMATTING_LIB,
					BeamioUserCardGatewayMintLib: CONET_BEAMIO_USER_CARD_GATEWAY_MINT_LIB,
					BeamioUserCardGovernanceLib: CONET_BEAMIO_USER_CARD_GOVERNANCE_LIB,
					BeamioUserCardIssuedNftGatewayLib: CONET_BEAMIO_USER_CARD_ISSUED_NFT_GATEWAY_LIB,
					BeamioUserCardModuleRouterLib: CONET_BEAMIO_USER_CARD_MODULE_ROUTER_LIB,
					BeamioUserCardRedeemGatewayLib: CONET_BEAMIO_USER_CARD_REDEEM_GATEWAY_LIB,
					BeamioUserCardReferrerLib: CONET_BEAMIO_USER_CARD_REFERRER_LIB,
					BeamioUserCardTransferLib: CONET_BEAMIO_USER_CARD_TRANSFER_LIB,
					BeamioUserCardUpdateLib: CONET_BEAMIO_USER_CARD_UPDATE_LIB,
					BeamioUserCardViewsLib: CONET_BEAMIO_USER_CARD_VIEWS_LIB,
				},
			}
		)
		await copyLongDhangOldCardMetadataToNewCard({
			newCardAddress: result.cardAddress,
			cardOwner,
			currency,
			priceInCurrencyE6: price.toString(),
			txHash: result.hash,
		})
		return {
			success: true,
			cardAddress: result.cardAddress,
			txHash: result.hash,
			ownerEoa: cardOwner,
			migrationAdmin: normalizeAddress(sc.walletConet.address),
		}
	} catch (e: any) {
		logger(Colors.red(`${migrationLogPrefix()} create card failed: ${e?.message ?? e}`))
		return { success: false, error: e?.message ?? String(e) }
	} finally {
		Settle_ContractPool.unshift(sc)
	}
}

function executeForAdminDomain(verifyingContract: string) {
	return {
		name: 'BeamioUserCardFactory',
		version: '1',
		chainId: CONET_MAINNET_CHAIN_ID,
		verifyingContract: normalizeAddress(verifyingContract),
	}
}

async function signExecuteForAdminWithWallet(
	wallet: ethers.Wallet,
	cardAddress: string,
	data: string,
	deadline: bigint,
	nonce: string
): Promise<string> {
	const types = {
		ExecuteForAdmin: [
			{ name: 'cardAddress', type: 'address' },
			{ name: 'dataHash', type: 'bytes32' },
			{ name: 'deadline', type: 'uint256' },
			{ name: 'nonce', type: 'bytes32' },
		],
	}
	return wallet.signTypedData(executeForAdminDomain(CONET_CARD_FACTORY), types, {
		cardAddress: normalizeAddress(cardAddress),
		dataHash: ethers.keccak256(data),
		deadline,
		nonce,
	})
}

async function ensureConetAaForEoaWithWallet(
	eoa: string,
	wallet: ethers.Wallet
): Promise<{ aa: string; createdTx?: string }> {
	const factory = new ethers.Contract(CONET_AA_FACTORY, AA_FACTORY_ABI, wallet)
	const eoaNorm = normalizeAddress(eoa)
	let aa = ''
	for (const fn of ['beamioAccountOf', 'primaryAccountOf']) {
		try {
			const raw = String(await factory.getFunction(fn)(eoaNorm))
			if (ethers.isAddress(raw) && ethers.getAddress(raw) !== ethers.ZeroAddress) {
				aa = ethers.getAddress(raw)
				break
			}
		} catch {
			/* try next */
		}
	}
	if (aa) {
		const code = await wallet.provider!.getCode(aa)
		if (code && code !== '0x') return { aa }
	}
	// CoNET AA CREATE2 deploy needs ~2.8M gas; 1.8M OOG → LibDeployFailed() with empty code at predicted address.
	let gasLimit = 3_500_000n
	try {
		const estimated = await factory.createAccountFor.estimateGas(eoaNorm)
		gasLimit = (estimated * 125n) / 100n + 150_000n
		if (gasLimit < 3_000_000n) gasLimit = 3_000_000n
	} catch {
		/* keep conservative fallback */
	}
	const tx = await factory.createAccountFor(eoaNorm, { gasLimit })
	const receipt = await tx.wait()
	if (!receipt || Number(receipt.status ?? 0) !== 1) {
		throw new Error(
			`createAccountFor failed for ${eoaNorm} (CoNET AA deploy likely needs ≥3M gas; check LibDeployFailed / CREATE2 OOG)`
		)
	}
	const created = String(await factory.beamioAccountOf(eoaNorm))
	if (!ethers.isAddress(created) || ethers.getAddress(created) === ethers.ZeroAddress) {
		throw new Error(`AA factory did not register account for ${eoaNorm}`)
	}
	return { aa: ethers.getAddress(created), createdTx: tx.hash }
}

function migrationTxId(newCard: string, row: SnapshotHolder, snapshotHash: string): string {
	return ethers.solidityPackedKeccak256(
		['string', 'address', 'address', 'address', 'uint256', 'bytes32'],
		[LONGDHANG_MIGRATION_VERSION, normalizeAddress(newCard), normalizeAddress(row.eoa), normalizeAddress(row.oldBaseAA), BigInt(row.balanceE6), snapshotHash]
	)
}

async function syncMigrationIndexerRow(args: {
	indexer: ethers.Contract
	txId: string
	newCard: string
	row: SnapshotHolder
	conetAA: string
	mintTx: string
	snapshotHash: string
	operator: string
}): Promise<string | undefined> {
	const txId = args.txId as `0x${string}`
	try {
		const [, exists] = (await args.indexer.getTransactionActionId(txId)) as [bigint, boolean]
		if (exists) return undefined
	} catch {
		/* old read facet may not expose the helper; try sync and let duplicate revert if needed */
	}
	const amount = BigInt(args.row.balanceE6)
	const displayJson = JSON.stringify({
		title: 'LongDhang CoNET migration airdrop',
		source: 'longdhangConetMigration',
		migration: LONGDHANG_MIGRATION_VERSION,
		snapshotHash: args.snapshotHash,
		sourceCard: normalizeAddress(LONGDHANG_OLD_BASE_CARD),
		newConetCard: normalizeAddress(args.newCard),
		oldBaseAA: normalizeAddress(args.row.oldBaseAA),
		conetAA: normalizeAddress(args.conetAA),
		eoa: normalizeAddress(args.row.eoa),
		...(args.mintTx &&
			args.mintTx !== ethers.ZeroHash && { baseMintTxHash: args.mintTx }),
	})
	const input = {
		txId,
		originalPaymentHash: args.snapshotHash,
		chainId: CONET_MAINNET_CHAIN_ID,
		txCategory: ethers.keccak256(ethers.toUtf8Bytes('longdhangMigration:airdrop')),
		displayJson,
		timestamp: BigInt(Math.floor(Date.now() / 1000)),
		payer: normalizeAddress(args.row.eoa),
		payee: normalizeAddress(args.conetAA),
		finalRequestAmountFiat6: amount,
		finalRequestAmountUSDC6: 0n,
		isAAAccount: true,
		route: [
			{
				asset: normalizeAddress(args.newCard),
				amountE6: amount,
				assetType: 1,
				source: 1,
				tokenId: 0n,
				itemCurrencyType: 0,
				offsetInRequestCurrencyE6: amount,
			},
		],
		fees: {
			gasChainType: 0,
			gasWei: 0n,
			gasUSDC6: 0n,
			serviceUSDC6: 0n,
			bServiceUSDC6: 0n,
			bServiceUnits6: 0n,
			feePayer: ethers.ZeroAddress,
		},
		meta: {
			requestAmountFiat6: amount,
			requestAmountUSDC6: 0n,
			currencyFiat: 0,
			discountAmountFiat6: 0n,
			discountRateBps: 0,
			taxAmountFiat6: 0n,
			taxRateBps: 0,
			afterNotePayer: '',
			afterNotePayee: '',
		},
		operator: normalizeAddress(args.operator),
		operatorParentChain: [] as string[],
		topAdmin: normalizeAddress(args.operator),
		subordinate: ethers.ZeroAddress,
	}
	let gasLimit = 2_500_000n
	try {
		const estimated = await args.indexer.syncTokenAction.estimateGas(input)
		gasLimit = (estimated * 125n) / 100n + 200_000n
		if (gasLimit < 2_500_000n) gasLimit = 2_500_000n
	} catch {
		/* conservative fallback — 1M OOG observed on CoNET (~985k used) */
	}
	const tx = await args.indexer.syncTokenAction(input, { gasLimit })
	const receipt = await tx.wait()
	if (!receipt || Number(receipt.status ?? 0) !== 1) throw new Error(`syncTokenAction failed for ${txId}`)
	return tx.hash
}

/** Indexer 记账失败不得推翻已成功的链上 mint；返回 hash 或 undefined + 打日志。 */
async function trySyncMigrationIndexerRow(
	args: Parameters<typeof syncMigrationIndexerRow>[0]
): Promise<{ indexerTx?: string; indexerError?: string }> {
	try {
		const indexerTx = await syncMigrationIndexerRow(args)
		return { indexerTx }
	} catch (e: any) {
		const msg = e?.shortMessage ?? e?.message ?? String(e)
		logger(
			Colors.yellow(
				`${migrationLogPrefix()} indexer sync failed (mint may still succeed on-chain): ${msg}`
			)
		)
		return { indexerError: msg }
	}
}

async function copyLongDhangPaymentTerminalsToNewCard(args: {
	newCard: string
	snapshotTotalBalanceE6: string
	wallet: ethers.Wallet
	factory: ethers.Contract
	card: ethers.Contract
}): Promise<{ total: number; registered: number; skipped: number; failed: number; rows: TerminalMigrationRow[] }> {
	const base = baseProvider()
	const terminals = await collectLongDhangPaymentTerminals(base)
	const rows: TerminalMigrationRow[] = []
	let registered = 0
	let skipped = 0
	let failed = 0
	const fallbackLimit = BigInt(args.snapshotTotalBalanceE6 || '0')
	for (const t of terminals) {
		const row: TerminalMigrationRow = {
			posEoa: t.posEoa,
			metadata: t.metadata,
			mintLimitE6: t.mintLimitE6,
			status: 'failed',
		}
		rows.push(row)
		try {
			const alreadyAdmin = Boolean(await args.card.isAdmin(t.posEoa))
			if (alreadyAdmin) {
				await upsertPosTerminalAdminCardBinding({
					posEoa: t.posEoa,
					cardAddress: args.newCard,
					metadataJson: JSON.parse(t.metadata),
				})
				row.status = 'skipped'
				row.reason = 'Terminal already admin on new card.'
				skipped += 1
				continue
			}
			const oldLimit = BigInt(t.mintLimitE6 || '0')
			const mintLimit = oldLimit > 0n ? oldLimit : fallbackLimit
			row.mintLimitE6 = mintLimit.toString()
			const data = adminManagerIface.encodeFunctionData('adminManager(address,bool,uint256,string,uint256)', [
				t.posEoa,
				true,
				1n,
				t.metadata,
				mintLimit,
			])
			const deadline = BigInt(Math.floor(Date.now() / 1000) + 15 * 60)
			const nonce = ethers.hexlify(ethers.randomBytes(32))
			const signature = await signExecuteForAdminWithWallet(args.wallet, args.newCard, data, deadline, nonce)
			const tx = await args.factory.executeForAdmin(args.newCard, data, deadline, nonce, signature, { gasLimit: 1_500_000 })
			const receipt = await tx.wait()
			if (!receipt || Number(receipt.status ?? 0) !== 1) throw new Error(`terminal admin tx reverted for ${t.posEoa}`)
			await upsertPosTerminalAdminCardBinding({
				posEoa: t.posEoa,
				cardAddress: args.newCard,
				txHash: tx.hash,
				metadataJson: JSON.parse(t.metadata),
			})
			row.status = 'registered'
			row.txHash = tx.hash
			registered += 1
		} catch (e: any) {
			row.status = 'failed'
			row.reason = e?.message ?? String(e)
			failed += 1
			logger(Colors.yellow(`${migrationLogPrefix()} terminal migration failed: ${inspect(row, false, 3, true)}`))
		}
	}
	return { total: terminals.length, registered, skipped, failed, rows }
}

export async function runLongDhangConetMigrationBatch(
	options: RunLongDhangMigrationOptions
): Promise<RunLongDhangMigrationResult> {
	const newCard = normalizeAddress(options.newCardAddress)
	const snapshot = await resolveLongDhangMigrationSnapshot({ requestedHash: options.snapshotHash })
	const sc = Settle_ContractPool.shift()
	if (!sc) {
		return {
			success: false,
			newCardAddress: newCard,
			snapshotHash: snapshot.snapshotHash,
			totalSnapshotRows: snapshot.holders.length,
			processed: 0,
			minted: 0,
			skipped: 0,
			failed: 0,
			rows: [],
			terminals: { total: 0, registered: 0, skipped: 0, failed: 0, rows: [] },
			error: 'Settle_ContractPool is busy or not initialized.',
		}
	}
	const rows: RunLongDhangMigrationRow[] = []
	let minted = 0
	let skipped = 0
	let failed = 0
	try {
		const card = new ethers.Contract(newCard, USER_CARD_ADMIN_ABI, sc.walletConet)
		const owner = normalizeAddress(await card.owner())
		if (!isLongDhangMigrationAuthorizedOwner(owner)) {
			throw new Error(`New CoNET card owner is not an authorized migration operator: ${owner}`)
		}
		const adminAddr = normalizeAddress(sc.walletConet.address)
		const isAdmin = Boolean(await card.isAdmin(adminAddr))
		if (!isAdmin) throw new Error(`Migration admin ${adminAddr} is not authorized on ${newCard}.`)
		const factory = new ethers.Contract(CONET_CARD_FACTORY, BeamioFactoryPaymasterABI, sc.walletConet)
		const indexer = new ethers.Contract(BEAMIO_INDEXER_DIAMOND, ACTION_SYNC_TOKEN_ABI, sc.walletConet)
		const terminals = await copyLongDhangPaymentTerminalsToNewCard({
			newCard,
			snapshotTotalBalanceE6: snapshot.totalBalanceE6,
			wallet: sc.walletConet,
			factory,
			card,
		})
		const mintIface = new ethers.Interface(['function mintPointsByAdmin(address user,uint256 points6)'])
		const holderRows =
			options.limit != null && Number.isFinite(Number(options.limit))
				? snapshot.holders.slice(0, Math.max(1, Math.floor(Number(options.limit))))
				: snapshot.holders
		for (const row of holderRows) {
			const out: RunLongDhangMigrationRow = { ...row, status: 'failed' }
			rows.push(out)
			try {
				const { aa } = await ensureConetAaForEoaWithWallet(row.eoa, sc.walletConet)
				out.conetAA = aa
				const expected = BigInt(row.balanceE6)
				const current = BigInt(await card.balanceOf(aa, 0n))
				const txId = migrationTxId(newCard, row, snapshot.snapshotHash)
				out.txId = txId
				const indexerArgs = {
					indexer,
					txId,
					newCard,
					row,
					conetAA: aa,
					mintTx: out.mintTx ?? ethers.ZeroHash,
					snapshotHash: snapshot.snapshotHash,
					operator: adminAddr,
				}
				if (current >= expected) {
					const { indexerTx, indexerError } = await trySyncMigrationIndexerRow(indexerArgs)
					if (indexerTx) out.indexerTx = indexerTx
					if (indexerError) out.indexerError = indexerError
					out.status = 'skipped'
					out.reason = indexerError
						? 'CoNET AA already has the snapshot balance; indexer sync pending retry.'
						: 'CoNET AA already has the snapshot balance.'
					skipped += 1
					continue
				}
				const delta = expected - current
				const data = mintIface.encodeFunctionData('mintPointsByAdmin', [aa, delta])
				const deadline = BigInt(Math.floor(Date.now() / 1000) + 15 * 60)
				const nonce = ethers.hexlify(ethers.randomBytes(32))
				const signature = await signExecuteForAdminWithWallet(sc.walletConet, newCard, data, deadline, nonce)
				const tx = await factory.executeForAdmin(newCard, data, deadline, nonce, signature, { gasLimit: 2_500_000 })
				const receipt = await tx.wait()
				if (!receipt || Number(receipt.status ?? 0) !== 1) throw new Error(`executeForAdmin reverted for ${row.eoa}`)
				out.mintTx = tx.hash
				const { indexerTx, indexerError } = await trySyncMigrationIndexerRow({
					...indexerArgs,
					mintTx: tx.hash,
				})
				if (indexerTx) out.indexerTx = indexerTx
				if (indexerError) {
					out.indexerError = indexerError
					out.reason = `Mint ok (${tx.hash}); indexer sync failed: ${indexerError}`
				}
				out.status = 'minted'
				minted += 1
			} catch (e: any) {
				out.status = 'failed'
				out.reason = e?.message ?? String(e)
				failed += 1
				logger(Colors.yellow(`${migrationLogPrefix()} row failed: ${inspect(out, false, 3, true)}`))
			}
		}
		return {
			success: failed === 0 && terminals.failed === 0,
			newCardAddress: newCard,
			snapshotHash: snapshot.snapshotHash,
			totalSnapshotRows: snapshot.holders.length,
			processed: rows.length,
			minted,
			skipped,
			failed,
			rows,
			admins: terminals,
			terminals,
			...((failed > 0 || terminals.failed > 0) && {
				error: `${failed} member row(s), ${terminals.failed} sub-admin row(s) failed.`,
			}),
		}
	} finally {
		Settle_ContractPool.unshift(sc)
	}
}

export async function verifyLongDhangConetMigration(newCardAddress: string): Promise<{
	success: boolean
	newCardAddress: string
	snapshotHash: string
	totalRows: number
	matches: number
	mismatches: Array<SnapshotHolder & { conetAA?: string; conetBalanceE6?: string; reason?: string }>
	terminals: {
		total: number
		matches: number
		mismatches: Array<{ posEoa: string; reason: string; dbCardAddress?: string | null }>
	}
}> {
	const newCard = normalizeAddress(newCardAddress)
	const snapshot = await previewLongDhangConetMigrationSnapshot()
	const provider = conetProvider()
	const card = new ethers.Contract(newCard, USER_CARD_ADMIN_ABI, provider)
	const aaFactory = new ethers.Contract(CONET_AA_FACTORY, AA_FACTORY_ABI, provider)
	const mismatches: Array<SnapshotHolder & { conetAA?: string; conetBalanceE6?: string; reason?: string }> = []
	let matches = 0
	for (const row of snapshot.holders) {
		try {
			const aa = ethers.getAddress(await aaFactory.beamioAccountOf(row.eoa))
			if (aa === ethers.ZeroAddress) {
				mismatches.push({ ...row, reason: 'CoNET AA not registered.' })
				continue
			}
			const code = await provider.getCode(aa)
			if (!code || code === '0x') {
				mismatches.push({ ...row, conetAA: aa, reason: 'CoNET AA has no code.' })
				continue
			}
			const bal = BigInt(await card.balanceOf(aa, 0n))
			if (bal !== BigInt(row.balanceE6)) {
				mismatches.push({ ...row, conetAA: aa, conetBalanceE6: bal.toString(), reason: 'Balance mismatch.' })
				continue
			}
			matches += 1
		} catch (e: any) {
			mismatches.push({ ...row, reason: e?.message ?? String(e) })
		}
	}
	const expectedTerminals = await collectLongDhangSubAdmins(baseProvider())
	const terminalMismatches: Array<{ posEoa: string; reason: string; dbCardAddress?: string | null }> = []
	let terminalMatches = 0
	for (const t of expectedTerminals) {
		try {
			const isAdmin = Boolean(await card.isAdmin(t.posEoa))
			const dbRow = await getPosTerminalCardBindingRow(t.posEoa)
			const dbCard = dbRow?.cardAddress ?? null
			if (!isAdmin) {
				terminalMismatches.push({ posEoa: t.posEoa, reason: 'Terminal is not admin on new card.', dbCardAddress: dbCard })
				continue
			}
			if (!dbCard || ethers.getAddress(dbCard) !== newCard) {
				terminalMismatches.push({ posEoa: t.posEoa, reason: 'POS binding DB does not point to new card.', dbCardAddress: dbCard })
				continue
			}
			terminalMatches += 1
		} catch (e: any) {
			terminalMismatches.push({ posEoa: t.posEoa, reason: e?.message ?? String(e) })
		}
	}
	return {
		success: mismatches.length === 0 && terminalMismatches.length === 0,
		newCardAddress: newCard,
		snapshotHash: snapshot.snapshotHash,
		totalRows: snapshot.holders.length,
		matches,
		mismatches,
		terminals: {
			total: expectedTerminals.length,
			matches: terminalMatches,
			mismatches: terminalMismatches,
		},
	}
}

/** One-shot server migration after owner has authorized migration admin on the new CoNET card. */
export async function executeLongDhangConetMigrationAuto(options: {
	existingNewCardAddress?: string
	snapshotHash?: string
	/** Authorized signer EOA — CoNET card owner when creating a new card mid-flight. */
	cardOwnerEoa?: string
}): Promise<LongDhangMigrationAutoResult> {
	const phases: LongDhangMigrationAutoResult['phases'] = []
	const pushPhase = (phase: string, ok: boolean, detail?: string) => {
		phases.push({ phase, ok, detail })
	}
	try {
		const snapshot = await resolveLongDhangMigrationSnapshot({
			requestedHash: options.snapshotHash,
			force: true,
		})
		pushPhase('snapshot', true, `${snapshot.holderCount} members from Members directory`)

		let newCardAddress = options.existingNewCardAddress?.trim() ?? ''
		if (!newCardAddress || !ethers.isAddress(newCardAddress)) {
			const created = await createLongDhangConetMigrationCard({
				cardOwnerEoa: options.cardOwnerEoa,
			})
			if (!created.success) {
				pushPhase('create-card', false, created.error)
				throw new Error(created.error ?? 'Create CoNET card failed.')
			}
			newCardAddress = created.cardAddress
			pushPhase('create-card', true, newCardAddress)
		} else {
			newCardAddress = ethers.getAddress(newCardAddress)
			pushPhase('create-card', true, `Using existing card ${newCardAddress}`)
		}

		const migrationAdmin = getLongDhangMigrationAdminAddress()
		const conetCard = new ethers.Contract(newCardAddress, USER_CARD_ADMIN_ABI, conetProvider())
		const isAdmin = migrationAdmin !== ethers.ZeroAddress && Boolean(await conetCard.isAdmin(migrationAdmin))
		if (!isAdmin) {
			pushPhase('authorize-admin', false, `Migration admin ${migrationAdmin} is not authorized on ${newCardAddress}.`)
			throw new Error(`Migration admin is not authorized on ${newCardAddress}. Unlock wallet and retry Start Migration.`)
		}
		pushPhase('authorize-admin', true, migrationAdmin)

		const run = await runLongDhangConetMigrationBatch({
			newCardAddress,
			snapshotHash: snapshot.snapshotHash,
		})
		const adminStats = run.admins ?? run.terminals
		pushPhase(
			'migrate-members',
			run.failed === 0,
			`${run.minted} minted, ${run.skipped} skipped, ${run.failed} failed (${run.totalSnapshotRows} total)`
		)
		pushPhase(
			'migrate-admins',
			(adminStats?.failed ?? 0) === 0,
			`${adminStats?.registered ?? 0} registered, ${adminStats?.skipped ?? 0} skipped, ${adminStats?.failed ?? 0} failed`
		)
		if (!run.success) {
			throw new Error(run.error ?? 'Member or sub-admin migration failed.')
		}

		const verify = await verifyLongDhangConetMigration(newCardAddress)
		pushPhase(
			'verify',
			verify.success,
			`${verify.matches}/${verify.totalRows} members, ${verify.terminals.matches}/${verify.terminals.total} sub-admins`
		)
		if (!verify.success) {
			throw new Error('Verification found balance or sub-admin mismatches.')
		}

		return {
			success: true,
			newCardAddress,
			snapshotHash: snapshot.snapshotHash,
			phases,
			members: {
				total: run.totalSnapshotRows,
				minted: run.minted,
				skipped: run.skipped,
				failed: run.failed,
			},
			admins: {
				total: adminStats?.total ?? 0,
				registered: adminStats?.registered ?? 0,
				skipped: adminStats?.skipped ?? 0,
				failed: adminStats?.failed ?? 0,
			},
			verify: {
				success: verify.success,
				memberMatches: verify.matches,
				memberTotal: verify.totalRows,
				adminMatches: verify.terminals.matches,
				adminTotal: verify.terminals.total,
			},
		}
	} catch (e: any) {
		const msg = e?.message ?? String(e)
		if (phases.length === 0 || phases[phases.length - 1]?.ok) {
			pushPhase('failed', false, msg)
		}
		return {
			success: false,
			newCardAddress: options.existingNewCardAddress && ethers.isAddress(options.existingNewCardAddress)
				? ethers.getAddress(options.existingNewCardAddress)
				: ethers.ZeroAddress,
			snapshotHash: '',
			phases,
			members: { total: 0, minted: 0, skipped: 0, failed: 0 },
			admins: { total: 0, registered: 0, skipped: 0, failed: 0 },
			error: msg,
		}
	}
}

export function longDhangJson(value: unknown): string {
	return JSON.stringify(value, bigintJson, 2)
}
