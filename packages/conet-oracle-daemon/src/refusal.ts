/** A quote was not signed. Callers must not report this as success. */
export class QuoteRefusal extends Error {
	constructor(
		readonly reason: string,
		message: string,
	) {
		super(message)
		this.name = 'QuoteRefusal'
	}
}

/** The signer socket refused or failed. One attempt only; do not retry. */
export class SignerCallError extends Error {
	readonly reportedSuccess = false

	constructor(
		readonly code: number,
		message: string,
	) {
		super(message)
		this.name = 'SignerCallError'
	}
}
