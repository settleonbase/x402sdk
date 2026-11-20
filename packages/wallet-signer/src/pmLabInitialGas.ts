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

export type LabInitialGasReader = {
	snapshot(): Promise<LabInitialGasSnapshot>
	feeData(): Promise<{ gasPrice: bigint | null; maxFeePerGas: bigint | null }>
	pendingNonce(address: string): Promise<number>
}

export type LabInitialGasSnapshot = {
	chainId: bigint
	blockNumber: bigint
	blockHash: string
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
	const block = await rpc.send('eth_getBlockByNumber', ['latest', false]) as { number?: unknown; hash?: unknown } | null
	if (!block || typeof block.number !== 'string' || !/^0x[0-9a-fA-F]+$/.test(block.number) || typeof block.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(block.hash)) throw new SignerError(ErrorCode.UPSTREAM, 'RPC latest block response invalid')
	const blockTag = { blockHash: block.hash, requireCanonical: true }
	const pmCall = encodeLabInitialGasAdminCall(pmAddress)
	const labCall = encodeLabInitialGasAdminCall(PM_LAB_INITIAL_GAS_RECIPIENT)
	const [pmAdminRaw, labAdminRaw, pmBalanceHex, labBalanceHex, validatorCode, labCode] = await Promise.all([
		rpc.send('eth_call', [pmCall, blockTag]),
		rpc.send('eth_call', [labCall, blockTag]),
		rpc.send('eth_getBalance', [pmAddress, blockTag]),
		rpc.send('eth_getBalance', [PM_LAB_INITIAL_GAS_RECIPIENT, blockTag]),
		rpc.send('eth_getCode', [pmCall.to, blockTag]),
		rpc.send('eth_getCode', [PM_LAB_INITIAL_GAS_RECIPIENT, blockTag]),
	])
	const parseQuantity = (value: unknown, label: string): bigint => {
		if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) throw new SignerError(ErrorCode.UPSTREAM, `RPC ${label} response invalid`)
		return BigInt(value)
	}
	if (typeof validatorCode !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(validatorCode) || typeof labCode !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(labCode)) {
		throw new SignerError(ErrorCode.UPSTREAM, 'RPC code response invalid')
	}
	return {
		chainId: parseQuantity(chainHex, 'chainId'),
		blockNumber: parseQuantity(block.number, 'block number'),
		blockHash: block.hash,
		pmAdmin: decodeLabInitialGasAdminStatus(String(pmAdminRaw)),
		labAdmin: decodeLabInitialGasAdminStatus(String(labAdminRaw)),
		pmBalance: parseQuantity(pmBalanceHex, 'PM balance'),
		labBalance: parseQuantity(labBalanceHex, 'Lab balance'),
		validatorContractCode: validatorCode,
		labRecipientCode: labCode,
	}
}

/** Require independent readers to agree on one EIP-1898 block anchor and all decision inputs. */
export function requireMatchingLabInitialGasSnapshots(first: LabInitialGasSnapshot, second: LabInitialGasSnapshot): LabInitialGasSnapshot {
	if (first.chainId !== second.chainId || first.blockNumber !== second.blockNumber || first.blockHash.toLowerCase() !== second.blockHash.toLowerCase()) {
		throw new SignerError(ErrorCode.UPSTREAM, 'independent RPC latest block anchors differ')
	}
	if (first.pmAdmin !== second.pmAdmin || first.labAdmin !== second.labAdmin || first.pmBalance !== second.pmBalance || first.labBalance !== second.labBalance || first.validatorContractCode !== second.validatorContractCode || first.labRecipientCode !== second.labRecipientCode) {
		throw new SignerError(ErrorCode.UPSTREAM, 'independent RPC same-block reads differ')
	}
	return first
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
		idempotencyKey: string
		method: 'pm.labInitialGas'
	}): Promise<SendResult>
	audit(event: Record<string, unknown>): void
}

export type LabInitialGasResult =
	| { status: 'disabled' }
	| { status: 'already-attempted'; hash: string; txStatus: string }
	| { status: 'already-funded'; balanceWei: string }
	| { status: 'dry-run'; amountWei: string; balanceWei: string; pmBalanceWei: string; nonce: number; worstFeePerGasWei: string }
	| { status: 'pending'; amountWei: string; hash: string; txStatus: string }

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
		if (existing) return { status: 'already-attempted', hash: existing.hash, txStatus: existing.status }

		const snapshot = await deps.reader.snapshot()
		if (typeof snapshot.chainId !== 'bigint' || snapshot.chainId !== BigInt(PM_LAB_INITIAL_GAS_CHAIN_ID)) throw new SignerError(ErrorCode.UPSTREAM, 'Lab initial Gas RPC chainId mismatch or invalid')
		if (typeof snapshot.blockNumber !== 'bigint' || snapshot.blockNumber < 0n || !/^0x[0-9a-fA-F]{64}$/.test(snapshot.blockHash)) throw new SignerError(ErrorCode.UPSTREAM, 'Lab initial Gas same-block snapshot is invalid')
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

		const fee = await deps.reader.feeData()
		const fees = [fee.gasPrice, fee.maxFeePerGas].filter((n): n is bigint => n !== null)
		if (fees.length === 0 || fees.some((n) => typeof n !== 'bigint' || n < 0n)) throw new SignerError(ErrorCode.UPSTREAM, 'Lab initial Gas fee data is unavailable or invalid')
		const worstFee = fees.reduce((a, b) => a > b ? a : b)
		if (worstFee > configuredFeeCap) throw denied('Lab initial Gas market fee exceeds the configured cap')
		const gasReserve = PM_LAB_INITIAL_GAS_GAS_LIMIT * worstFee
		if (amount + gasReserve > dailyCap) throw denied('Lab initial Gas amount and worst-case fee exceed the daily cap')

		const pmBalance = snapshot.pmBalance
		if (typeof pmBalance !== 'bigint' || pmBalance < 0n) throw new SignerError(ErrorCode.UPSTREAM, 'PM balance response is invalid')
		if (pmBalance < amount + gasReserve) throw denied('PM balance does not cover Lab initial Gas plus worst-case fee')
		const nonce = await deps.reader.pendingNonce(pm)
		if (!Number.isSafeInteger(nonce) || nonce < 0) throw new SignerError(ErrorCode.UPSTREAM, 'PM pending nonce is invalid')

		if (deps.cfg.dryRun) {
			deps.audit({ event: 'pm.labInitialGas.dryRun', recipient: PM_LAB_INITIAL_GAS_RECIPIENT, chainId: PM_LAB_INITIAL_GAS_CHAIN_ID, amountWei: amount.toString(), balanceWei: balance.toString(), nonce, worstFeePerGasWei: worstFee.toString() })
			return { status: 'dry-run', amountWei: amount.toString(), balanceWei: balance.toString(), pmBalanceWei: pmBalance.toString(), nonce, worstFeePerGasWei: worstFee.toString() }
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
		return { status: 'pending', amountWei: amount.toString(), hash: result.hash, txStatus: result.status }
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
