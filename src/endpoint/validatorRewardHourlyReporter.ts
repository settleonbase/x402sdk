import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { ethers } from 'ethers'
import Colors from 'colors/safe'
import { logger } from '../logger'
import { masterSetup, resolveBeamioConetHttpRpcUrl } from '../util'
import {
	resolveValidatorDepositRedeemAddress,
	resolveValidatorNodeIp,
	resolveValidatorNodeRewardIndexerAddress,
	validatorRewardReport,
} from './validatorDepositRedeem'

const DEFAULT_NEW_CONET_DIR = '/Users/peter/Downloads/seguro-pro/CoNET-DL-master/newCoNET'
const DEFAULT_BEACON_REST = 'http://127.0.0.1:4100'
const REPORTER_ABI = [
	'function getNodeValidator(address nodeWallet) view returns (bytes pubkey, address withdrawalBeneficiary, uint64 registeredAt, uint64 exitedAt, bool active)',
	'function getNodeByValidatorPubkeyHash(bytes32 pubkeyHash) view returns (address nodeWallet)',
] as const

type TrackedValidator = {
	pubkey: string
	nodeWallet: string
	beneficiary: string
	active: boolean
}

type BalanceSnapshot = {
	beaconGwei: string
	feeRecipientWei: string
}

type RewardReporterState = {
	updatedAt: string
	/** Last observed balances per validator pubkey (lowercase hex). */
	lastSnapshot: Record<string, BalanceSnapshot>
}

let reporterStarted = false
let reporterTimer: ReturnType<typeof setTimeout> | undefined
let reporterInFlight = false

function resolveNewCoNETDir(): string {
	return process.env.CONET_VALIDATOR_NEWCONET_DIR?.trim() || masterSetup.validatorDeposit?.newCoNETDir?.trim() || DEFAULT_NEW_CONET_DIR
}

function resolveRewardReporterStateFile(): string {
	return (
		process.env.CONET_VALIDATOR_HOURLY_REWARD_STATE_FILE?.trim() ||
		process.env.CONET_VALIDATOR_REWARD_REPORTER_STATE_FILE?.trim() ||
		path.join(homedir(), '.conet-validator-reward-reporter-state.json')
	)
}

function resolveBeaconRestUrl(): string {
	return (process.env.CONET_VALIDATOR_BEACON_REST_URL?.trim() || DEFAULT_BEACON_REST).replace(/\/$/, '')
}

function resolveReporterTickMs(): number {
	const n = Number(process.env.CONET_VALIDATOR_HOURLY_REWARD_TICK_MS || process.env.CONET_VALIDATOR_REWARD_REPORTER_TICK_MS || 60_000)
	return Number.isFinite(n) && n >= 15_000 ? Math.floor(n) : 60_000
}

function resolveReportChunkSize(): number {
	const n = Number(process.env.CONET_VALIDATOR_HOURLY_REWARD_CHUNK || process.env.CONET_VALIDATOR_REWARD_REPORTER_CHUNK || 40)
	return Number.isFinite(n) && n >= 1 ? Math.min(200, Math.floor(n)) : 40
}

function reporterDryRun(): boolean {
	const v = (process.env.CONET_VALIDATOR_HOURLY_REWARD_DRY_RUN || process.env.CONET_VALIDATOR_REWARD_REPORTER_DRY_RUN || process.env.CONET_VALIDATOR_DRY_RUN || '').trim().toLowerCase()
	return v === '1' || v === 'true' || v === 'yes'
}

function reporterEnabled(): boolean {
	if (process.env.CONET_VALIDATOR_HOURLY_REWARD_REPORT === '0') return false
	if (process.env.CONET_VALIDATOR_REWARD_REPORTER === '0') return false
	if (process.env.CONET_VALIDATOR_HOURLY_REWARD_REPORT === '1') return true
	if (process.env.CONET_VALIDATOR_REWARD_REPORTER === '1') return true
	// Default: follow redeem listener flag when unset.
	return process.env.CONET_VALIDATOR_REDEEM_LISTENER === '1'
}

function gweiToWei(gwei: bigint): bigint {
	return gwei * 1_000_000_000n
}

function readState(): RewardReporterState {
	const file = resolveRewardReporterStateFile()
	try {
		if (!fs.existsSync(file)) {
			return { updatedAt: new Date().toISOString(), lastSnapshot: {} }
		}
		const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as RewardReporterState & {
			hourStart?: Record<string, BalanceSnapshot>
			trackingHourId?: number
		}
		if (raw.lastSnapshot && typeof raw.lastSnapshot === 'object') {
			return { updatedAt: raw.updatedAt ?? new Date().toISOString(), lastSnapshot: raw.lastSnapshot }
		}
		if (raw.hourStart && typeof raw.hourStart === 'object') {
			logger(
				Colors.yellow(
					'[validatorRewardReporter] migrated legacy UTC-hour state → delta baseline (re-baselining on next tick)'
				)
			)
		}
		return { updatedAt: new Date().toISOString(), lastSnapshot: {} }
	} catch (e: unknown) {
		logger(Colors.yellow(`[validatorRewardReporter] state reset: ${(e as Error)?.message ?? e}`))
		return { updatedAt: new Date().toISOString(), lastSnapshot: {} }
	}
}

function writeState(state: RewardReporterState): void {
	const file = resolveRewardReporterStateFile()
	state.updatedAt = new Date().toISOString()
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8')
}

function normalizePubkeyHex(raw: string): string | null {
	const pk = String(raw ?? '').trim()
	if (!pk) return null
	try {
		return ethers.hexlify(ethers.getBytes(pk.startsWith('0x') ? pk : `0x${pk}`)).toLowerCase()
	} catch {
		return null
	}
}

function readExtraTrackPubkeys(): string[] {
	const inline = (process.env.CONET_VALIDATOR_TRACK_PUBKEYS || '').trim()
	if (!inline) return []
	return [
		...new Set(
			inline
				.split(/[\s,]+/)
				.map((s) => normalizePubkeyHex(s))
				.filter((s): s is string => Boolean(s))
		),
	]
}

/** List validator pubkeys from Prysm wallet account metadata (optional supplement to deposit file). */
function readPrysmWalletPubkeys(): string[] {
	const walletDir =
		process.env.CONET_VALIDATOR_PRYSM_WALLET_DIR?.trim() ||
		path.join(resolveNewCoNETDir(), 'network/node-0/consensus/validator-wallet')
	const accountsDir = path.join(walletDir, 'direct/accounts')
	if (!fs.existsSync(accountsDir)) return []
	const out: string[] = []
	try {
		for (const file of fs.readdirSync(accountsDir)) {
			if (!file.endsWith('.json')) continue
			try {
				const meta = JSON.parse(fs.readFileSync(path.join(accountsDir, file), 'utf8')) as {
					validator?: { publicKey?: string }
				}
				const pk = normalizePubkeyHex(String(meta?.validator?.publicKey ?? ''))
				if (pk) out.push(pk)
			} catch {
				// skip corrupt account file
			}
		}
	} catch {
		return []
	}
	return [...new Set(out)]
}

function readLocalDepositPubkeys(): string[] {
	const depositFile = path.join(resolveNewCoNETDir(), 'validator_deposits.json')
	const out: string[] = []
	if (fs.existsSync(depositFile)) {
		try {
			const arr = JSON.parse(fs.readFileSync(depositFile, 'utf8'))
			if (Array.isArray(arr)) {
				for (const entry of arr) {
					const pk = normalizePubkeyHex(String(entry?.pubkey ?? ''))
					if (pk) out.push(pk)
				}
			}
		} catch (e: unknown) {
			logger(Colors.yellow(`[validatorRewardReporter] deposit file read failed: ${(e as Error)?.message ?? e}`))
		}
	}
	out.push(...readPrysmWalletPubkeys(), ...readExtraTrackPubkeys())
	return [...new Set(out)]
}

async function loadTrackedValidators(contract: string): Promise<TrackedValidator[]> {
	const pubkeys = readLocalDepositPubkeys()
	if (!pubkeys.length) return []
	const provider = new ethers.JsonRpcProvider(resolveBeamioConetHttpRpcUrl())
	const c = new ethers.Contract(contract, REPORTER_ABI, provider)
	const out: TrackedValidator[] = []
	for (const pubkey of pubkeys) {
		try {
			const pkHash = ethers.keccak256(pubkey)
			const nodeWallet = ethers.getAddress(await c.getNodeByValidatorPubkeyHash!(pkHash))
			if (nodeWallet === ethers.ZeroAddress) continue
			const row = await c.getNodeValidator!(nodeWallet)
			const beneficiary = ethers.getAddress(String(row.withdrawalBeneficiary ?? row[1]))
			const active = Boolean(row.active ?? row[4])
			out.push({ pubkey, nodeWallet, beneficiary, active })
		} catch {
			// skip unregistered / RPC blip for single pubkey
		}
	}
	return out.filter((v) => v.active)
}

async function fetchBeaconBalanceGwei(pubkey: string): Promise<bigint | null> {
	const base = resolveBeaconRestUrl()
	const id = encodeURIComponent(pubkey.startsWith('0x') ? pubkey : `0x${pubkey}`)
	const url = `${base}/eth/v1/beacon/states/head/validators/${id}`
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
		if (!res.ok) return null
		const json = (await res.json()) as { data?: { balance?: string; status?: string } }
		const bal = json?.data?.balance
		if (bal == null || bal === '') return null
		const gwei = BigInt(bal)
		return gwei >= 0n ? gwei : null
	} catch {
		return null
	}
}

async function fetchNativeBalanceWei(provider: ethers.Provider, address: string): Promise<bigint | null> {
	try {
		const bal = await provider.getBalance(address)
		return bal >= 0n ? bal : null
	} catch {
		return null
	}
}

async function snapshotValidators(validators: TrackedValidator[]): Promise<Map<string, BalanceSnapshot>> {
	const provider = new ethers.JsonRpcProvider(resolveBeamioConetHttpRpcUrl())
	const beneficiaryCache = new Map<string, bigint | null>()
	const out = new Map<string, BalanceSnapshot>()
	for (const v of validators) {
		const beaconGwei = await fetchBeaconBalanceGwei(v.pubkey)
		if (beaconGwei == null) continue
		let feeWei = beneficiaryCache.get(v.beneficiary)
		if (feeWei === undefined) {
			feeWei = await fetchNativeBalanceWei(provider, v.beneficiary)
			beneficiaryCache.set(v.beneficiary, feeWei)
		}
		if (feeWei == null) continue
		out.set(v.pubkey.toLowerCase(), {
			beaconGwei: beaconGwei.toString(),
			feeRecipientWei: feeWei.toString(),
		})
	}
	return out
}

function rewardEventKey(pubkey: string, start: BalanceSnapshot, end: BalanceSnapshot): string {
	return ethers.keccak256(
		ethers.AbiCoder.defaultAbiCoder().encode(
			['bytes32', 'uint256', 'uint256', 'uint256', 'uint256'],
			[
				ethers.keccak256(pubkey),
				BigInt(start.beaconGwei),
				BigInt(end.beaconGwei),
				BigInt(start.feeRecipientWei),
				BigInt(end.feeRecipientWei),
			]
		)
	)
}

function computeRewardEntries(
	validators: TrackedValidator[],
	start: Map<string, BalanceSnapshot>,
	end: Map<string, BalanceSnapshot>
): Array<{ eventKey: string; nodeWallet: string; pubkey: string; amount: bigint }> {
	const byBeneficiary = new Map<string, TrackedValidator[]>()
	for (const v of validators) {
		const key = v.beneficiary.toLowerCase()
		const list = byBeneficiary.get(key) ?? []
		list.push(v)
		byBeneficiary.set(key, list)
	}

	const entries: Array<{ eventKey: string; nodeWallet: string; pubkey: string; amount: bigint }> = []

	for (const v of validators) {
		const pk = v.pubkey.toLowerCase()
		const s = start.get(pk)
		const e = end.get(pk)
		if (!s || !e) continue

		let reward = 0n
		const beaconDelta = BigInt(e.beaconGwei) - BigInt(s.beaconGwei)
		if (beaconDelta > 0n) reward += gweiToWei(beaconDelta)

		const group = byBeneficiary.get(v.beneficiary.toLowerCase()) ?? [v]
		const feeStart = BigInt(s.feeRecipientWei)
		const feeEnd = BigInt(e.feeRecipientWei)
		const feeDelta = feeEnd > feeStart ? feeEnd - feeStart : 0n
		if (feeDelta > 0n && group.length > 0) {
			reward += feeDelta / BigInt(group.length)
		}

		if (reward <= 0n) continue
		entries.push({
			eventKey: rewardEventKey(pk, s, e),
			nodeWallet: v.nodeWallet,
			pubkey: pk,
			amount: reward,
		})
	}

	return entries
}

async function submitRewardReports(
	entries: Array<{ eventKey: string; nodeWallet: string; pubkey: string; amount: bigint }>,
	endSnap: Map<string, BalanceSnapshot>,
	state: RewardReporterState
): Promise<void> {
	if (!entries.length) return
	const chunk = resolveReportChunkSize()
	for (let i = 0; i < entries.length; i += chunk) {
		const slice = entries.slice(i, i + chunk)
		if (reporterDryRun()) {
			logger(
				Colors.cyan(
					`[validatorRewardReporter] dry-run report ${slice.length} rows sample=${slice[0]?.nodeWallet} amount=${slice[0]?.amount.toString()}`
				)
			)
			for (const row of slice) {
				const snap = endSnap.get(row.pubkey)
				if (snap) state.lastSnapshot[row.pubkey] = snap
			}
			writeState(state)
			continue
		}
		const res = await validatorRewardReport(
			slice.map((e) => ({
				eventKey: e.eventKey,
				nodeWallet: e.nodeWallet,
				amount: e.amount,
			}))
		)
		if (!res.ok) {
			throw new Error(res.error)
		}
		for (const row of slice) {
			const snap = endSnap.get(row.pubkey)
			if (snap) state.lastSnapshot[row.pubkey] = snap
		}
		writeState(state)
		logger(
			Colors.green(
				`[validatorRewardReporter] reported ${res.added}/${res.count} rows tx=${res.txHash} sample=${slice[0]?.nodeWallet}`
			)
		)
	}
}

async function reporterTick(): Promise<void> {
	if (reporterInFlight) return
	reporterInFlight = true
	try {
		const contract = resolveValidatorDepositRedeemAddress()
		if (!contract) {
			logger(Colors.yellow('[validatorRewardReporter] skip: ValidatorDepositRedeem not configured'))
			return
		}
		const indexer = await resolveValidatorNodeRewardIndexerAddress()
		if (!indexer) {
			logger(Colors.yellow('[validatorRewardReporter] skip: ValidatorNodeRewardIndexer not configured'))
			return
		}

		const validators = await loadTrackedValidators(contract)
		if (!validators.length) {
			logger(Colors.yellow('[validatorRewardReporter] no active local validators to track'))
			return
		}

		const state = readState()
		const endSnap = await snapshotValidators(validators)

		if (!Object.keys(state.lastSnapshot).length) {
			for (const [pk, snap] of endSnap.entries()) {
				state.lastSnapshot[pk] = snap
			}
			writeState(state)
			logger(Colors.cyan(`[validatorRewardReporter] baseline ${endSnap.size} validators (no report until reward delta)`))
			return
		}

		const startMap = new Map<string, BalanceSnapshot>()
		for (const [pk, snap] of Object.entries(state.lastSnapshot)) startMap.set(pk, snap)

		const entries = computeRewardEntries(validators, startMap, endSnap)
		if (entries.length) {
			await submitRewardReports(entries, endSnap, state)
		}

		for (const [pk, snap] of endSnap.entries()) {
			state.lastSnapshot[pk] = snap
		}
		writeState(state)
	} catch (e: unknown) {
		logger(Colors.red('[validatorRewardReporter] tick failed:'), (e as Error)?.message ?? String(e))
	} finally {
		reporterInFlight = false
	}
}

function scheduleReporterTick(): void {
	if (reporterTimer !== undefined) clearTimeout(reporterTimer)
	reporterTimer = setTimeout(async () => {
		try {
			await reporterTick()
		} finally {
			scheduleReporterTick()
		}
	}, resolveReporterTickMs())
}

/** CoNET validator-node listener: detect CL+EL CNET reward deltas and report via {validatorRewardReport}. */
export function startValidatorRewardHourlyReporter(): void {
	if (reporterStarted) return
	reporterStarted = true
	if (!reporterEnabled()) {
		logger(Colors.yellow('[validatorRewardReporter] disabled (set CONET_VALIDATOR_HOURLY_REWARD_REPORT=1)'))
		return
	}
	const nodeIp = resolveValidatorNodeIp()
	logger(
		Colors.cyan(
			`[validatorRewardReporter] starting nodeIp=${nodeIp || '?'} beacon=${resolveBeaconRestUrl()} tick=${resolveReporterTickMs()}ms`
		)
	)
	void reporterTick().finally(() => scheduleReporterTick())
}

export function stopValidatorRewardHourlyReporter(): void {
	if (reporterTimer !== undefined) {
		clearTimeout(reporterTimer)
		reporterTimer = undefined
	}
	reporterStarted = false
}
