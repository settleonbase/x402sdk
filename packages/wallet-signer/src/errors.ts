/** JSON-RPC error codes returned by wallet-signer. Clients map these to retry / no-retry. */
export const ErrorCode = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL: -32603,
	/** Service is running but the vault is locked. Retry later. */
	LOCKED: -32001,
	/** Client certificate / token not accepted, or client disabled. */
	UNAUTHORIZED: -32002,
	/** Request does not match the client's policy. Do not retry. */
	POLICY_DENIED: -32003,
	/** Rate limit or daily budget hit. Retry later. */
	RATE_LIMITED: -32004,
	/** Every key of the array is busy. Retry later. */
	NO_IDLE_KEY: -32005,
	/** Network gas price is above the policy cap. Retry later. */
	GAS_PRICE_TOO_HIGH: -32006,
	/** eth_call simulation reverted; nothing was broadcast. */
	EXECUTION_REVERTED: -32007,
	NOT_FOUND: -32009,
	/** Registry on disk does not match the mnemonic. Service refuses to sign. */
	REGISTRY_MISMATCH: -32010,
	/** RPC node unreachable or broadcast failed. Retry later. */
	UPSTREAM: -32011,
} as const

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode]

/** Codes a client may retry with the same idempotency key. */
export const RETRYABLE_CODES: ReadonlySet<number> = new Set([
	ErrorCode.LOCKED,
	ErrorCode.RATE_LIMITED,
	ErrorCode.NO_IDLE_KEY,
	ErrorCode.GAS_PRICE_TOO_HIGH,
	ErrorCode.UPSTREAM,
	ErrorCode.REGISTRY_MISMATCH,
])

export class SignerError extends Error {
	constructor(
		public readonly code: number,
		message: string,
		public readonly data?: unknown,
	) {
		super(message)
		this.name = 'SignerError'
	}
}

export function denied(message: string, data?: unknown): SignerError {
	return new SignerError(ErrorCode.POLICY_DENIED, message, data)
}
