import { loadLabDenyList } from './labDenyList'
import { request as httpRequest } from 'node:http'
import { ethers } from 'ethers'

/**
 * Lab CL skim → LabMiningPoolPayoutExecutor via dedicated unix socket.
 * Fail-closed: no private-key path, no VDR withdrawNative, no Settle_ConetPool.
 *
 * Live path (the running daemon): withdrawNative(pool, amount) on ValidatorDepositRedeem.
 * Live signer allowlist: withdrawNative only (`LAB_LIVE_SIGNER_ALLOWLIST_SELECTORS`). payoutBatch is a legacy
 * fixture path that the daemon never calls; labPayoutSignerSendOnce refuses it unless the caller opts in.
 * On-chain: legacy payout(uint256) 0xe1152343 **always reverts** (`UsePayoutBatch`) —
 * no owner toggle. Signer still refuses 0xe1152343 unless allowLegacyPayout (fixture
 * encode/refuse tests only); even with ALLOW_LEGACY=1, chain will not spend.
 *
 * Power-loss / ACK-lost: durable idempotencyKey + request fingerprint; recover via
 * signer_getTransaction (original broadcast hash — never RPC mock success).
 *
 * Env (required for live payout):
 *   CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_SOCKET  e.g. <lab-payout-socket>
 *   CONET_LAB_MINING_POOL_CL_PAYOUT_KEY_ARRAY      e.g. lab_mining_pool_payout
 *   CONET_LAB_MINING_POOL_PAYOUT_EXECUTOR          deployed LabMiningPoolPayoutExecutor address
 *
 * Forbidden reuse (Claim/VDR sockets, key arrays, disabled admin addresses) comes from the private deny list
 * (labDenyList.ts, CONET_LAB_DENY_LIST_FILE). The list is required; without it every check refuses.
 */

const PAYOUT_IFACE = new ethers.Interface(['function payout(uint256 amount)'])
const PAYOUT_BATCH_IFACE = new ethers.Interface([
	'function payoutBatch(bytes32 batchId, bytes32[] calldata eventKeys, uint256 amount)',
])
const WITHDRAW_NATIVE_IFACE = new ethers.Interface([
	'function withdrawNative(address to, uint256 amount)',
])

export const LAB_PAYOUT_CHAIN_ID = 224422 as const
/** Legacy fixture-only selector — MUST NOT appear in live signer allowlist. */
export const PAYOUT_SELECTOR = PAYOUT_IFACE.getFunction('payout')!.selector.toLowerCase()
/** keccak256("payoutBatch(bytes32,bytes32[],uint256)")[:4] — canonical live. */
export const PAYOUT_BATCH_SELECTOR = PAYOUT_BATCH_IFACE.getFunction('payoutBatch')!.selector.toLowerCase()
export const LAB_PAYOUT_BATCH_SELECTOR = PAYOUT_BATCH_SELECTOR
/** Running legacy call. Production Lab daemon signs this, not payoutBatch. */
export const WITHDRAW_NATIVE_SELECTOR = WITHDRAW_NATIVE_IFACE.getFunction('withdrawNative')!.selector.toLowerCase()
/**
 * Live Lab wallet-signer allowlist (OWNER-PACK / LIMITED-EXECUTOR).
 * Only payoutBatch — never legacy payout(uint256) alone.
 */
export const LAB_LIVE_SIGNER_ALLOWLIST_SELECTORS = [WITHDRAW_NATIVE_SELECTOR] as const

export function isLabLiveAllowlistedSelector(selector: string): boolean {
	return LAB_LIVE_SIGNER_ALLOWLIST_SELECTORS.includes(
		selector.toLowerCase() as (typeof LAB_LIVE_SIGNER_ALLOWLIST_SELECTORS)[number]
	)
}

export type LabPayoutSignerConfig = {
	socketPath: string
	keyArray: string
	executor: string
}

export type LabPayoutSignerTx = {
	keyArray: string
	chainId: typeof LAB_PAYOUT_CHAIN_ID
	to: string
	data: string
	value: '0'
	gasLimit: string
	idempotencyKey: string
}

type RpcError = { code?: number; message?: string }
type RpcBody = {
	result?: { hash?: unknown; status?: unknown; found?: unknown; duplicate?: unknown }
	error?: RpcError
}

export function readLabPayoutSignerConfig(
	env: NodeJS.ProcessEnv = process.env
): LabPayoutSignerConfig | null {
	const socketPath = env.CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_SOCKET?.trim() ?? ''
	const keyArray = env.CONET_LAB_MINING_POOL_CL_PAYOUT_KEY_ARRAY?.trim() ?? ''
	const executorRaw = env.CONET_LAB_MINING_POOL_PAYOUT_EXECUTOR?.trim() ?? ''
	if (!socketPath || !keyArray || !executorRaw) return null
	const deny = loadLabDenyList()
	if (deny.sockets.includes(socketPath)) throw new Error('lab payout refuses a deny-listed socket')
	if (deny.keyArrays.includes(keyArray)) throw new Error('lab payout refuses a deny-listed key array')
	let executor: string
	try {
		executor = ethers.getAddress(executorRaw)
	} catch {
		throw new Error('CONET_LAB_MINING_POOL_PAYOUT_EXECUTOR is not a valid address')
	}
	if (executor === ethers.ZeroAddress) {
		throw new Error('CONET_LAB_MINING_POOL_PAYOUT_EXECUTOR must not be zero')
	}
	return { socketPath, keyArray, executor }
}

export function encodeLabExecutorPayout(amount: bigint): string {
	if (amount <= 0n) throw new Error('payout amount must be > 0')
	const data = PAYOUT_IFACE.encodeFunctionData('payout', [amount])
	if (!data.toLowerCase().startsWith(PAYOUT_SELECTOR)) {
		throw new Error('payout selector drifted')
	}
	return data
}

export type LabPayoutBatchParams = {
	batchId: string
	eventKeys: string[]
	amount: bigint
}

/** Stable batchId from sorted event keys (same keys → same batchId across restarts). */
export function labBatchIdFromEventKeys(eventKeys: string[]): string {
	const sorted = [...eventKeys].map((k) => k.toLowerCase()).sort()
	return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({ v: 1, eventKeys: sorted })))
}

export function labPayoutRequestFingerprint(input: {
	executor: string
	batchId: string
	eventKeys: string[]
	amount: bigint
	chainId?: number
}): string {
	const payload = {
		v: 1 as const,
		chainId: input.chainId ?? LAB_PAYOUT_CHAIN_ID,
		executor: ethers.getAddress(input.executor).toLowerCase(),
		batchId: input.batchId.toLowerCase(),
		eventKeys: [...input.eventKeys].map((k) => k.toLowerCase()).sort(),
		amountWei: input.amount.toString(),
	}
	return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(payload)))
}

export function labPayoutBatchIdempotencyKey(fingerprint: string): string {
	const fp = fingerprint.startsWith('0x') ? fingerprint.slice(2) : fingerprint
	return `lab-executor-payoutBatch:${fp.toLowerCase()}`
}

export function encodeLabPayoutBatchCalldata(params: LabPayoutBatchParams): string {
	if (params.amount <= 0n) throw new Error('payoutBatch amount must be > 0')
	if (!params.eventKeys.length) throw new Error('payoutBatch requires eventKeys')
	const batchId = ethers.hexlify(ethers.getBytes(params.batchId))
	const eventKeys = params.eventKeys.map((k) => ethers.hexlify(ethers.getBytes(k)))
	const data = PAYOUT_BATCH_IFACE.encodeFunctionData('payoutBatch', [
		batchId,
		eventKeys,
		params.amount,
	])
	if (!data.toLowerCase().startsWith(PAYOUT_BATCH_SELECTOR)) {
		throw new Error(`payoutBatch selector drifted: ${data.slice(0, 10)}`)
	}
	return data
}

/**
 * Legacy amount-only path. LabMiningPoolPayoutExecutor.payout(uint256) has NO on-chain batch key.
 * Production Lab daemon must use buildLabPayoutBatchSignerTx / sendConfiguredLabExecutorPayoutBatch.
 */
export function buildLabPayoutSignerTx(input: {
	keyArray: string
	executor: string
	amount: bigint
	gasLimit: number
	/** Optional off-chain batch fingerprint (eventKeys hash); not enforced on-chain. */
	batchFingerprint?: string
}): LabPayoutSignerTx {
	if (!input.keyArray.trim()) throw new Error('lab payout signer keyArray is not configured')
	if (!Number.isInteger(input.gasLimit) || input.gasLimit < 1) {
		throw new Error('gasLimit must be a positive integer')
	}
	const data = encodeLabExecutorPayout(input.amount)
	const fp =
		input.batchFingerprint?.trim() ||
		ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [input.amount]))
	return {
		keyArray: input.keyArray,
		chainId: LAB_PAYOUT_CHAIN_ID,
		to: ethers.getAddress(input.executor),
		data,
		value: '0',
		gasLimit: String(input.gasLimit),
		idempotencyKey: `lab-executor-payout:${fp}`,
	}
}

/** Canonical batch path — durable idempotencyKey from request fingerprint. */
export function buildLabPayoutBatchSignerTx(input: {
	keyArray: string
	executor: string
	batchId: string
	eventKeys: string[]
	amount: bigint
	gasLimit: number
}): LabPayoutSignerTx & { requestFingerprint: string } {
	if (!input.keyArray.trim()) throw new Error('lab payout signer keyArray is not configured')
	if (!Number.isInteger(input.gasLimit) || input.gasLimit < 1) {
		throw new Error('gasLimit must be a positive integer')
	}
	const data = encodeLabPayoutBatchCalldata({
		batchId: input.batchId,
		eventKeys: input.eventKeys,
		amount: input.amount,
	})
	const requestFingerprint = labPayoutRequestFingerprint({
		executor: input.executor,
		batchId: input.batchId,
		eventKeys: input.eventKeys,
		amount: input.amount,
	})
	return {
		keyArray: input.keyArray,
		chainId: LAB_PAYOUT_CHAIN_ID,
		to: ethers.getAddress(input.executor),
		data,
		value: '0',
		gasLimit: String(input.gasLimit),
		idempotencyKey: labPayoutBatchIdempotencyKey(requestFingerprint),
		requestFingerprint,
	}
}

function labSignerRpc(
	socketPath: string,
	method: string,
	params: unknown
): Promise<RpcBody['result']> {
	if (!socketPath.trim()) return Promise.reject(new Error('lab payout signer socket is not configured'))
	if (loadLabDenyList().sockets.includes(socketPath)) {
		return Promise.reject(new Error('lab payout refuses a deny-listed socket'))
	}
	const body = JSON.stringify({
		jsonrpc: '2.0',
		id: 1,
		method,
		params,
	})
	return new Promise((resolve, reject) => {
		let settled = false
		const fail = (message: string) => {
			if (settled) return
			settled = true
			reject(new Error(message))
		}
		const req = httpRequest(
			{
				socketPath,
				path: '/rpc',
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'content-length': Buffer.byteLength(body),
				},
			},
			(res) => {
				const chunks: Buffer[] = []
				res.on('data', (chunk: Buffer) => chunks.push(chunk))
				res.on('end', () => {
					let parsed: RpcBody
					try {
						parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcBody
					} catch {
						fail('signer response was not JSON')
						return
					}
					if (parsed.error) {
						fail(parsed.error.message || 'signer refused')
						return
					}
					if (settled) return
					settled = true
					resolve(parsed.result)
				})
			}
		)
		req.setTimeout(60_000, () => {
			req.destroy()
			fail('signer socket timed out')
		})
		req.on('error', (err: NodeJS.ErrnoException) => {
			fail(`signer socket failed: ${err.message}`)
		})
		req.end(body)
	})
}

export type LabPayoutSignerSendOnceOpts = {
	/** Legacy payoutBatch fixture only. Set by sendConfiguredLabExecutorPayoutBatch, which the daemon does not call. */
	allowLegacyBatchFixture?: boolean
	/**
	 * Fixture / migration only. Live callers must omit this (default refuses 0xe1152343).
	 * sendConfiguredLabExecutorPayout still also requires CONET_LAB_MINING_POOL_ALLOW_LEGACY_PAYOUT=1.
	 */
	allowLegacyPayout?: boolean
}

export function labPayoutSignerSendOnce(
	tx: LabPayoutSignerTx,
	socketPath: string,
	opts?: LabPayoutSignerSendOnceOpts
): Promise<{ hash: string; duplicate?: boolean }> {
	if (tx.value !== '0') return Promise.reject(new Error('native value must be 0'))
	if (tx.chainId !== LAB_PAYOUT_CHAIN_ID) return Promise.reject(new Error('chainId must be 224422'))
	const sel = tx.data.slice(0, 10).toLowerCase()
	if (sel === WITHDRAW_NATIVE_SELECTOR) {
		// The live daemon call (LAB_LIVE_SIGNER_ALLOWLIST_SELECTORS).
	} else if (sel === PAYOUT_BATCH_SELECTOR && opts?.allowLegacyBatchFixture === true) {
		// Legacy batch fixture only. The daemon never sends payoutBatch.
	} else if (sel === PAYOUT_BATCH_SELECTOR) {
		return Promise.reject(
			new Error(`payoutBatch is not on the live allowlist (${LAB_LIVE_SIGNER_ALLOWLIST_SELECTORS.join(',')})`)
		)
	} else if (sel === PAYOUT_SELECTOR && opts?.allowLegacyPayout === true) {
		// fixture opt-in only
	} else if (sel === PAYOUT_SELECTOR) {
		return Promise.reject(
			new Error(
				`refusing legacy payout(uint256) selector ${sel}; live allowlist is payoutBatch only (${PAYOUT_BATCH_SELECTOR})`
			)
		)
	} else {
		return Promise.reject(new Error(`refusing selector ${sel}`))
	}
	return labSignerRpc(socketPath, 'signer_sendTransaction', tx).then((result) => {
		const hash = result?.hash
		if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
			throw new Error('signer response had no transaction hash')
		}
		return { hash, duplicate: Boolean(result?.duplicate) }
	})
}

/**
 * Look up prior broadcast by durable idempotencyKey (ACK-lost after broadcast recovery).
 * Returns original hash when signer journal still holds the send — never invents success.
 */
export async function recoverLabPayoutHashByIdempotencyKey(
	socketPath: string,
	idempotencyKey: string
): Promise<{ hash: string; status?: string } | null> {
	try {
		const row = await labSignerRpc(socketPath, 'signer_getTransaction', { idempotencyKey })
		const hash = typeof row?.hash === 'string' ? row.hash.trim() : ''
		if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return null
		return {
			hash,
			status: typeof row?.status === 'string' ? row.status : undefined,
		}
	} catch {
		return null
	}
}

/**
 * Legacy amount-only send. Refused unless env CONET_LAB_MINING_POOL_ALLOW_LEGACY_PAYOUT=1.
 * Production Lab daemon must use sendConfiguredLabExecutorPayoutBatch.
 */
export async function sendConfiguredLabExecutorPayout(input: {
	amount: bigint
	gasLimit: number
	batchFingerprint?: string
	env?: NodeJS.ProcessEnv
}): Promise<{ hash: string; executor: string }> {
	const env = input.env ?? process.env
	if (env.CONET_LAB_MINING_POOL_ALLOW_LEGACY_PAYOUT?.trim() !== '1') {
		throw new Error(
			'legacy payout(uint256) disabled for live; use sendConfiguredLabExecutorPayoutBatch (set CONET_LAB_MINING_POOL_ALLOW_LEGACY_PAYOUT=1 only for fixtures)'
		)
	}
	const config = readLabPayoutSignerConfig(env)
	if (!config) {
		throw new Error(
			'lab payout signer socket, keyArray, or CONET_LAB_MINING_POOL_PAYOUT_EXECUTOR is not configured'
		)
	}
	const tx = buildLabPayoutSignerTx({
		keyArray: config.keyArray,
		executor: config.executor,
		amount: input.amount,
		gasLimit: input.gasLimit,
		batchFingerprint: input.batchFingerprint,
	})
	const { hash } = await labPayoutSignerSendOnce(tx, config.socketPath, { allowLegacyPayout: true })
	return { hash, executor: config.executor }
}

export type LabWithdrawSignerConfig = {
	socketPath: string
	keyArray: string
}

/** Socket + derived array only. Does not take a payout-executor address or a hot key. */
export function readLabWithdrawSignerConfig(
	env: NodeJS.ProcessEnv = process.env
): LabWithdrawSignerConfig | null {
	const socketPath = env.CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_SOCKET?.trim() ?? ''
	const keyArray = env.CONET_LAB_MINING_POOL_CL_PAYOUT_KEY_ARRAY?.trim() ?? ''
	if (!socketPath || !keyArray) return null
	const deny = loadLabDenyList()
	if (deny.sockets.includes(socketPath)) throw new Error('lab withdrawNative refuses a deny-listed socket')
	if (deny.keyArrays.includes(keyArray)) throw new Error('lab withdrawNative refuses a deny-listed key array')
	return { socketPath, keyArray }
}

/**
 * The only payee withdrawNative may send to (B-4). Source: deployments/conet-lab-mining-pool-pubkeys.json
 * "miningPool" (the same value the reporter used as its default). Checksum verified. The manifest and
 * env cannot override it. Changing it is a code change that needs its own review.
 */
export const LAB_MINING_POOL_FIXED = ethers.getAddress('0x32bE583C8e778FFfC5107BF34820c2B225336201')

/** Throws unless pool is the fixed Lab mining pool (any letter case). Returns the checksummed address. */
export function assertFixedLabMiningPool(pool: string): string {
	let checksummed: string
	try {
		checksummed = ethers.getAddress(String(pool ?? '').trim())
	} catch {
		throw new Error('lab withdrawNative refuses a pool that is not a valid address')
	}
	if (checksummed !== LAB_MINING_POOL_FIXED) {
		throw new Error(`lab withdrawNative refuses pool ${checksummed}; only the fixed Lab mining pool is allowed`)
	}
	return checksummed
}

/**
 * Reporter-side pool resolution. A manifest or env value is accepted only when it equals the fixed pool.
 * Any other value is refused. Leaving both unset yields the fixed pool.
 */
export function resolveFixedLabMiningPool(sources: { manifestPool?: string; envPool?: string }): string {
	const manifest = sources.manifestPool?.trim()
	if (manifest) {
		try {
			assertFixedLabMiningPool(manifest)
		} catch (e) {
			throw new Error(`manifest miningPool: ${e instanceof Error ? e.message : String(e)}`)
		}
	}
	const env = sources.envPool?.trim()
	if (env) {
		try {
			assertFixedLabMiningPool(env)
		} catch (e) {
			throw new Error(`CONET_LAB_MINING_POOL_ADDRESS: ${e instanceof Error ? e.message : String(e)}`)
		}
	}
	return LAB_MINING_POOL_FIXED
}

export function encodeLabWithdrawNative(pool: string, amount: bigint): string {
	if (amount <= 0n) throw new Error('withdrawNative amount must be > 0')
	const data = WITHDRAW_NATIVE_IFACE.encodeFunctionData('withdrawNative', [pool, amount])
	if (!data.toLowerCase().startsWith(WITHDRAW_NATIVE_SELECTOR)) {
		throw new Error('withdrawNative selector drifted')
	}
	return data
}

/** Durable idempotency key for a withdrawNative request. Same fingerprint, same key. */
export function labWithdrawIdempotencyKey(requestFingerprint: string): string {
	return `lab-withdrawNative:${requestFingerprint.slice(2).toLowerCase()}`
}

export function labWithdrawFingerprint(input: {
	redeem: string
	pool: string
	amount: bigint
	eventKeys: string[]
}): string {
	const payload = {
		v: 1 as const,
		chainId: LAB_PAYOUT_CHAIN_ID,
		redeem: ethers.getAddress(input.redeem).toLowerCase(),
		pool: ethers.getAddress(input.pool).toLowerCase(),
		amountWei: input.amount.toString(),
		eventKeys: [...input.eventKeys].map((k) => k.toLowerCase()).sort(),
	}
	return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(payload)))
}

export function buildLabWithdrawNativeSignerTx(input: {
	keyArray: string
	redeem: string
	pool: string
	amount: bigint
	eventKeys: string[]
	gasLimit: number
}): LabPayoutSignerTx & { requestFingerprint: string } {
	const pool = assertFixedLabMiningPool(input.pool)
	if (!input.keyArray.trim()) throw new Error('lab withdraw signer keyArray is not configured')
	if (loadLabDenyList().keyArrays.includes(input.keyArray)) {
		throw new Error('lab withdrawNative refuses a deny-listed key array')
	}
	if (!Number.isInteger(input.gasLimit) || input.gasLimit < 1) {
		throw new Error('gasLimit must be a positive integer')
	}
	const requestFingerprint = labWithdrawFingerprint({ ...input, pool })
	return {
		keyArray: input.keyArray,
		chainId: LAB_PAYOUT_CHAIN_ID,
		to: ethers.getAddress(input.redeem),
		data: encodeLabWithdrawNative(pool, input.amount),
		value: '0',
		gasLimit: String(input.gasLimit),
		idempotencyKey: labWithdrawIdempotencyKey(requestFingerprint),
		requestFingerprint,
	}
}

export type LabWithdrawSendResult = {
	hash: string
	duplicate: boolean
	idempotencyKey: string
	requestFingerprint: string
	recoveredFromJournal: boolean
}

/**
 * Running Lab call: withdrawNative(pool, amount) on ValidatorDepositRedeem.
 * Same event keys and amount reuse one idempotencyKey. ACK loss reloads that hash.
 */
export async function sendConfiguredLabWithdrawNative(input: {
	redeem: string
	pool: string
	amount: bigint
	eventKeys: string[]
	gasLimit: number
	env?: NodeJS.ProcessEnv
	preferRecoverFirst?: boolean
	/** Set by the daemon: the key the in-flight record holds. A different key is refused before any send (3b5b402). */
	expectedIdempotencyKey?: string
}): Promise<LabWithdrawSendResult> {
	// Checked before any socket or key-array lookup: a non-fixed pool never reaches the signer.
	assertFixedLabMiningPool(input.pool)
	const config = readLabWithdrawSignerConfig(input.env)
	if (!config) {
		throw new Error(
			'lab withdraw signer requires CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_SOCKET and CONET_LAB_MINING_POOL_CL_PAYOUT_KEY_ARRAY'
		)
	}
	const tx = buildLabWithdrawNativeSignerTx({ ...input, keyArray: config.keyArray })
	if (input.expectedIdempotencyKey !== undefined && input.expectedIdempotencyKey.toLowerCase() !== tx.idempotencyKey.toLowerCase()) {
		throw new Error('withdrawNative idempotencyKey does not match the in-flight record; refused before any send')
	}
	const finish = (
		hash: string,
		duplicate: boolean,
		recoveredFromJournal: boolean
	): LabWithdrawSendResult => ({
		hash,
		duplicate,
		idempotencyKey: tx.idempotencyKey,
		requestFingerprint: tx.requestFingerprint,
		recoveredFromJournal,
	})
	if (input.preferRecoverFirst) {
		const prior = await recoverLabPayoutHashByIdempotencyKey(config.socketPath, tx.idempotencyKey)
		if (prior) return finish(prior.hash, true, true)
	}
	try {
		const sent = await labPayoutSignerSendOnce(tx, config.socketPath)
		return finish(sent.hash, Boolean(sent.duplicate), false)
	} catch (sendErr: unknown) {
		const prior = await recoverLabPayoutHashByIdempotencyKey(config.socketPath, tx.idempotencyKey)
		if (prior) return finish(prior.hash, true, true)
		throw sendErr
	}
}

export type LabSendPayoutBatchResult = {
	hash: string
	executor: string
	duplicate: boolean
	idempotencyKey: string
	requestFingerprint: string
	batchId: string
	recoveredFromJournal: boolean
}

/**
 * Canonical Lab skim send: payoutBatch + durable idempotencyKey.
 * On transport failure after possible broadcast, recovers original hash via
 * signer_getTransaction(idempotencyKey) — never mocks RPC success.
 */
export async function sendConfiguredLabExecutorPayoutBatch(input: {
	batchId: string
	eventKeys: string[]
	amount: bigint
	gasLimit: number
	env?: NodeJS.ProcessEnv
}): Promise<LabSendPayoutBatchResult> {
	const config = readLabPayoutSignerConfig(input.env)
	if (!config) {
		throw new Error(
			'lab payout signer socket, keyArray, or CONET_LAB_MINING_POOL_PAYOUT_EXECUTOR is not configured'
		)
	}
	const tx = buildLabPayoutBatchSignerTx({
		keyArray: config.keyArray,
		executor: config.executor,
		batchId: input.batchId,
		eventKeys: input.eventKeys,
		amount: input.amount,
		gasLimit: input.gasLimit,
	})
	// Single send. No journal recovery here: the signer does not decide idempotency or recovery (B-2 boundary).
	// The caller owns the record, the attempt and the receipt.
	const sent = await labPayoutSignerSendOnce(tx, config.socketPath, { allowLegacyBatchFixture: true })
	return {
		hash: sent.hash,
		executor: config.executor,
		duplicate: Boolean(sent.duplicate),
		idempotencyKey: tx.idempotencyKey,
		requestFingerprint: tx.requestFingerprint,
		batchId: input.batchId.toLowerCase(),
		recoveredFromJournal: false,
	}
}

/** Env name for the bound signer address the operator declares (round-4 F1). Required before the first send. */
export const LAB_SIGNER_DECLARED_ADDRESS_ENV = 'CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_ADDRESS'

/** Checksum a bound address and refuse any deny-listed address (any letter case). Throws otherwise. */
export function assertLabSignerAddressAllowed(address: string): string {
	let checksummed: string
	try {
		checksummed = ethers.getAddress(String(address ?? '').trim())
	} catch {
		throw new Error('bound signer address is not a valid address')
	}
	if (loadLabDenyList().addresses.includes(checksummed.toLowerCase())) {
		throw new Error('bound signer address is deny-listed; the Lab path must not sign with it')
	}
	return checksummed
}

/**
 * Confirm the socket's bound wallet before the first send (round-4 F1). Three conditions, all required:
 *  1. the operator declares the address in CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_ADDRESS, and it is allowed;
 *  2. the signer's read-only signer_getAddress returns an address, and it is allowed;
 *  3. the two addresses are equal.
 * A signer that does not provide signer_getAddress makes the address unconfirmable, so nothing is sent.
 * This reads only. It never signs. Returns the declared checksummed address.
 * The signer method name is a requirement on the signer side (open item M12); it is not verified here.
 */
export async function verifyLabSignerBoundAddress(env: NodeJS.ProcessEnv = process.env): Promise<string> {
	const declaredRaw = env[LAB_SIGNER_DECLARED_ADDRESS_ENV]?.trim() ?? ''
	if (!declaredRaw) {
		throw new Error(`${LAB_SIGNER_DECLARED_ADDRESS_ENV} is not set; the bound signer address cannot be confirmed`)
	}
	const declared = assertLabSignerAddressAllowed(declaredRaw)
	const config = readLabWithdrawSignerConfig(env)
	if (!config) throw new Error('lab withdraw signer socket and key array are not configured')
	// Two response shapes are accepted: a bare address string (the f6c70f3 signer returns this) or { address }.
	// Anything else, including null, an empty value or a non-string, leaves the address unconfirmed.
	const row: unknown = await labSignerRpc(config.socketPath, 'signer_getAddress', { keyArray: config.keyArray })
	const reported =
		typeof row === 'string'
			? row.trim()
			: row && typeof row === 'object' && typeof (row as { address?: unknown }).address === 'string'
				? ((row as { address: string }).address).trim()
				: ''
	if (!reported) throw new Error('signer did not report a bound address; cannot confirm it')
	const reportedChecksum = assertLabSignerAddressAllowed(reported)
	if (reportedChecksum !== declared) {
		throw new Error(`bound signer address ${reportedChecksum} differs from the declared ${declared}`)
	}
	return declared
}
