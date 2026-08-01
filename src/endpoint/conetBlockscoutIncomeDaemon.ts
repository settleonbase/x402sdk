import { ethers } from 'ethers'
import Colors from 'colors/safe'
import { CONET_VALIDATOR_DEPOSIT_REDEEM, CONET_VALIDATOR_DEPOSIT_REDEEM_DEPLOY_BLOCK } from '../chainAddresses'
import { logger } from '../logger'
import {
	type BlockscoutLogsPageParams,
	fetchBlockscoutAddressLogsPage,
	parseNodeRewardSettledFromBlockscoutLog,
} from './conetBlockscoutClient'

const TICK_MS = Number(process.env.CONET_BLOCKSCOUT_INCOME_DAEMON_MS ?? 60_000)
const MAX_PAGES_PER_TICK = Number(process.env.CONET_BLOCKSCOUT_INCOME_PAGES_PER_TICK ?? 8)
const ENABLED =
	process.env.CONET_BLOCKSCOUT_INCOME_DAEMON !== '0' &&
	process.env.CONET_BLOCKSCOUT_INCOME_DAEMON !== 'false'

/** beneficiary lower → guardianId → cumulative CL wei from NodeRewardSettled logs */
const guardianClByBeneficiary = new Map<string, Map<number, bigint>>()

/** eventKey lower → true (dedupe across pages / head refresh) */
const seenEventKeys = new Set<string>()

let backfillCursor: BlockscoutLogsPageParams | null | undefined = undefined
let backfillComplete = false
let daemonTimer: ReturnType<typeof setTimeout> | undefined
let tickInFlight = false
let lastTickAt = 0
let lastError: string | null = null

function beneficiaryKey(addr: string): string {
	try {
		return ethers.getAddress(addr).toLowerCase()
	} catch {
		return addr.toLowerCase()
	}
}

function getOrCreateBeneficiaryMap(key: string): Map<number, bigint> {
	let m = guardianClByBeneficiary.get(key)
	if (!m) {
		m = new Map()
		guardianClByBeneficiary.set(key, m)
	}
	return m
}

function ingestNodeRewardSettled(
	guardianId: number,
	beneficiary: string,
	amount: bigint,
	eventKey: string,
): void {
	const dedupeKey = eventKey.toLowerCase()
	if (dedupeKey && seenEventKeys.has(dedupeKey)) return
	if (dedupeKey) seenEventKeys.add(dedupeKey)
	const benKey = beneficiaryKey(beneficiary)
	const map = getOrCreateBeneficiaryMap(benKey)
	map.set(guardianId, (map.get(guardianId) ?? 0n) + amount)
}

function ingestLogsPage(items: ReturnType<typeof fetchBlockscoutAddressLogsPage> extends Promise<infer T>
	? T extends { items: infer I }
		? I
		: never
	: never): number {
	let count = 0
	for (const log of items) {
		const parsed = parseNodeRewardSettledFromBlockscoutLog(log)
		if (!parsed) continue
		ingestNodeRewardSettled(parsed.guardianId, parsed.beneficiary, parsed.amount, parsed.eventKey)
		count += 1
	}
	return count
}

async function fetchAndIngestPage(pageParams?: BlockscoutLogsPageParams): Promise<{
	next: BlockscoutLogsPageParams | null
	ingested: number
}> {
	const page = await fetchBlockscoutAddressLogsPage(CONET_VALIDATOR_DEPOSIT_REDEEM, pageParams)
	const ingested = ingestLogsPage(page.items)
	return { next: page.next_page_params, ingested }
}

async function runDaemonTick(): Promise<void> {
	if (tickInFlight) return
	tickInFlight = true
	lastTickAt = Date.now()
	try {
		let pages = 0
		if (!backfillComplete) {
			while (pages < MAX_PAGES_PER_TICK) {
				const { next, ingested } = await fetchAndIngestPage(backfillCursor ?? undefined)
				pages += 1
				backfillCursor = next
				if (!next) {
					backfillComplete = true
					logger(
						Colors.green(
							`[conetBlockscoutIncomeDaemon] backfill complete; beneficiaries=${guardianClByBeneficiary.size} events=${seenEventKeys.size} lastPageIngested=${ingested}`,
						),
					)
					break
				}
			}
			if (!backfillComplete) {
				logger(
					Colors.cyan(
						`[conetBlockscoutIncomeDaemon] backfill progress pages=${pages} beneficiaries=${guardianClByBeneficiary.size} events=${seenEventKeys.size}`,
					),
				)
			}
		} else {
			// Head refresh: newest page only (Blockscout sorts desc).
			const { ingested } = await fetchAndIngestPage(undefined)
			if (ingested > 0) {
				logger(
					Colors.green(
						`[conetBlockscoutIncomeDaemon] head refresh ingested=${ingested} beneficiaries=${guardianClByBeneficiary.size}`,
					),
				)
			}
		}
		lastError = null
	} catch (error) {
		lastError = error instanceof Error ? error.message : String(error)
		logger(Colors.yellow(`[conetBlockscoutIncomeDaemon] tick failed: ${lastError}`))
	} finally {
		tickInFlight = false
		scheduleDaemonTick()
	}
}

function scheduleDaemonTick(): void {
	if (!ENABLED) return
	if (daemonTimer !== undefined) clearTimeout(daemonTimer)
	daemonTimer = setTimeout(() => {
		void runDaemonTick()
	}, TICK_MS)
}

export function startConetBlockscoutIncomeDaemon(): void {
	if (!ENABLED) {
		logger(Colors.yellow('[conetBlockscoutIncomeDaemon] disabled (set CONET_BLOCKSCOUT_INCOME_DAEMON=0 to suppress)'))
		return
	}
	logger(
		Colors.cyan(
			`[conetBlockscoutIncomeDaemon] starting contract=${CONET_VALIDATOR_DEPOSIT_REDEEM} deployFloor=${CONET_VALIDATOR_DEPOSIT_REDEEM_DEPLOY_BLOCK} tickMs=${TICK_MS}`,
		),
	)
	backfillCursor = undefined
	backfillComplete = false
	void runDaemonTick()
}

export function getBeneficiaryGuardianClPaidMap(beneficiary: string): Map<number, bigint> {
	const key = beneficiaryKey(beneficiary)
	const cached = guardianClByBeneficiary.get(key)
	return cached ? new Map(cached) : new Map()
}

export function getConetBlockscoutIncomeDaemonStatus(): {
	enabled: boolean
	backfillComplete: boolean
	beneficiaryCount: number
	eventCount: number
	lastTickAt: number
	lastError: string | null
} {
	return {
		enabled: ENABLED,
		backfillComplete,
		beneficiaryCount: guardianClByBeneficiary.size,
		eventCount: seenEventKeys.size,
		lastTickAt,
		lastError,
	}
}
