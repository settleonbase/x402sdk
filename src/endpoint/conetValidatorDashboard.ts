import { ethers } from 'ethers'
import { resolveBeamioConetHttpRpcUrl } from '../util'
import { CONET_VALIDATOR_DEPOSIT_REDEEM } from '../chainAddresses'
import {
	validatorDepositRedeemReadUnifiedIncomeStats,
	type UnifiedIncomeStats,
} from './validatorDepositRedeem'

const PUBKEY_RE = /^0x[0-9a-f]{96}$/
const CACHE_TTL_MS = 30_000
const BEACON_TIMEOUT_MS = 8_000

const VALIDATOR_DASHBOARD_ABI = [
	'function getNodeByValidatorPubkeyHash(bytes32 pubkeyHash) view returns (uint256 guardianId)',
	'function getNodeValidator(uint256 guardianId) view returns (bytes pubkey, address withdrawalBeneficiary, uint64 registeredAt, uint64 exitedAt, bool active)',
	'function guardianIdBeneficiary(uint256 guardianId) view returns (address)',
	'function getBeneficiaryNodeBundle(address beneficiary) view returns (tuple(address beneficiary, uint256[] guardianNodeIds, string[] depinNodeIps, address[] nodeWallets, bytes[] validatorPubkeys, bool[] validatorActive, uint256 validatorNodeCount, uint256 gbMiningNodeCount, uint256 claimCount, uint256 nativeBalance, uint256 gbBalance, uint256 usdcBalance))',
	'function clRewardPaid(address beneficiary) view returns (uint256)',
] as const

type NodeBundle = {
	beneficiary: string
	guardianNodeIds: bigint[]
	depinNodeIps: string[]
	nodeWallets: string[]
	validatorPubkeys: string[]
	validatorActive: boolean[]
	validatorNodeCount: bigint
	gbMiningNodeCount: bigint
	claimCount: bigint
	nativeBalance: bigint
	gbBalance: bigint
	usdcBalance: bigint
}

type BeaconValidatorResponse = {
	index?: string
	balance?: string
	status?: string
	validator?: {
		pubkey?: string
		withdrawal_credentials?: string
		effective_balance?: string
		slashed?: boolean
		activation_eligibility_epoch?: string
		activation_epoch?: string
		exit_epoch?: string
		withdrawable_epoch?: string
	}
}

type CachedDashboard = {
	value: ConetValidatorDashboard
	fetchedAt: number
}

export type ConetValidatorDashboard = {
	success: true
	pubkey: string
	chain: {
		contract: string
		guardianId: string
		beneficiary: string
		withdrawalBeneficiary: string
		registeredAt: string
		exitedAt: string
		active: boolean
		nodeWallet: string | null
		depinNodeIp: string | null
		clRewardPaidWei: string
	}
	income: UnifiedIncomeStats | null
	beacon: {
		available: boolean
		index: string | null
		status: string | null
		balanceGwei: string | null
		effectiveBalanceGwei: string | null
		withdrawalCredentials: string | null
		slashed: boolean | null
		activationEligibilityEpoch: string | null
		activationEpoch: string | null
		exitEpoch: string | null
		withdrawableEpoch: string | null
	}
	meta: {
		partial: boolean
		stale: boolean
		chainUpdatedAt: string
		beaconUpdatedAt: string | null
	}
}

const dashboardCache = new Map<string, CachedDashboard>()

function normalizePubkey(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const normalized = value.trim().toLowerCase()
	return PUBKEY_RE.test(normalized) ? normalized : null
}

function toAddress(value: unknown): string {
	try {
		return ethers.getAddress(String(value))
	} catch {
		return ethers.ZeroAddress
	}
}

function toStringValue(value: unknown): string {
	return typeof value === 'bigint' ? value.toString() : String(value ?? '')
}

function normalizeBytes(value: unknown): string {
	try {
		return ethers.hexlify(ethers.getBytes(String(value))).toLowerCase()
	} catch {
		return ''
	}
}

function normalizeBundle(raw: unknown): NodeBundle {
	const row = raw as Record<string, unknown>
	const array = (key: string): unknown[] => (Array.isArray(row[key]) ? (row[key] as unknown[]) : [])
	return {
		beneficiary: toAddress(row.beneficiary),
		guardianNodeIds: array('guardianNodeIds').map((value) => BigInt(String(value))),
		depinNodeIps: array('depinNodeIps').map(String),
		nodeWallets: array('nodeWallets').map(toAddress),
		validatorPubkeys: array('validatorPubkeys').map(normalizeBytes),
		validatorActive: array('validatorActive').map(Boolean),
		validatorNodeCount: BigInt(String(row.validatorNodeCount ?? 0)),
		gbMiningNodeCount: BigInt(String(row.gbMiningNodeCount ?? 0)),
		claimCount: BigInt(String(row.claimCount ?? 0)),
		nativeBalance: BigInt(String(row.nativeBalance ?? 0)),
		gbBalance: BigInt(String(row.gbBalance ?? 0)),
		usdcBalance: BigInt(String(row.usdcBalance ?? 0)),
	}
}

function findBundleIndex(bundle: NodeBundle, pubkey: string, guardianId: bigint): number {
	const byGuardian = bundle.guardianNodeIds.findIndex((id) => id === guardianId)
	if (byGuardian >= 0) return byGuardian
	return bundle.validatorPubkeys.findIndex((value) => value === pubkey)
}

async function fetchBeaconValidator(pubkey: string): Promise<{
	available: boolean
	value: BeaconValidatorResponse | null
	updatedAt: string | null
}> {
	const base = (process.env.CONET_VALIDATOR_BEACON_REST_URL?.trim() || 'http://127.0.0.1:4100').replace(/\/$/, '')
	try {
		const response = await fetch(`${base}/eth/v1/beacon/states/head/validators/${pubkey}`, {
			signal: AbortSignal.timeout(BEACON_TIMEOUT_MS),
		})
		if (!response.ok) return { available: false, value: null, updatedAt: null }
		const payload = (await response.json()) as { data?: BeaconValidatorResponse }
		if (!payload.data?.validator) return { available: false, value: null, updatedAt: null }
		return { available: true, value: payload.data, updatedAt: new Date().toISOString() }
	} catch {
		return { available: false, value: null, updatedAt: null }
	}
}

function emptyBeacon() {
	return {
		available: false,
		index: null,
		status: null,
		balanceGwei: null,
		effectiveBalanceGwei: null,
		withdrawalCredentials: null,
		slashed: null,
		activationEligibilityEpoch: null,
		activationEpoch: null,
		exitEpoch: null,
		withdrawableEpoch: null,
	}
}

export function normalizeConetValidatorPubkey(value: unknown): string | null {
	return normalizePubkey(value)
}

export async function getConetValidatorDashboard(
	rawPubkey: unknown,
): Promise<{ status: 200; body: ConetValidatorDashboard } | { status: 400 | 404 | 503; body: { success: false; error: string } }> {
	const pubkey = normalizePubkey(rawPubkey)
	if (!pubkey) {
		return { status: 400, body: { success: false, error: 'Validator pubkey must be 0x followed by 96 hexadecimal characters' } }
	}

	const cached = dashboardCache.get(pubkey)
	if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
		return { status: 200, body: cached.value }
	}

	try {
		const provider = new ethers.JsonRpcProvider(resolveBeamioConetHttpRpcUrl())
		const contract = new ethers.Contract(CONET_VALIDATOR_DEPOSIT_REDEEM, VALIDATOR_DASHBOARD_ABI, provider)
		const pubkeyHash = ethers.keccak256(ethers.getBytes(pubkey))
		const guardianId = (await contract.getNodeByValidatorPubkeyHash(pubkeyHash)) as bigint
		if (guardianId === 0n) {
			return { status: 404, body: { success: false, error: 'Validator pubkey is not registered on CoNET' } }
		}

		const [validatorRaw, beneficiaryRaw, rewardRaw] = await Promise.all([
			contract.getNodeValidator(guardianId),
			contract.guardianIdBeneficiary(guardianId),
			contract.clRewardPaid(await contract.guardianIdBeneficiary(guardianId)),
		])
		const validator = {
			pubkey: normalizeBytes(validatorRaw[0]),
			withdrawalBeneficiary: toAddress(validatorRaw[1]),
			registeredAt: toStringValue(validatorRaw[2]),
			exitedAt: toStringValue(validatorRaw[3]),
			active: Boolean(validatorRaw[4]),
		}
		const beneficiary = toAddress(beneficiaryRaw)
		const bundle = normalizeBundle(await contract.getBeneficiaryNodeBundle(beneficiary))
		const index = findBundleIndex(bundle, pubkey, guardianId)
		const [incomeResult, beacon] = await Promise.all([
			validatorDepositRedeemReadUnifiedIncomeStats(beneficiary),
			fetchBeaconValidator(pubkey),
		])
		const beaconRow = beacon.value
		const beaconValidator = beaconRow?.validator
		const previous = cached?.value
		const beaconState = beacon.available && beaconRow && beaconValidator
			? {
					available: true,
					index: beaconRow.index ?? null,
					status: beaconRow.status ?? null,
					balanceGwei: beaconRow.balance ?? null,
					effectiveBalanceGwei: beaconValidator.effective_balance ?? null,
					withdrawalCredentials: beaconValidator.withdrawal_credentials ?? null,
					slashed: beaconValidator.slashed ?? null,
					activationEligibilityEpoch: beaconValidator.activation_eligibility_epoch ?? null,
					activationEpoch: beaconValidator.activation_epoch ?? null,
					exitEpoch: beaconValidator.exit_epoch ?? null,
					withdrawableEpoch: beaconValidator.withdrawable_epoch ?? null,
				}
			: previous?.beacon ?? emptyBeacon()
		const value: ConetValidatorDashboard = {
			success: true,
			pubkey,
			chain: {
				contract: CONET_VALIDATOR_DEPOSIT_REDEEM,
				guardianId: guardianId.toString(),
				beneficiary,
				withdrawalBeneficiary: validator.withdrawalBeneficiary,
				registeredAt: validator.registeredAt,
				exitedAt: validator.exitedAt,
				active: validator.active,
				nodeWallet: index >= 0 ? bundle.nodeWallets[index] ?? null : null,
				depinNodeIp: index >= 0 ? bundle.depinNodeIps[index] ?? null : null,
				clRewardPaidWei: toStringValue(rewardRaw),
			},
			income: incomeResult.ok ? incomeResult.stats : cached?.value.income ?? null,
			beacon: beaconState,
			meta: {
				partial: !beacon.available,
				stale: false,
				chainUpdatedAt: new Date().toISOString(),
				beaconUpdatedAt: beacon.available ? beacon.updatedAt : previous?.meta.beaconUpdatedAt ?? null,
			},
		}
		dashboardCache.set(pubkey, { value, fetchedAt: Date.now() })
		return { status: 200, body: value }
	} catch (error) {
		if (cached) {
			return {
				status: 200,
				body: {
					...cached.value,
					meta: { ...cached.value.meta, stale: true, partial: true },
				},
			}
		}
		return { status: 503, body: { success: false, error: `CoNET validator data unavailable: ${(error as Error).message}` } }
	}
}
