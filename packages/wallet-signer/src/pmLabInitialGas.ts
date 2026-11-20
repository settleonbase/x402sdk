import { Interface, getAddress } from 'ethers'
import type { PmLabInitialGasConfig } from './config'
import { ErrorCode, SignerError, denied } from './errors'
import { PM_GRANT_VDR } from './pmGrantAdmin'
import type { SendResult, TxManager } from './txManager'

export const PM_LAB_INITIAL_GAS_CHAIN_ID = 224422
export const PM_LAB_INITIAL_GAS_RECIPIENT = getAddress('0xcFAF85E6C1765DA01a4Dc58C81b28Cd572067135')
export const PM_LAB_INITIAL_GAS_TARGET_WEI = 100_000_000_000_000_000n // 0.1 CNET
export const PM_LAB_INITIAL_GAS_GAS_LIMIT = 21_000n
export const PM_LAB_INITIAL_GAS_MAX_FEE_WEI = 30_000_000n // hard ceiling: 0.03 Gwei
export const PM_LAB_INITIAL_GAS_MAX_TOTAL_WEI = PM_LAB_INITIAL_GAS_TARGET_WEI + PM_LAB_INITIAL_GAS_GAS_LIMIT * PM_LAB_INITIAL_GAS_MAX_FEE_WEI
export const PM_LAB_INITIAL_GAS_CLIENT = 'pm-lab-initial-gas'
export const PM_LAB_INITIAL_GAS_IDEMPOTENCY_KEY = `pm-lab-initial-gas:${PM_LAB_INITIAL_GAS_CHAIN_ID}:${PM_LAB_INITIAL_GAS_RECIPIENT.toLowerCase()}`
const ADMIN_IFACE = new Interface(['function admins(address) view returns (bool)'])
export const PM_LAB_INITIAL_GAS_ADMIN_SELECTOR = ADMIN_IFACE.getFunction('admins')!.selector
const ALLOWED_LAB_INITIAL_GAS_READ_METHODS = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_call', 'eth_getBalance', 'eth_getCode', 'eth_getTransactionCount'])

/** Expose only the JSON-RPC read methods used by the preflight; no send/raw-send API is returned. */
export function labInitialGasReadOnlyRpc(rpc: { send(method: string, params: unknown[]): Promise<unknown> }): { send(method: string, params: unknown[]): Promise<unknown> } {
	return {
		send(method, params) {
			if (!ALLOWED_LAB_INITIAL_GAS_READ_METHODS.has(method)) throw new SignerError(ErrorCode.INVALID_PARAMS, `Lab initial Gas read RPC method is not allowed: ${method}`)
				if (method === 'eth_chainId' && params.length !== 0) throw new SignerError(ErrorCode.INVALID_PARAMS, 'Lab initial Gas chainId read params are invalid')
				if (method === 'eth_getBlockByNumber' && (params.length !== 2 || !(params[0] === 'latest' || (typeof params[0] === 'string' && /^0x[0-9a-fA-F]+$/.test(params[0]))) || params[1] !== false)) throw new SignerError(ErrorCode.INVALID_PARAMS, 'Lab initial Gas block read params are invalid')
				if (['eth_call', 'eth_getBalance', 'eth_getCode'].includes(method)) {
					const tag = params[1] as { blockHash?: unknown; requireCanonical?: unknown } | undefined
					if (params.length !== 2 || !tag || typeof tag.blockHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(tag.blockHash) || tag.requireCanonical !== true) throw new SignerError(ErrorCode.INVALID_PARAMS, `Lab initial Gas ${method} must use canonical EIP-1898 block hash`)
				}
				if (method === 'eth_getTransactionCount') {
					const tag = params[1]
					if (params.length !== 2 || typeof params[0] !== 'string' || !(tag === 'pending' || (typeof tag === 'object' && tag !== null && (tag as { requireCanonical?: unknown }).requireCanonical === true && typeof (tag as { blockHash?: unknown }).blockHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test((tag as { blockHash: string }).blockHash)))) throw new SignerError(ErrorCode.INVALID_PARAMS, 'Lab initial Gas nonce read must use pending or canonical EIP-1898 block hash')
				}
			return rpc.send(method, params)
		},
	}
}

/** Wrap the one configured chain provider for reads; never creates or adds a second endpoint. */
export function createLabInitialGasReadProvider<T extends { send(method: string, params: unknown[]): Promise<unknown> }>(provider: T): ReturnType<typeof labInitialGasReadOnlyRpc> {
	return labInitialGasReadOnlyRpc(provider)
}

export type LabInitialGasReader = {
	snapshot(): Promise<LabInitialGasSnapshot>
	pendingNonce(address: string): Promise<number>
}

export type LabInitialGasSnapshot = {
	chainId: bigint
	blockNumber: bigint
	blockHash: string
	baseFeePerGas: bigint
	/** Confirmed nonce anchored to this canonical block; pending nonce is read separately for TxManager preflight. */
	minedNonce: bigint
	pmAdmin: boolean
	labAdmin: boolean
	pmBalance: bigint
	labBalance: bigint
	validatorContractCode: string
	labRecipientCode: string
}

/** Read all policy inputs from one EIP-1898 block hash on a single RPC endpoint. */
export async function readLabInitialGasSnapshot(rpc: { send(method: string, params: unknown[]): Promise<unknown> }, pmAddress: string): Promise<LabInitialGasSnapshot> {
	const chainHex = await rpc.send('eth_chainId', [])
	if (typeof chainHex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(chainHex)) throw new SignerError(ErrorCode.UPSTREAM, 'RPC chainId response invalid')
	const latest = await rpc.send('eth_getBlockByNumber', ['latest', false])
	const parseBlock = (raw: unknown, label: string): { number: bigint; numberHex: string; hash: string; baseFeePerGas: bigint } => {
		if (!raw || typeof raw !== 'object') throw new SignerError(ErrorCode.UPSTREAM, `RPC ${label} block response invalid`)
		const block = raw as { number?: unknown; hash?: unknown; baseFeePerGas?: unknown }
		if (typeof block.number !== 'string' || !/^0x[0-9a-fA-F]+$/.test(block.number) || typeof block.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(block.hash) || typeof block.baseFeePerGas !== 'string' || !/^0x[0-9a-fA-F]+$/.test(block.baseFeePerGas)) throw new SignerError(ErrorCode.UPSTREAM, `RPC ${label} block or baseFeePerGas response invalid`)
		return { number: BigInt(block.number), numberHex: `0x${BigInt(block.number).toString(16)}`, hash: block.hash.toLowerCase(), baseFeePerGas: BigInt(block.baseFeePerGas) }
	}
	const candidate = parseBlock(latest, 'latest')
	const canonicalBefore = parseBlock(await rpc.send('eth_getBlockByNumber', [candidate.numberHex, false]), 'canonical-before')
	if (canonicalBefore.number !== candidate.number || canonicalBefore.hash !== candidate.hash || canonicalBefore.baseFeePerGas !== candidate.baseFeePerGas) throw new SignerError(ErrorCode.UPSTREAM, 'RPC latest block is not the canonical header at its reported number')
	const blockTag = { blockHash: candidate.hash, requireCanonical: true }
	const pmCall = encodeLabInitialGasAdminCall(pmAddress)
	const labCall = encodeLabInitialGasAdminCall(PM_LAB_INITIAL_GAS_RECIPIENT)
	const [pmAdminRaw, labAdminRaw, pmBalanceHex, labBalanceHex, validatorCode, labCode, minedNonceHex] = await Promise.all([
		rpc.send('eth_call', [pmCall, blockTag]),
		rpc.send('eth_call', [labCall, blockTag]),
		rpc.send('eth_getBalance', [pmAddress, blockTag]),
		rpc.send('eth_getBalance', [PM_LAB_INITIAL_GAS_RECIPIENT, blockTag]),
		rpc.send('eth_getCode', [pmCall.to, blockTag]),
		rpc.send('eth_getCode', [PM_LAB_INITIAL_GAS_RECIPIENT, blockTag]),
		rpc.send('eth_getTransactionCount', [pmAddress, blockTag]),
	])
	const parseQuantity = (value: unknown, label: string): bigint => {
		if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) throw new SignerError(ErrorCode.UPSTREAM, `RPC ${label} response invalid`)
		return BigInt(value)
	}
	if (typeof validatorCode !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(validatorCode) || typeof labCode !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(labCode)) {
		throw new SignerError(ErrorCode.UPSTREAM, 'RPC code response invalid')
	}
	const snapshot: LabInitialGasSnapshot = {
		chainId: parseQuantity(chainHex, 'chainId'),
		blockNumber: candidate.number,
		blockHash: candidate.hash,
		baseFeePerGas: candidate.baseFeePerGas,
		minedNonce: parseQuantity(minedNonceHex, 'canonical mined nonce'),
		pmAdmin: decodeLabInitialGasAdminStatus(String(pmAdminRaw)),
		labAdmin: decodeLabInitialGasAdminStatus(String(labAdminRaw)),
		pmBalance: parseQuantity(pmBalanceHex, 'PM balance'),
		labBalance: parseQuantity(labBalanceHex, 'Lab balance'),
		validatorContractCode: validatorCode,
		labRecipientCode: labCode,
	}
	const canonicalAfter = parseBlock(await rpc.send('eth_getBlockByNumber', [candidate.numberHex, false]), 'canonical-after')
	if (canonicalAfter.number !== candidate.number || canonicalAfter.hash !== candidate.hash || canonicalAfter.baseFeePerGas !== candidate.baseFeePerGas) throw new SignerError(ErrorCode.UPSTREAM, 'canonical block changed during Lab initial Gas preflight')
	return snapshot
}

/** Read pending nonce separately from canonical mined nonce; pending state is not EIP-1898 anchorable. */
export async function readLabInitialGasPendingNonce(rpc: { send(method: string, params: unknown[]): Promise<unknown> }, address: string): Promise<number> {
	const raw = await rpc.send('eth_getTransactionCount', [getAddress(address), 'pending'])
	if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) throw new SignerError(ErrorCode.UPSTREAM, 'RPC pending nonce response invalid')
	const nonce = BigInt(raw)
	if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw new SignerError(ErrorCode.UPSTREAM, 'RPC pending nonce exceeds safe integer range')
	return Number(nonce)
}

export type LabInitialGasDeps = {
	cfg: PmLabInitialGasConfig
	registryPm: string
	keyringPm: string | null
	unlocked: boolean
	reader: LabInitialGasReader
	txm: Pick<TxManager, 'get'>
	send(req: {
		client: string
		array: 'PM'
		chainId: number
		candidates: string[]
		from: string
		to: string
		data: '0x'
		value: bigint
		gasLimit: bigint
		maxGas: bigint
		maxGasPriceWei: bigint
		maxInflightPerKey: 1
		dailyBudgetWei: bigint
		expectedNonce: number
		fixedEip1559Fees: { baseFeePerGas: bigint; maxPriorityFeePerGas: bigint; maxFeePerGas: bigint }
		idempotencyKey: string
		method: 'pm.labInitialGas'
	}): Promise<SendResult>
	audit(event: Record<string, unknown>): void
}

export type LabInitialGasResult =
	| { status: 'disabled' }
	| { status: 'already-attempted'; hash: string; txStatus: string }
	| { status: 'already-funded'; balanceWei: string }
	| { status: 'dry-run'; amountWei: string; balanceWei: string; pmBalanceWei: string; nonce: number; canonicalMinedNonce: string; worstFeePerGasWei: string }
	| { status: 'pending' | 'mined' | 'reverted' | 'rejected'; amountWei: string; hash: string; txStatus: string }

let serial: Promise<unknown> = Promise.resolve()
function withLabInitialGasLock<T>(fn: () => Promise<T>): Promise<T> {
	const run = serial.then(fn, fn)
	serial = run.catch(() => undefined)
	return run
}

/** Fixed Lab-only initial funding. All network and send effects are injected for offline tests. */
export function runPmLabInitialGas(deps: LabInitialGasDeps): Promise<LabInitialGasResult> {
	return withLabInitialGasLock(async () => {
		if (!deps.cfg.enabled) return { status: 'disabled' }
		const pm = getAddress(deps.registryPm)
		if (!deps.unlocked || !deps.keyringPm || getAddress(deps.keyringPm) !== pm) throw denied('Lab initial Gas requires the unlocked registered PM key')
		const existing = deps.txm.get({ idempotencyKey: PM_LAB_INITIAL_GAS_IDEMPOTENCY_KEY, client: PM_LAB_INITIAL_GAS_CLIENT })
		if (existing) {
			if (typeof existing.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(existing.hash) || !['sent', 'mined', 'stuck', 'reverted', 'rejected'].includes(existing.status)) {
				throw new SignerError(ErrorCode.UPSTREAM, 'Existing Lab initial-Gas journal record has invalid hash/status; intent requires manual reconcile and must not be retried')
			}
			return { status: 'already-attempted', hash: existing.hash, txStatus: existing.status }
		}

		const snapshot = await deps.reader.snapshot()
		if (typeof snapshot.chainId !== 'bigint' || snapshot.chainId !== BigInt(PM_LAB_INITIAL_GAS_CHAIN_ID)) throw new SignerError(ErrorCode.UPSTREAM, 'Lab initial Gas RPC chainId mismatch or invalid')
		if (typeof snapshot.blockNumber !== 'bigint' || snapshot.blockNumber < 0n || !/^0x[0-9a-fA-F]{64}$/.test(snapshot.blockHash) || typeof snapshot.minedNonce !== 'bigint' || snapshot.minedNonce < 0n) throw new SignerError(ErrorCode.UPSTREAM, 'Lab initial Gas same-block snapshot or canonical nonce is invalid')
		if (typeof snapshot.pmAdmin !== 'boolean' || typeof snapshot.labAdmin !== 'boolean') throw new SignerError(ErrorCode.UPSTREAM, 'Lab initial Gas admin status is unknown')
		if (!snapshot.pmAdmin || !snapshot.labAdmin) throw denied('PM and Lab must both be admins on the fixed ValidatorDepositRedeem contract before initial Gas')
		for (const code of [snapshot.validatorContractCode, snapshot.labRecipientCode]) {
			if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(code)) throw new SignerError(ErrorCode.UPSTREAM, 'Lab initial Gas code response is invalid')
		}
		if (snapshot.validatorContractCode === '0x' || snapshot.labRecipientCode !== '0x') throw denied('ValidatorDepositRedeem code or fixed Lab wallet code does not match the reviewed account shape')
		const balance = snapshot.labBalance
		if (typeof balance !== 'bigint' || balance < 0n) throw new SignerError(ErrorCode.UPSTREAM, 'Lab initial Gas recipient balance is invalid')
		if (balance >= PM_LAB_INITIAL_GAS_TARGET_WEI) return { status: 'already-funded', balanceWei: balance.toString() }

		const amount = PM_LAB_INITIAL_GAS_TARGET_WEI - balance
		const maxSpend = BigInt(deps.cfg.maxSpendWei)
		const dailyCap = BigInt(deps.cfg.dailyCapWei)
		const configuredFeeCap = BigInt(deps.cfg.maxFeePerGasWei)
		if (maxSpend <= 0n || dailyCap <= 0n || configuredFeeCap <= 0n) throw denied('Lab initial Gas spend, daily, and fee caps must be explicitly positive')
		if (amount > maxSpend || amount > dailyCap || amount > PM_LAB_INITIAL_GAS_TARGET_WEI) throw denied('Lab initial Gas amount exceeds its fixed spend cap')
		if (dailyCap > PM_LAB_INITIAL_GAS_MAX_TOTAL_WEI) throw denied('Lab initial Gas daily cap exceeds the fixed hard ceiling')
		if (configuredFeeCap > PM_LAB_INITIAL_GAS_MAX_FEE_WEI) throw denied('Lab initial Gas configured fee cap exceeds the hard ceiling')

		const priorityFee = BigInt(deps.cfg.maxPriorityFeePerGasWei)
		if (typeof snapshot.baseFeePerGas !== 'bigint' || snapshot.baseFeePerGas < 0n || priorityFee < 0n || priorityFee > configuredFeeCap) throw new SignerError(ErrorCode.UPSTREAM, 'Lab initial Gas base fee or configured priority fee is invalid')
		if (configuredFeeCap < snapshot.baseFeePerGas + priorityFee) throw denied('Lab initial Gas configured max fee does not cover canonical base fee plus configured priority fee')
		// The header base fee is hash-bound; priority and max fee are explicit config values.
		const worstFee = configuredFeeCap
		const gasReserve = PM_LAB_INITIAL_GAS_GAS_LIMIT * worstFee
		if (amount + gasReserve > dailyCap) throw denied('Lab initial Gas amount and worst-case fee exceed the daily cap')

		const pmBalance = snapshot.pmBalance
		if (typeof pmBalance !== 'bigint' || pmBalance < 0n) throw new SignerError(ErrorCode.UPSTREAM, 'PM balance response is invalid')
		if (pmBalance < amount + gasReserve) throw denied('PM balance does not cover Lab initial Gas plus worst-case fee')
		const nonce = await deps.reader.pendingNonce(pm)
		if (!Number.isSafeInteger(nonce) || nonce < 0) throw new SignerError(ErrorCode.UPSTREAM, 'PM pending nonce is invalid')
		if (BigInt(nonce) < snapshot.minedNonce) throw new SignerError(ErrorCode.UPSTREAM, 'PM pending nonce is below the canonical mined nonce')

		if (deps.cfg.dryRun) {
			deps.audit({ event: 'pm.labInitialGas.dryRun', recipient: PM_LAB_INITIAL_GAS_RECIPIENT, chainId: PM_LAB_INITIAL_GAS_CHAIN_ID, amountWei: amount.toString(), balanceWei: balance.toString(), canonicalMinedNonce: snapshot.minedNonce.toString(), pendingNonce: nonce, nonceSemantics: 'mined nonce is EIP-1898 block-hash anchored; pending nonce is an unanchored same-provider mempool read and TxManager revalidates under lock/journal', feeSemantics: 'baseFee is bound to canonical block header; configured priority and max fee are explicit and bounded', baseFeePerGasWei: snapshot.baseFeePerGas.toString(), maxPriorityFeePerGasWei: priorityFee.toString(), worstFeePerGasWei: worstFee.toString() })
			return { status: 'dry-run', amountWei: amount.toString(), balanceWei: balance.toString(), pmBalanceWei: pmBalance.toString(), nonce, canonicalMinedNonce: snapshot.minedNonce.toString(), worstFeePerGasWei: worstFee.toString() }
		}

		const result = await deps.send({
			client: PM_LAB_INITIAL_GAS_CLIENT,
			array: 'PM',
			chainId: PM_LAB_INITIAL_GAS_CHAIN_ID,
			candidates: [pm],
			from: pm,
			to: PM_LAB_INITIAL_GAS_RECIPIENT,
			data: '0x',
			value: amount,
			gasLimit: PM_LAB_INITIAL_GAS_GAS_LIMIT,
			maxGas: PM_LAB_INITIAL_GAS_GAS_LIMIT,
			maxGasPriceWei: configuredFeeCap,
			maxInflightPerKey: 1,
			dailyBudgetWei: dailyCap,
			expectedNonce: nonce,
			fixedEip1559Fees: { baseFeePerGas: snapshot.baseFeePerGas, maxPriorityFeePerGas: priorityFee, maxFeePerGas: configuredFeeCap },
			idempotencyKey: PM_LAB_INITIAL_GAS_IDEMPOTENCY_KEY,
			method: 'pm.labInitialGas',
		})
		if (typeof result.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result.hash)) {
			throw new SignerError(ErrorCode.UPSTREAM, 'Lab initial Gas outcome has no valid transaction hash; intent remains journaled and requires reconcile before any retry')
		}
		if (!['sent', 'mined', 'stuck', 'reverted', 'rejected'].includes(result.status)) {
			throw new SignerError(ErrorCode.UPSTREAM, 'Lab initial Gas returned an unknown transaction status; intent remains journaled and requires reconcile')
		}
		deps.audit({ event: 'pm.labInitialGas.sent', recipient: PM_LAB_INITIAL_GAS_RECIPIENT, amountWei: amount.toString(), hash: result.hash, txStatus: result.status, idempotencyKey: PM_LAB_INITIAL_GAS_IDEMPOTENCY_KEY })
		const status = result.status === 'sent' || result.status === 'stuck' ? 'pending' : result.status
		return { status, amountWei: amount.toString(), hash: result.hash, txStatus: result.status }
	})
}

export function encodeLabInitialGasAdminCall(address: string): { to: string; data: string } {
	return { to: PM_GRANT_VDR, data: ADMIN_IFACE.encodeFunctionData('admins', [getAddress(address)]) }
}

export function decodeLabInitialGasAdminStatus(raw: string): boolean {
	const decoded = ADMIN_IFACE.decodeFunctionResult('admins', raw)[0]
	if (typeof decoded !== 'boolean') throw new SignerError(ErrorCode.UPSTREAM, 'ValidatorDepositRedeem admins response is invalid')
	return decoded
}
