/**
 * Per-wallet gas-shortage alarm of the Lab pools (second line of defence; the first is the hourly balance check and manual top-up). The daemon does not read a pool wallet's native balance. A wallet without gas
 * fails at the SEND (signer or chain refuses): the lifecycle keeps the batch as in-flight ("pending") and the wallet retries the same record every pass. This tracker turns that into ONE alert line per wallet per minute at most:
 *   - the send failed `threshold` (default 3) passes in a row, or
 *   - the failure text reads like a balance shortage (INSUFFICIENT_RE): at once.
 * It never isolates the wallet and never moves the batch to another wallet. Pure, no I/O, node built-ins only.
 */
export const INSUFFICIENT_RE = /insufficient funds|insufficient balance|insufficient native|gas required exceeds|not enough (gas|funds|balance|native)|exceeds (the )?(account )?balance|lack(s)? of (gas|funds)/i

export class GasAlertTracker {
	private consecutive = 0
	private lastAlertAt: number | undefined
	constructor(
		private readonly threshold = 3,
		private readonly minIntervalMs = 60_000
	) {}
	get streak(): number {
		return this.consecutive
	}
	/** A send failed (message of the error). Returns the alert text to log, or undefined. */
	onSendFailure(message: string, now: number): { text: string; shortage: boolean } | undefined {
		this.consecutive++
		const shortage = INSUFFICIENT_RE.test(message)
		if (!shortage && this.consecutive < this.threshold) return undefined
		if (this.lastAlertAt !== undefined && now - this.lastAlertAt < this.minIntervalMs) return undefined
		this.lastAlertAt = now
		return { text: `send failed ${this.consecutive} pass(es) in a row${shortage ? ' and the error reads like a balance shortage' : ''}: ${message.slice(0, 160)}`, shortage }
	}
	/** The send went through, or the batch settled: the streak ends. */
	onOk(): void {
		this.consecutive = 0
	}
}
