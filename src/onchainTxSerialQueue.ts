import { ethers } from 'ethers'
import Colors from 'colors/safe'
import { logger } from './logger'

/**
 * FIFO on-chain tx queue per signer lane (nonce isolation).
 * See `.cursor/rules/beamio-onchain-tx-serial-queue.mdc`.
 */
type OnchainTxQueueItem = {
	label: string
	run: () => Promise<unknown>
	resolve: (value: unknown) => void
	reject: (reason: unknown) => void
	enqueuedAt: number
}

class OnchainTxSerialLane {
	private readonly queue: OnchainTxQueueItem[] = []
	private inFlight = false
	currentLabel: string | undefined

	constructor(
		readonly laneKey: string,
		private readonly logPrefix: string
	) {}

	depth(): number {
		return this.queue.length + (this.inFlight ? 1 : 0)
	}

	enqueue<T>(label: string, fn: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const waiting = this.queue.length
			this.queue.push({
				label,
				run: fn as () => Promise<unknown>,
				resolve: resolve as (value: unknown) => void,
				reject,
				enqueuedAt: Date.now(),
			})
			if (waiting > 0 || this.inFlight) {
				logger(
					Colors.yellow(
						`${this.logPrefix} tx queue +${label} lane=${this.laneKey} waiting=${waiting + (this.inFlight ? 1 : 0)}`
					)
				)
			}
			void this.drain()
		})
	}

	private async drain(): Promise<void> {
		if (this.inFlight) return
		this.inFlight = true
		while (this.queue.length > 0) {
			const item = this.queue.shift()!
			const waitMs = Date.now() - item.enqueuedAt
			const behind = this.queue.length
			this.currentLabel = item.label
			if (waitMs > 500 || behind > 0) {
				logger(
					Colors.cyan(
						`${this.logPrefix} tx start ${item.label} lane=${this.laneKey} (queued ${waitMs}ms; ${behind} behind)`
					)
				)
			}
			try {
				const result = await item.run()
				item.resolve(result)
			} catch (e) {
				item.reject(e)
			} finally {
				this.currentLabel = undefined
			}
		}
		this.inFlight = false
	}

	async waitIdle(maxWaitMs = 30 * 60 * 1000): Promise<void> {
		const started = Date.now()
		while (this.depth() > 0) {
			if (Date.now() - started >= maxWaitMs) {
				logger(
					Colors.red(
						`${this.logPrefix} tx queue drain timeout lane=${this.laneKey} (${maxWaitMs}ms); inFlight=${this.currentLabel ?? 'none'} pending=${this.queue.length}`
					)
				)
				return
			}
			await new Promise<void>((r) => setTimeout(r, 250))
		}
	}
}

const lanes = new Map<string, OnchainTxSerialLane>()

function normalizeLaneKey(laneKey: string): string {
	return laneKey.trim().toLowerCase()
}

function getOrCreateLane(laneKey: string, logPrefix: string): OnchainTxSerialLane {
	const key = normalizeLaneKey(laneKey)
	let lane = lanes.get(key)
	if (!lane) {
		lane = new OnchainTxSerialLane(key, logPrefix)
		lanes.set(key, lane)
	}
	return lane
}

/** Enqueue on-chain write work on a signer lane; tasks run FIFO, one at a time per lane. */
export function enqueueOnchainTxWork<T>(
	laneKey: string,
	label: string,
	fn: () => Promise<T>,
	logPrefix = '[onchainTxQueue]'
): Promise<T> {
	return getOrCreateLane(laneKey, logPrefix).enqueue(label, fn)
}

/** Wait until a lane has no pending or in-flight tx work (graceful shutdown). */
export async function waitForOnchainTxQueue(laneKey: string, maxWaitMs = 30 * 60 * 1000): Promise<void> {
	const lane = lanes.get(normalizeLaneKey(laneKey))
	if (!lane) return
	await lane.waitIdle(maxWaitMs)
}

/** Wait until every open lane is idle. */
export async function waitForAllOnchainTxQueues(maxWaitMs = 30 * 60 * 1000): Promise<void> {
	for (const lane of lanes.values()) {
		await lane.waitIdle(maxWaitMs)
	}
}

/**
 * Legacy shared lane name (kept for callers that have not split yet).
 * Prefer {@link CONET_VALIDATOR_REDEEM_WORKFLOW_ONCHAIN_LANE} vs {@link CONET_VALIDATOR_CL_PAYOUT_ONCHAIN_LANE}.
 */
export const CONET_VALIDATOR_NODE_ONCHAIN_LANE = 'conet-validator-node:onchain'

/**
 * Claim / fee-recipient / full-exit workflow (redeem admin + Prysm helper scripts).
 * Isolated from CL skim so long settleNodeRewards batches cannot starve claim jobs.
 */
export const CONET_VALIDATOR_REDEEM_WORKFLOW_ONCHAIN_LANE = 'conet-validator-node:redeem-workflow'

/**
 * CL skim settleNodeRewards / withdrawNative payout reporter only.
 */
export const CONET_VALIDATOR_CL_PAYOUT_ONCHAIN_LANE = 'conet-validator-node:cl-payout'

/** Lane key for a single hot-wallet signer (checksum-agnostic). */
export function onchainTxLaneForSigner(signerAddress: string): string {
	return `eoa:${ethers.getAddress(signerAddress).toLowerCase()}`
}
