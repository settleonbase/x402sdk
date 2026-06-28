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
	validatorRewardReportHourly,
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

type HourlyRewardReporterState = {
	updatedAt: string
	trackingHourId: number
	lastReportedHourId: number
	/** Balances captured at the start of {trackingHourId} (UTC hour bucket). */
	hourStart: Record<string, BalanceSnapshot>
}

let reporterStarted = false
let reporterTimer: ReturnType<typeof setTimeout> | undefined
let reporterInFlight = false

function resolveNewCoNETDir(): string {
	return process.env.CONET_VALIDATOR_NEWCONET_DIR?.trim() || masterSetup.validatorDeposit?.newCoNETDir?.trim() || DEFAULT_NEW_CONET_DIR
}

function resolveHourlyRewardStateFile(): string {
	return (
		process.env.CONET_VALIDATOR_HOURLY_REWARD_STATE_FILE?.trim() ||
		path.join(homedir(), '.conet-validator-hourly-reward-state.json')
	)
}

function resolveBeaconRestUrl(): string {
	return (process.env.CONET_VALIDATOR_BEACON_REST_URL?.trim() || DEFAULT_BEACON_REST).replace(/\/$/, '')
}

function resolveReporterTickMs(): number {
	const n = Number(process.env.CONET_VALIDATOR_HOURLY_REWARD_TICK_MS || 60_000)
	return Number.isFinite(n) && n >= 15_000 ? Math.floor(n) : 60_000
}

/** Seconds after UTC hour boundary before closing the previous hour (balance settle). */
function resolveReportDelaySec(): number {
	const n = Number(process.env.CONET_VALIDATOR_HOURLY_REWARD_REPORT_DELAY_SEC || 120)
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 120
}

function resolveReportChunkSize(): number {
	const n = Number(process.env.CONET_VALIDATOR_HOURLY_REWARD_CHUNK || 40)
	return Number.isFinite(n) && n >= 1 ? Math.min(200, Math.floor(n)) : 40
}

/** Only capture hourStart within this many seconds after UTC hour boundary (avoid mid-hour baselines). */
function resolveBaselineGraceSec(): number {
	const n = Number(process.env.CONET_VALIDATOR_HOURLY_REWARD_BASELINE_GRACE_SEC || 300)
	return Number.isFinite(n) && n >= 30 ? Math.min(900, Math.floor(n)) : 300
}

function secondsIntoUtcHour(unixSec: number): number {
	return unixSec % 3600
}

function reporterDryRun(): boolean {
	const v = (process.env.CONET_VALIDATOR_HOURLY_REWARD_DRY_RUN || process.env.CONET_VALIDATOR_DRY_RUN || '').trim().toLowerCase()
	return v === '1' || v === 'true' || v === 'yes'
}

function reporterEnabled(): boolean {
	if (process.env.CONET_VALIDATOR_HOURLY_REWARD_REPORT === '0') return false
	if (process.env.CONET_VALIDATOR_HOURLY_REWARD_REPORT === '1') return true
	// Default: follow redeem listener flag when unset.
	return process.env.CONET_VALIDATOR_REDEEM_LISTENER === '1'
}

function utcHourId(unixSec: number): number {
	return Math.floor(unixSec / 3600)
}

function gweiToWei(gwei: bigint): bigint {
	return gwei * 1_000_000_000n
}

function readState(): HourlyRewardReporterState {
	const file = resolveHourlyRewardStateFile()
	try {
		if (!fs.existsSync(file)) {
			const now = utcHourId(Math.floor(Date.now() / 1000))
			return { updatedAt: new Date().toISOString(), trackingHourId: now, lastReportedHourId: now - 1, hourStart: {} }
		}
		const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as HourlyRewardReporterState
		if (typeof raw.trackingHourId !== 'number' || typeof raw.lastReportedHourId !== 'number' || !raw.hourStart) {
			throw new Error('invalid shape')
		}
		return raw
	} catch (e: unknown) {
		logger(Colors.yellow(`[validatorRewardHourlyReporter] state reset: ${(e as Error)?.message ?? e}`))
		const now = utcHourId(Math.floor(Date.now() / 1000))
		return { updatedAt: new Date().toISOString(), trackingHourId: now, lastReportedHourId: now - 1, hourStart: {} }
	}
}

function writeState(state: HourlyRewardReporterState): void {
	const file = resolveHourlyRewardStateFile()
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
			logger(Colors.yellow(`[validatorRewardHourlyReporter] deposit file read failed: ${(e as Error)?.message ?? e}`))
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

function computeHourlyEntries(
	validators: TrackedValidator[],
	hourId: number,
	start: Map<string, BalanceSnapshot>,
	end: Map<string, BalanceSnapshot>
): Array<{ nodeWallet: string; hourId: number; hourlyReward: bigint }> {
	const byBeneficiary = new Map<string, TrackedValidator[]>()
	for (const v of validators) {
		const key = v.beneficiary.toLowerCase()
		const list = byBeneficiary.get(key) ?? []
		list.push(v)
		byBeneficiary.set(key, list)
	}

	const entries: Array<{ nodeWallet: string; hourId: number; hourlyReward: bigint }> = []

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
		entries.push({ nodeWallet: v.nodeWallet, hourId, hourlyReward: reward })
	}

	return entries
}

async function submitHourlyReports(
	entries: Array<{ nodeWallet: string; hourId: number; hourlyReward: bigint }>
): Promise<void> {
	if (!entries.length) return
	const chunk = resolveReportChunkSize()
	for (let i = 0; i < entries.length; i += chunk) {
		const slice = entries.slice(i, i + chunk)
		if (reporterDryRun()) {
			logger(
				Colors.cyan(
					`[validatorRewardHourlyReporter] dry-run report ${slice.length} rows hour=${slice[0]?.hourId} sample=${slice[0]?.nodeWallet}`
				)
			)
			continue
		}
		const res = await validatorRewardReportHourly(
			slice.map((e) => ({
				nodeWallet: e.nodeWallet,
				hourId: e.hourId,
				hourlyReward: e.hourlyReward,
			}))
		)
		if (!res.ok) {
			throw new Error(res.error)
		}
		logger(
			Colors.green(
				`[validatorRewardHourlyReporter] reported ${res.count} node-hour rows tx=${res.txHash} hour=${slice[0]?.hourId}`
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
			logger(Colors.yellow('[validatorRewardHourlyReporter] skip: ValidatorDepositRedeem not configured'))
			return
		}
		const indexer = await resolveValidatorNodeRewardIndexerAddress()
		if (!indexer) {
			logger(Colors.yellow('[validatorRewardHourlyReporter] skip: ValidatorNodeRewardIndexer not configured'))
			return
		}

		const validators = await loadTrackedValidators(contract)
		if (!validators.length) {
			logger(Colors.yellow('[validatorRewardHourlyReporter] no active local validators to track'))
			return
		}

		const nowSec = Math.floor(Date.now() / 1000)
		const nowHour = utcHourId(nowSec)
		const state = readState()
		const endSnap = await snapshotValidators(validators)

		if (!Object.keys(state.hourStart).length) {
			const intoHour = secondsIntoUtcHour(nowSec)
			const grace = resolveBaselineGraceSec()
			if (intoHour > grace) {
				state.trackingHourId = nowHour + 1
				state.lastReportedHourId = Math.max(state.lastReportedHourId, nowHour)
				writeState(state)
				logger(
					Colors.cyan(
						`[validatorRewardHourlyReporter] mid-hour startup (t+${intoHour}s); defer baseline to UTC hour ${state.trackingHourId}`
					)
				)
				return
			}
			for (const [pk, snap] of endSnap.entries()) {
				state.hourStart[pk] = snap
			}
			state.trackingHourId = nowHour
			writeState(state)
			logger(Colors.cyan(`[validatorRewardHourlyReporter] UTC baseline ${endSnap.size} validators for hour ${nowHour}`))
			return
		}

		if (state.trackingHourId > nowHour) {
			writeState(state)
			return
		}

		const closeDeadlineSec = (state.trackingHourId + 1) * 3600 + resolveReportDelaySec()
		const readyToCloseTrackedHour = nowSec >= closeDeadlineSec && state.lastReportedHourId < state.trackingHourId

		if (readyToCloseTrackedHour) {
			const hourToReport = state.trackingHourId
			const startMap = new Map<string, BalanceSnapshot>()
			for (const [pk, snap] of Object.entries(state.hourStart)) startMap.set(pk, snap)

			const entries = computeHourlyEntries(validators, hourToReport, startMap, endSnap)
			if (entries.length) {
				await submitHourlyReports(entries)
			} else {
				logger(Colors.cyan(`[validatorRewardHourlyReporter] hour ${hourToReport}: zero measurable reward rows`))
			}
			state.lastReportedHourId = hourToReport

			if (nowHour > hourToReport + 1) {
				logger(
					Colors.yellow(
						`[validatorRewardHourlyReporter] skipped ${nowHour - hourToReport - 1} hour(s) while offline; rebaselining at hour ${nowHour}`
					)
				)
			}
			state.trackingHourId = nowHour
			state.hourStart = {}
			for (const [pk, snap] of endSnap.entries()) {
				state.hourStart[pk] = snap
			}
		}

		writeState(state)
	} catch (e: unknown) {
		logger(Colors.red('[validatorRewardHourlyReporter] tick failed:'), (e as Error)?.message ?? String(e))
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

/** CoNET validator-node listener: measure hourly CL+EL CNET reward and report via {validatorRewardReportHourly}. */
export function startValidatorRewardHourlyReporter(): void {
	if (reporterStarted) return
	reporterStarted = true
	if (!reporterEnabled()) {
		logger(Colors.yellow('[validatorRewardHourlyReporter] disabled (set CONET_VALIDATOR_HOURLY_REWARD_REPORT=1)'))
		return
	}
	const nodeIp = resolveValidatorNodeIp()
	logger(
		Colors.cyan(
			`[validatorRewardHourlyReporter] starting nodeIp=${nodeIp || '?'} beacon=${resolveBeaconRestUrl()} tick=${resolveReporterTickMs()}ms`
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
