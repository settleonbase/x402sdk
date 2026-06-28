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
 * Settle_ContractPool：factory 登记的 owner 列表，每项为一名 admin（含 baseFactoryPaymaster、walletBase 等）。
 *
 * 使用约定（防 nonce 冲突）：
 * - 任何 process 使用前必须 shift() 调出一名 owner，其他 process 则无法使用该 owner，避免同一 owner 同时调用 RPC 造成 nonce 冲突。
 * - process 结束后（无论成功/失败/early return）必须 unshift(SC) 将 owner 放回，以便其他 process 可复用。
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

export let Settle_ContractPool: SettleContractPoolEntry[] = []

let poolInitialized = false

/** Idempotent: populate Settle_ContractPool from ~/.master.json settle_contractAdmin. Safe for listener (no MemberCard side effects). */
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

		Settle_ContractPool.push({
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
		})
	}
}

/** Listener / redeem paths: ensure pool wallets exist without importing MemberCard.ts. */
export function ensureSettleContractPoolInitialized(): void {
	initSettleContractPool()
}
