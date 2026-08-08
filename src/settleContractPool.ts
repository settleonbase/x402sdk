import { ethers } from 'ethers'
import BeamioFactoryPaymasterArtifact from './ABI/BeamioUserCardFactoryPaymaster.json'
import BeamioAAAccountFactoryPaymasterArtifact from './ABI/BeamioAAAccountFactoryPaymaster.json'
import IDiamondCutABI from './ABI/DiamondCutFacetABI.json'
import DiamondLoupeFacetABI from './ABI/DiamondLoupeFacet.json'
import OwnershipABI from './ABI/OwnershipABI.json'
import TaskABI from './ABI/TaskABI.json'
import StatsABI from './ABI/StatsABI.json'
import CatalogABI from './ABI/CatalogABI.json'
import ActionABI from './ABI/ActionABI.json'
import AdminFacetABI from './ABI/adminFacet_ABI.json'
import beamioConetABI from './ABI/beamio-conet.abi.json'
import BeamioUserCardGatewayABI from './ABI/BeamioUserCardGatewayABI.json'
import {
	BASE_AA_FACTORY,
	BASE_CARD_FACTORY,
	CONET_CARD_FACTORY,
	BEAMIO_INDEXER_DIAMOND,
	GENESIS_NODE_BRIDGE_INITIATOR,
} from './chainAddresses'
import { masterSetup, resolveBeamioBaseHttpRpcUrl, resolveBeamioConetHttpRpcUrl } from './util'

const BeamioFactoryPaymasterABI = (
	Array.isArray(BeamioFactoryPaymasterArtifact)
		? BeamioFactoryPaymasterArtifact
		: (BeamioFactoryPaymasterArtifact as { abi?: unknown[] }).abi ?? []
) as ethers.InterfaceAbi

const BeamioAAAccountFactoryPaymasterABI = (
	Array.isArray(BeamioAAAccountFactoryPaymasterArtifact)
		? BeamioAAAccountFactoryPaymasterArtifact
		: (BeamioAAAccountFactoryPaymasterArtifact as { abi?: unknown[] }).abi ?? []
) as ethers.InterfaceAbi

const JSONRPC_NO_BATCH = { batchMaxCount: 1 }

const BEAMIO_CONET_ADDRESS = '0xCE8e2Cda88FfE2c99bc88D9471A3CBD08F519FEd'

/**
 * Settle admin roster + per-chain occupancy.
 *
 * `Settle_ContractRoster` / `Settle_ContractPool`：只读名册，**禁止 shift**。
 * `Settle_BasePool` / `Settle_ConetPool`：占用槽。同一私钥可同时占一条链、空出另一条，
 * 避免 CoNET airdrop 堵住 Base LockMint nonce。
 *
 * 双链同一 job（Genesis bindSale + LockMint）用 `shiftSettleBoth`。
 */
export type SettleContractPoolEntry = {
	baseFactoryPaymaster: ethers.Contract
	/** CoNET UserCard Factory（224422）；商户发卡 / Charge relay 默认链 */
	conetFactoryPaymaster: ethers.Contract
	walletBase: ethers.Wallet
	walletConet: ethers.Wallet
	aaAccountFactoryPaymaster: ethers.Contract
	BeamioTaskDiamondCut: ethers.Contract
	BeamioTaskDiamondLoupe: ethers.Contract
	BeamioTaskDiamondOwnership: ethers.Contract
	BeamioTaskDiamondTask: ethers.Contract
	BeamioTaskDiamondStats: ethers.Contract
	BeamioTaskDiamondCatalog: ethers.Contract
	BeamioTaskDiamondAction: ethers.Contract
	BeamioTaskDiamondAdmin: ethers.Contract
	beamioConet: ethers.Contract
	conetSC: ethers.Contract
	BeamioUserCardGateway: ethers.Contract
}

export let Settle_ContractRoster: SettleContractPoolEntry[] = []
export let Settle_BasePool: SettleContractPoolEntry[] = []
export let Settle_ConetPool: SettleContractPoolEntry[] = []

/**
 * 只读名册别名（view / factory-admin-init / `[0]` 读合约）。
 * **禁止** `.shift()` / `.unshift()` / `.splice` 占用；用 Base/Conet pool。
 */
export let Settle_ContractPool: SettleContractPoolEntry[] = []

let poolInitialized = false

function scAddr(sc: SettleContractPoolEntry): string {
	return sc.walletBase.address.toLowerCase()
}

/** Idempotent: populate roster + both occupancy pools from ~/.master.json settle_contractAdmin. */
export function initSettleContractPool(): void {
	if (poolInitialized) return
	poolInitialized = true

	const admins = masterSetup?.settle_contractAdmin
	if (!Array.isArray(admins) || admins.length === 0) {
		return
	}

	const providerBase = new ethers.JsonRpcProvider(resolveBeamioBaseHttpRpcUrl(), undefined, JSONRPC_NO_BATCH)
	const providerConet = new ethers.JsonRpcProvider(resolveBeamioConetHttpRpcUrl(), undefined, JSONRPC_NO_BATCH)

	for (const pk of admins) {
		const walletBase = new ethers.Wallet(pk, providerBase)
		const walletConet = new ethers.Wallet(pk, providerConet)
		const baseFactoryPaymaster = new ethers.Contract(BASE_CARD_FACTORY, BeamioFactoryPaymasterABI, walletBase)
		const conetFactoryPaymaster = new ethers.Contract(CONET_CARD_FACTORY, BeamioFactoryPaymasterABI, walletConet)
		const aaAccountFactoryPaymaster = new ethers.Contract(BASE_AA_FACTORY, BeamioAAAccountFactoryPaymasterABI, walletBase)
		const BeamioTaskDiamondCut = new ethers.Contract(BEAMIO_INDEXER_DIAMOND, IDiamondCutABI, walletConet)
		const BeamioTaskDiamondLoupe = new ethers.Contract(BEAMIO_INDEXER_DIAMOND, DiamondLoupeFacetABI, walletConet)
		const BeamioTaskDiamondOwnership = new ethers.Contract(BEAMIO_INDEXER_DIAMOND, OwnershipABI, walletConet)
		const BeamioTaskDiamondTask = new ethers.Contract(BEAMIO_INDEXER_DIAMOND, TaskABI, walletConet)
		const BeamioTaskDiamondStats = new ethers.Contract(BEAMIO_INDEXER_DIAMOND, StatsABI, walletConet)
		const BeamioTaskDiamondCatalog = new ethers.Contract(BEAMIO_INDEXER_DIAMOND, CatalogABI, walletConet)
		const BeamioTaskDiamondAction = new ethers.Contract(BEAMIO_INDEXER_DIAMOND, ActionABI, walletConet)
		const BeamioTaskDiamondAdmin = new ethers.Contract(BEAMIO_INDEXER_DIAMOND, AdminFacetABI, walletConet)
		const beamioConet = new ethers.Contract(BEAMIO_CONET_ADDRESS, beamioConetABI, walletConet)
		const conetSC = new ethers.Contract(BEAMIO_CONET_ADDRESS, beamioConetABI, walletConet)
		const BeamioUserCardGateway = new ethers.Contract(BASE_AA_FACTORY, BeamioUserCardGatewayABI, walletBase)

		const entry: SettleContractPoolEntry = {
			baseFactoryPaymaster,
			conetFactoryPaymaster,
			walletBase,
			walletConet,
			aaAccountFactoryPaymaster,
			BeamioTaskDiamondCut,
			BeamioTaskDiamondLoupe,
			BeamioTaskDiamondOwnership,
			BeamioTaskDiamondTask,
			BeamioTaskDiamondStats,
			BeamioTaskDiamondCatalog,
			BeamioTaskDiamondAction,
			BeamioTaskDiamondAdmin,
			beamioConet,
			conetSC,
			BeamioUserCardGateway,
		}
		Settle_ContractRoster.push(entry)
		Settle_BasePool.push(entry)
		Settle_ConetPool.push(entry)
	}
	Settle_ContractPool = Settle_ContractRoster
}

/** Listener / redeem paths: ensure pool wallets exist without importing MemberCard.ts. */
export function ensureSettleContractPoolInitialized(): void {
	initSettleContractPool()
}

export function settleRosterInitialized(): boolean {
	return Settle_ContractRoster.length > 0
}

export function hasIdleSettleBase(): boolean {
	return Settle_BasePool.length > 0
}

export function hasIdleSettleConet(): boolean {
	return Settle_ConetPool.length > 0
}

/** Same admin key idle on both chains (Genesis bindSale + LockMint). */
export function hasIdleSettleBoth(): boolean {
	const base = new Set(Settle_BasePool.map(scAddr))
	return Settle_ConetPool.some((sc) => base.has(scAddr(sc)))
}

export function shiftSettleBase(): SettleContractPoolEntry | undefined {
	return Settle_BasePool.shift()
}

export function shiftSettleConet(): SettleContractPoolEntry | undefined {
	return Settle_ConetPool.shift()
}

export function shiftSettleBoth(): SettleContractPoolEntry | undefined {
	const conetIdx = new Map(Settle_ConetPool.map((sc, i) => [scAddr(sc), i]))
	for (let i = 0; i < Settle_BasePool.length; i++) {
		const j = conetIdx.get(scAddr(Settle_BasePool[i]!))
		if (j === undefined) continue
		const [sc] = Settle_BasePool.splice(i, 1)
		Settle_ConetPool.splice(j, 1)
		return sc
	}
	return undefined
}

export function unshiftSettleBase(sc: SettleContractPoolEntry): void {
	Settle_BasePool.unshift(sc)
}

export function unshiftSettleConet(sc: SettleContractPoolEntry): void {
	Settle_ConetPool.unshift(sc)
}

export function unshiftSettleBoth(sc: SettleContractPoolEntry): void {
	Settle_BasePool.unshift(sc)
	Settle_ConetPool.unshift(sc)
}

export function genesisBridgeInitiatorInRoster(): boolean {
	const want = GENESIS_NODE_BRIDGE_INITIATOR.toLowerCase()
	return Settle_ContractRoster.some((sc) => scAddr(sc) === want)
}

export function hasIdleGenesisInitiatorBase(): boolean {
	const want = GENESIS_NODE_BRIDGE_INITIATOR.toLowerCase()
	return Settle_BasePool.some((sc) => scAddr(sc) === want)
}

export function hasIdleGenesisInitiatorBoth(): boolean {
	const want = GENESIS_NODE_BRIDGE_INITIATOR.toLowerCase()
	const inBase = Settle_BasePool.some((sc) => scAddr(sc) === want)
	const inConet = Settle_ConetPool.some((sc) => scAddr(sc) === want)
	return inBase && inConet
}

export function shiftGenesisBridgeInitiatorBase(): SettleContractPoolEntry | undefined {
	const want = GENESIS_NODE_BRIDGE_INITIATOR.toLowerCase()
	const idx = Settle_BasePool.findIndex((sc) => scAddr(sc) === want)
	if (idx < 0) return undefined
	const [sc] = Settle_BasePool.splice(idx, 1)
	return sc
}

export function shiftGenesisBridgeInitiatorBoth(): SettleContractPoolEntry | undefined {
	const want = GENESIS_NODE_BRIDGE_INITIATOR.toLowerCase()
	const baseIdx = Settle_BasePool.findIndex((sc) => scAddr(sc) === want)
	const conetIdx = Settle_ConetPool.findIndex((sc) => scAddr(sc) === want)
	if (baseIdx < 0 || conetIdx < 0) return undefined
	const [sc] = Settle_BasePool.splice(baseIdx, 1)
	Settle_ConetPool.splice(conetIdx, 1)
	return sc
}

export async function withGenesisBridgeInitiatorBase<T>(
	fn: (sc: SettleContractPoolEntry) => Promise<T>,
): Promise<T> {
	if (!genesisBridgeInitiatorInRoster()) {
		throw new Error(
			`Genesis bridge initiator ${GENESIS_NODE_BRIDGE_INITIATOR} not in Settle_ContractRoster (check settle_contractAdmin)`,
		)
	}
	const sc = shiftGenesisBridgeInitiatorBase()
	if (!sc) {
		throw new Error('GENESIS_BRIDGE_INITIATOR_BASE_BUSY')
	}
	try {
		return await fn(sc)
	} finally {
		unshiftSettleBase(sc)
	}
}

export async function withGenesisBridgeInitiatorBoth<T>(
	fn: (sc: SettleContractPoolEntry) => Promise<T>,
): Promise<T> {
	if (!genesisBridgeInitiatorInRoster()) {
		throw new Error(
			`Genesis bridge initiator ${GENESIS_NODE_BRIDGE_INITIATOR} not in Settle_ContractRoster (check settle_contractAdmin)`,
		)
	}
	const sc = shiftGenesisBridgeInitiatorBoth()
	if (!sc) {
		throw new Error('GENESIS_BRIDGE_INITIATOR_BOTH_BUSY')
	}
	try {
		return await fn(sc)
	} finally {
		unshiftSettleBoth(sc)
	}
}

export function settlePoolIdleSummary(): string {
	return `roster=${Settle_ContractRoster.length} baseIdle=${Settle_BasePool.length} conetIdle=${Settle_ConetPool.length}`
}
