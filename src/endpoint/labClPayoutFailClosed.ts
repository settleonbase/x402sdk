/**
 * Fail-closed latch for the Lab CL payout daemon.
 *
 * Once a state write fails, memory may be ahead of disk. Payments already sent (or about to be
 * sent) may not be recorded. A later payment, or a restart from the older disk state, could repeat
 * one. So after the first persist failure the process must not pay again. The latch is never
 * cleared in-process. Only the first failure reason is kept. Every trip writes an ALERT line.
 */
export class LabPayoutFailClosedGate {
	private reason: string | null = null

	constructor(private readonly alert: (message: string) => void) {}

	get tripped(): boolean {
		return this.reason !== null
	}

	get tripReason(): string | null {
		return this.reason
	}

	trip(where: string, err: unknown): void {
		const message = err instanceof Error ? err.message : String(err)
		if (this.reason === null) this.reason = `${where}: ${message}`
		this.alert(
			`ALERT fail-closed (${this.reason}). No further payments in this process. ` +
				'Stop the daemon, check the state dir, then restart. Do not run an old binary on this state.'
		)
	}

	/** Throws when the latch is set. Call immediately before any payment is sent. */
	assertOpen(action: string): void {
		if (this.reason !== null) {
			throw new Error(`fail-closed (${this.reason}); refusing ${action}`)
		}
	}
}
