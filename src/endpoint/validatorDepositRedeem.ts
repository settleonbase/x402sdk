import { ethers } from 'ethers'
import type { Response } from 'express'
import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import Colors from 'colors/safe'
import { logger } from '../logger'
import { masterSetup, resolveBeamioConetHttpRpcUrl } from '../util'
import {
	CONET_DEPOSIT_CONTRACT,
	CONET_MAINNET_CHAIN_ID,
	CONET_VALIDATOR_DEPOSIT_FUNDER,
	CONET_VALIDATOR_DEPOSIT_REDEEM,
	CONET_VALIDATOR_NODE_IP,
} from '../chainAddresses'
import { Settle_ContractPool } from '../MemberCard'

const VALIDATOR_REDEEM_VERSION = 'validator-deposit-redeem-v1'
const MAX_REDEEM_CODE_BYTES = 512
const MAX_IP_BYTES = 64
const DEFAULT_NEW_CONET_DIR = '/Users/peter/Downloads/seguro-pro/CoNET-DL-master/newCoNET'

const VALIDATOR_DEPOSIT_REDEEM_ABI = [
	'event ValidatorRedeemClaimed(bytes32 indexed requestId, bytes32 indexed codeHash, address indexed claimer, address beneficiary, uint256 validatorCount, string targetNodeIp, string[] conetDepinNodeIps, uint256 gbMiningNodeCount)',
	'function createRedeemFor(address admin, bytes32 codeHash, address allowedClaimer, uint256 validatorCount, string targetNodeIp, string[] conetDepinNodeIps, uint256 gbMiningNodeCount, uint256 validAfter, uint256 validBefore, uint256 nonce, uint256 deadline, bytes signature) external',
	'function cancelRedeemFor(address admin, bytes32 codeHash, uint256 nonce, uint256 deadline, bytes signature) external',
	'function claimRedeemFor(address claimer, address beneficiary, string code, uint256 deadline, bytes signature) external returns (bytes32)',
	'function redeemAdminNonces(address account) view returns (uint256)',
	'function redeemAdmins(address account) view returns (bool)',
	'function getRedeem(bytes32 codeHash) view returns (address allowedClaimer, uint256 validatorCount, string targetNodeIp, string[] conetDepinNodeIps, uint256 gbMiningNodeCount, uint64 validAfter, uint64 validBefore, bool active, bool consumed)',
] as const

export type ValidatorRedeemState = {
	requestId: string
	codeHash: string
	claimer: string
	beneficiary: string
	validatorCount: string
	targetNodeIp: string
	conetDepinNodeIps: string[]
	gbMiningNodeCount: string
	status: 'received' | 'running' | 'succeeded' | 'failed' | 'ignored'
	createdAt: string
	updatedAt: string
	error?: string
	stages: Record<string, { ok: boolean; at: string; detail?: string }>
	depositPrivateKeyFile?: string
}

type StateFile = Record<string, ValidatorRedeemState>

function conetProvider(): ethers.JsonRpcProvider {
	return new ethers.JsonRpcProvider(resolveBeamioConetHttpRpcUrl(), undefined, { batchMaxCount: 1 })
}

function normalizeIp(raw: string): string {
	return raw.trim().toLowerCase()
}

function isValidIpLike(raw: string): boolean {
	const ip = normalizeIp(raw)
	if (!ip || ip.length > MAX_IP_BYTES) return false
	if (!/^[a-z0-9.:-]+$/.test(ip)) return false
	return true
}

function codeHashOf(code: string): string {
	return ethers.keccak256(ethers.toUtf8Bytes(code))
}

function hashStringArray(values: string[]): string {
	const hashes = values.map((v) => ethers.keccak256(ethers.toUtf8Bytes(v)))
	return ethers.keccak256(ethers.concat(hashes))
}

export function resolveValidatorDepositRedeemAddress(): string | null {
	const raw = process.env.CONET_VALIDATOR_DEPOSIT_REDEEM?.trim() || CONET_VALIDATOR_DEPOSIT_REDEEM
	if (!raw) return null
	try {
		const a = ethers.getAddress(raw)
		return a === ethers.ZeroAddress ? null : a
	} catch {
		return null
	}
}

export function resolveValidatorNodeIp(): string {
	return normalizeIp(
		process.env.CONET_VALIDATOR_NODE_IP?.trim() ||
			masterSetup.validatorDeposit?.nodeIp?.trim() ||
			CONET_VALIDATOR_NODE_IP ||
			''
	)
}

function resolveNewCoNETDir(): string {
	return process.env.CONET_VALIDATOR_NEWCONET_DIR?.trim() || masterSetup.validatorDeposit?.newCoNETDir?.trim() || DEFAULT_NEW_CONET_DIR
}

function resolveStateFile(): string {
	return (
		process.env.CONET_VALIDATOR_REDEEM_STATE_FILE?.trim() ||
		masterSetup.validatorDeposit?.stateFile?.trim() ||
		path.join(homedir(), '.conet-validator-redeem-state.json')
	)
}

function resolveDepositPrivateKeyFile(): string {
	return (
		process.env.CONET_VALIDATOR_DEPOSIT_PRIVATE_KEY_FILE?.trim() ||
		masterSetup.validatorDeposit?.privateKeyFile?.trim() ||
		''
	)
}

function validatorDryRun(): boolean {
	const env = process.env.CONET_VALIDATOR_REDEEM_DRY_RUN?.trim().toLowerCase()
	if (env === '1' || env === 'true' || env === 'yes') return true
	if (env === '0' || env === 'false' || env === 'no') return false
	return Boolean(masterSetup.validatorDeposit?.dryRun)
}

function readStateFile(): StateFile {
	const file = resolveStateFile()
	if (!fs.existsSync(file)) return {}
	try {
		return JSON.parse(fs.readFileSync(file, 'utf-8')) as StateFile
	} catch {
		return {}
	}
}

function writeStateFile(state: StateFile): void {
	const file = resolveStateFile()
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf-8')
}

function upsertState(requestId: string, update: (current?: ValidatorRedeemState) => ValidatorRedeemState): ValidatorRedeemState {
	const all = readStateFile()
	const next = update(all[requestId])
	all[requestId] = next
	writeStateFile(all)
	return next
}

export function getValidatorDepositRedeemStatus(requestId: string): ValidatorRedeemState | null {
	if (!ethers.isHexString(requestId, 32)) return null
	return readStateFile()[requestId.toLowerCase()] || null
}

export function validatorDepositRedeemConfig() {
	const contract = resolveValidatorDepositRedeemAddress()
	const nodeIp = resolveValidatorNodeIp()
	const privateKeyFile = resolveDepositPrivateKeyFile()
	return {
		success: true,
		version: VALIDATOR_REDEEM_VERSION,
		chainId: CONET_MAINNET_CHAIN_ID,
		contract,
		nodeIp,
		depositContract: CONET_DEPOSIT_CONTRACT,
		depositFunder: CONET_VALIDATOR_DEPOSIT_FUNDER,
		newCoNETDir: resolveNewCoNETDir(),
		stateFile: resolveStateFile(),
		dryRun: validatorDryRun(),
		depositPrivateKeyFileConfigured: Boolean(privateKeyFile),
		listenerEnabled: process.env.CONET_VALIDATOR_REDEEM_LISTENER === '1',
	}
}

export function validatorDepositRedeemEip712Domain(verifyingContract: string) {
	return {
		name: 'ValidatorDepositRedeem',
		version: '1',
		chainId: CONET_MAINNET_CHAIN_ID,
		verifyingContract: ethers.getAddress(verifyingContract),
	} as const
}

export const validatorDepositRedeemCreateTypes: Record<string, { name: string; type: string }[]> = {
	CreateRedeem: [
		{ name: 'admin', type: 'address' },
		{ name: 'codeHash', type: 'bytes32' },
		{ name: 'allowedClaimer', type: 'address' },
		{ name: 'validatorCount', type: 'uint256' },
		{ name: 'targetNodeIp', type: 'string' },
		{ name: 'conetDepinNodeIpsHash', type: 'bytes32' },
		{ name: 'gbMiningNodeCount', type: 'uint256' },
		{ name: 'validAfter', type: 'uint256' },
		{ name: 'validBefore', type: 'uint256' },
		{ name: 'nonce', type: 'uint256' },
		{ name: 'deadline', type: 'uint256' },
	],
}

export const validatorDepositRedeemCancelTypes: Record<string, { name: string; type: string }[]> = {
	CancelRedeem: [
		{ name: 'admin', type: 'address' },
		{ name: 'codeHash', type: 'bytes32' },
		{ name: 'nonce', type: 'uint256' },
		{ name: 'deadline', type: 'uint256' },
	],
}

export const validatorDepositRedeemClaimTypes: Record<string, { name: string; type: string }[]> = {
	ClaimRedeem: [
		{ name: 'claimer', type: 'address' },
		{ name: 'codeHash', type: 'bytes32' },
		{ name: 'beneficiary', type: 'address' },
		{ name: 'validatorCount', type: 'uint256' },
		{ name: 'targetNodeIp', type: 'string' },
		{ name: 'conetDepinNodeIpsHash', type: 'bytes32' },
		{ name: 'gbMiningNodeCount', type: 'uint256' },
		{ name: 'deadline', type: 'uint256' },
	],
}

export async function validatorDepositRedeemReadAdminNonce(adminAddress: string): Promise<{ ok: true; nonce: string } | { ok: false; error: string }> {
	const addr = resolveValidatorDepositRedeemAddress()
	if (!addr) return { ok: false, error: 'CONET_VALIDATOR_DEPOSIT_REDEEM not configured' }
	if (!ethers.isAddress(adminAddress)) return { ok: false, error: 'Invalid admin' }
	const c = new ethers.Contract(addr, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider())
	try {
		const n = await c.redeemAdminNonces!(ethers.getAddress(adminAddress))
		return { ok: true, nonce: (n as bigint).toString() }
	} catch (e: any) {
		return { ok: false, error: e?.shortMessage ?? e?.message ?? 'redeemAdminNonces failed' }
	}
}

function parseUintField(name: string, value: unknown): bigint | string {
	try {
		const n = BigInt(String(value ?? ''))
		if (n < 0n) return `${name} must be non-negative`
		return n
	} catch {
		return `Invalid ${name}`
	}
}

function parseIpArray(value: unknown): string[] | string {
	if (!Array.isArray(value)) return 'conetDepinNodeIps must be an array'
	const ips = value.map((v) => (typeof v === 'string' ? normalizeIp(v) : ''))
	if (ips.some((ip) => !isValidIpLike(ip))) return 'Invalid conetDepinNodeIps'
	return ips
}

export async function validatorDepositRedeemCreateClusterPreCheck(body: {
	admin?: string
	codeHash?: string
	allowedClaimer?: string
	validatorCount?: unknown
	targetNodeIp?: string
	conetDepinNodeIps?: unknown
	gbMiningNodeCount?: unknown
	validAfter?: unknown
	validBefore?: unknown
	nonce?: unknown
	deadline?: unknown
	signature?: unknown
}) {
	const contract = resolveValidatorDepositRedeemAddress()
	if (!contract) return { success: false as const, error: 'CONET_VALIDATOR_DEPOSIT_REDEEM not configured' }
	if (!body.admin || !ethers.isAddress(body.admin)) return { success: false as const, error: 'Invalid admin' }
	const admin = ethers.getAddress(body.admin)
	const codeHash = typeof body.codeHash === 'string' && ethers.isHexString(body.codeHash, 32) ? body.codeHash : ''
	if (!codeHash) return { success: false as const, error: 'Invalid codeHash' }
	const allowedClaimer =
		typeof body.allowedClaimer === 'string' && body.allowedClaimer.trim()
			? ethers.getAddress(body.allowedClaimer)
			: ethers.ZeroAddress
	const validatorCount = parseUintField('validatorCount', body.validatorCount)
	if (typeof validatorCount === 'string' || validatorCount <= 0n) return { success: false as const, error: typeof validatorCount === 'string' ? validatorCount : 'validatorCount must be positive' }
	const targetNodeIp = normalizeIp(body.targetNodeIp || '')
	if (!isValidIpLike(targetNodeIp)) return { success: false as const, error: 'Invalid targetNodeIp' }
	const conetDepinNodeIps = parseIpArray(body.conetDepinNodeIps)
	if (typeof conetDepinNodeIps === 'string') return { success: false as const, error: conetDepinNodeIps }
	if (BigInt(conetDepinNodeIps.length) !== validatorCount) return { success: false as const, error: 'conetDepinNodeIps length must equal validatorCount' }
	const gbMiningNodeCount = parseUintField('gbMiningNodeCount', body.gbMiningNodeCount ?? validatorCount.toString())
	if (typeof gbMiningNodeCount === 'string') return { success: false as const, error: gbMiningNodeCount }
	const validAfter = parseUintField('validAfter', body.validAfter ?? '0')
	const validBefore = parseUintField('validBefore', body.validBefore ?? '0')
	const nonce = parseUintField('nonce', body.nonce)
	const deadline = parseUintField('deadline', body.deadline)
	if (typeof validAfter === 'string' || typeof validBefore === 'string' || typeof nonce === 'string' || typeof deadline === 'string') {
		return { success: false as const, error: 'Invalid time or nonce fields' }
	}
	const signature = typeof body.signature === 'string' ? body.signature.trim() : ''
	if (!ethers.isHexString(signature) || ethers.dataLength(signature) < 64) return { success: false as const, error: 'Invalid signature' }

	const read = new ethers.Contract(contract, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider())
	const [isAdmin, chainNonce] = await Promise.all([read.redeemAdmins!(admin), read.redeemAdminNonces!(admin)])
	if (!isAdmin) return { success: false as const, error: 'Not a redeem admin' }
	if ((chainNonce as bigint) !== nonce) return { success: false as const, error: 'Stale nonce; refresh and sign again' }
	if (deadline <= BigInt(Math.floor(Date.now() / 1000))) return { success: false as const, error: 'Deadline expired' }

	const message = {
		admin,
		codeHash,
		allowedClaimer,
		validatorCount,
		targetNodeIp,
		conetDepinNodeIpsHash: hashStringArray(conetDepinNodeIps),
		gbMiningNodeCount,
		validAfter,
		validBefore,
		nonce,
		deadline,
	}
	const recovered = ethers.verifyTypedData(validatorDepositRedeemEip712Domain(contract), validatorDepositRedeemCreateTypes, message, signature)
	if (recovered.toLowerCase() !== admin.toLowerCase()) return { success: false as const, error: 'Signer is not admin' }
	return { success: true as const, preChecked: { contract, ...message, conetDepinNodeIps, signature } }
}

export async function validatorDepositRedeemCancelClusterPreCheck(body: {
	admin?: string
	codeHash?: string
	nonce?: unknown
	deadline?: unknown
	signature?: unknown
}) {
	const contract = resolveValidatorDepositRedeemAddress()
	if (!contract) return { success: false as const, error: 'CONET_VALIDATOR_DEPOSIT_REDEEM not configured' }
	if (!body.admin || !ethers.isAddress(body.admin)) return { success: false as const, error: 'Invalid admin' }
	const admin = ethers.getAddress(body.admin)
	const codeHash = typeof body.codeHash === 'string' && ethers.isHexString(body.codeHash, 32) ? body.codeHash : ''
	if (!codeHash) return { success: false as const, error: 'Invalid codeHash' }
	const nonce = parseUintField('nonce', body.nonce)
	const deadline = parseUintField('deadline', body.deadline)
	if (typeof nonce === 'string' || typeof deadline === 'string') return { success: false as const, error: 'Invalid nonce or deadline' }
	const signature = typeof body.signature === 'string' ? body.signature.trim() : ''
	if (!ethers.isHexString(signature) || ethers.dataLength(signature) < 64) return { success: false as const, error: 'Invalid signature' }
	const read = new ethers.Contract(contract, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider())
	const [isAdmin, chainNonce] = await Promise.all([read.redeemAdmins!(admin), read.redeemAdminNonces!(admin)])
	if (!isAdmin) return { success: false as const, error: 'Not a redeem admin' }
	if ((chainNonce as bigint) !== nonce) return { success: false as const, error: 'Stale nonce; refresh and sign again' }
	const recovered = ethers.verifyTypedData(validatorDepositRedeemEip712Domain(contract), validatorDepositRedeemCancelTypes, { admin, codeHash, nonce, deadline }, signature)
	if (recovered.toLowerCase() !== admin.toLowerCase()) return { success: false as const, error: 'Signer is not admin' }
	return { success: true as const, preChecked: { contract, admin, codeHash, nonce, deadline, signature } }
}

export async function validatorDepositRedeemClaimClusterPreCheck(body: {
	claimer?: string
	beneficiary?: string
	code?: string
	deadline?: unknown
	signature?: unknown
}) {
	const contract = resolveValidatorDepositRedeemAddress()
	if (!contract) return { success: false as const, error: 'CONET_VALIDATOR_DEPOSIT_REDEEM not configured' }
	if (!body.claimer || !ethers.isAddress(body.claimer)) return { success: false as const, error: 'Invalid claimer' }
	if (!body.beneficiary || !ethers.isAddress(body.beneficiary)) return { success: false as const, error: 'Invalid beneficiary' }
	const claimer = ethers.getAddress(body.claimer)
	const beneficiary = ethers.getAddress(body.beneficiary)
	const code = typeof body.code === 'string' ? body.code : ''
	if (!code || ethers.toUtf8Bytes(code).length > MAX_REDEEM_CODE_BYTES) return { success: false as const, error: 'Invalid code' }
	const deadline = parseUintField('deadline', body.deadline)
	if (typeof deadline === 'string') return { success: false as const, error: deadline }
	const signature = typeof body.signature === 'string' ? body.signature.trim() : ''
	if (!ethers.isHexString(signature) || ethers.dataLength(signature) < 64) return { success: false as const, error: 'Invalid signature' }
	const codeHash = codeHashOf(code)
	const read = new ethers.Contract(contract, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider())
	const redeem = await read.getRedeem!(codeHash)
	const allowedClaimer = ethers.getAddress(redeem[0])
	const validatorCount = redeem[1] as bigint
	const targetNodeIp = normalizeIp(redeem[2] as string)
	const conetDepinNodeIps = (redeem[3] as string[]).map(normalizeIp)
	const gbMiningNodeCount = redeem[4] as bigint
	const active = Boolean(redeem[7])
	const consumed = Boolean(redeem[8])
	if (!active || consumed) return { success: false as const, error: 'Redeem not active' }
	if (allowedClaimer !== ethers.ZeroAddress && allowedClaimer.toLowerCase() !== claimer.toLowerCase()) {
		return { success: false as const, error: 'Claimer not allowed' }
	}
	if (BigInt(conetDepinNodeIps.length) !== validatorCount) return { success: false as const, error: 'Invalid on-chain DePIN IP count' }
	const recovered = ethers.verifyTypedData(
		validatorDepositRedeemEip712Domain(contract),
		validatorDepositRedeemClaimTypes,
		{
			claimer,
			codeHash,
			beneficiary,
			validatorCount,
			targetNodeIp,
			conetDepinNodeIpsHash: hashStringArray(conetDepinNodeIps),
			gbMiningNodeCount,
			deadline,
		},
		signature
	)
	if (recovered.toLowerCase() !== claimer.toLowerCase()) return { success: false as const, error: 'Signer is not claimer' }
	return { success: true as const, preChecked: { contract, claimer, beneficiary, code, deadline, signature } }
}

export type ValidatorDepositRedeemCreatePayload = {
	contract: string
	admin: string
	codeHash: string
	allowedClaimer: string
	validatorCount: bigint
	targetNodeIp: string
	conetDepinNodeIps: string[]
	gbMiningNodeCount: bigint
	validAfter: bigint
	validBefore: bigint
	nonce: bigint
	deadline: bigint
	signature: string
	res?: Response
}

export type ValidatorDepositRedeemCancelPayload = {
	contract: string
	admin: string
	codeHash: string
	nonce: bigint
	deadline: bigint
	signature: string
	res?: Response
}

export type ValidatorDepositRedeemClaimPayload = {
	contract: string
	claimer: string
	beneficiary: string
	code: string
	deadline: bigint
	signature: string
	res?: Response
}

export const validatorDepositRedeemCreatePool: ValidatorDepositRedeemCreatePayload[] = []
export const validatorDepositRedeemCancelPool: ValidatorDepositRedeemCancelPayload[] = []
export const validatorDepositRedeemClaimPool: ValidatorDepositRedeemClaimPayload[] = []

async function withSettleWallet<T>(poolName: string, fn: (wallet: (typeof Settle_ContractPool)[number]) => Promise<T>): Promise<T | undefined> {
	if (!Settle_ContractPool.length) return undefined
	const sc = Settle_ContractPool.shift()
	if (!sc) return undefined
	try {
		return await fn(sc)
	} finally {
		Settle_ContractPool.unshift(sc)
	}
}

export const validatorDepositRedeemCreateProcess = async () => {
	const obj = validatorDepositRedeemCreatePool.shift()
	if (!obj) return
	if (!Settle_ContractPool.length) {
		validatorDepositRedeemCreatePool.unshift(obj)
		return setTimeout(() => void validatorDepositRedeemCreateProcess(), 3000)
	}
	try {
		const txHash = await withSettleWallet('validatorDepositRedeemCreate', async (sc) => {
			const c = new ethers.Contract(obj.contract, VALIDATOR_DEPOSIT_REDEEM_ABI, sc.walletConet)
			const tx = await c.createRedeemFor!(
				obj.admin,
				obj.codeHash,
				obj.allowedClaimer,
				obj.validatorCount,
				obj.targetNodeIp,
				obj.conetDepinNodeIps,
				obj.gbMiningNodeCount,
				obj.validAfter,
				obj.validBefore,
				obj.nonce,
				obj.deadline,
				obj.signature,
				{ gasLimit: 1_800_000 }
			)
			await tx.wait()
			return tx.hash as string
		})
		if (obj.res && !obj.res.headersSent) obj.res.status(200).json({ success: true, txHash }).end()
	} catch (e: any) {
		const msg = e?.shortMessage ?? e?.message ?? String(e)
		logger(Colors.red('[validatorDepositRedeemCreateProcess] failed:'), msg)
		if (obj.res && !obj.res.headersSent) obj.res.status(400).json({ success: false, error: msg }).end()
	} finally {
		setTimeout(() => void validatorDepositRedeemCreateProcess(), 3000)
	}
}

export const validatorDepositRedeemCancelProcess = async () => {
	const obj = validatorDepositRedeemCancelPool.shift()
	if (!obj) return
	if (!Settle_ContractPool.length) {
		validatorDepositRedeemCancelPool.unshift(obj)
		return setTimeout(() => void validatorDepositRedeemCancelProcess(), 3000)
	}
	try {
		const txHash = await withSettleWallet('validatorDepositRedeemCancel', async (sc) => {
			const c = new ethers.Contract(obj.contract, VALIDATOR_DEPOSIT_REDEEM_ABI, sc.walletConet)
			const tx = await c.cancelRedeemFor!(obj.admin, obj.codeHash, obj.nonce, obj.deadline, obj.signature, { gasLimit: 700_000 })
			await tx.wait()
			return tx.hash as string
		})
		if (obj.res && !obj.res.headersSent) obj.res.status(200).json({ success: true, txHash }).end()
	} catch (e: any) {
		const msg = e?.shortMessage ?? e?.message ?? String(e)
		logger(Colors.red('[validatorDepositRedeemCancelProcess] failed:'), msg)
		if (obj.res && !obj.res.headersSent) obj.res.status(400).json({ success: false, error: msg }).end()
	} finally {
		setTimeout(() => void validatorDepositRedeemCancelProcess(), 3000)
	}
}

export const validatorDepositRedeemClaimProcess = async () => {
	const obj = validatorDepositRedeemClaimPool.shift()
	if (!obj) return
	if (!Settle_ContractPool.length) {
		validatorDepositRedeemClaimPool.unshift(obj)
		return setTimeout(() => void validatorDepositRedeemClaimProcess(), 3000)
	}
	try {
		const txHash = await withSettleWallet('validatorDepositRedeemClaim', async (sc) => {
			const c = new ethers.Contract(obj.contract, VALIDATOR_DEPOSIT_REDEEM_ABI, sc.walletConet)
			const tx = await c.claimRedeemFor!(obj.claimer, obj.beneficiary, obj.code, obj.deadline, obj.signature, { gasLimit: 1_200_000 })
			await tx.wait()
			return tx.hash as string
		})
		if (obj.res && !obj.res.headersSent) obj.res.status(200).json({ success: true, txHash }).end()
	} catch (e: any) {
		const msg = e?.shortMessage ?? e?.message ?? String(e)
		logger(Colors.red('[validatorDepositRedeemClaimProcess] failed:'), msg)
		if (obj.res && !obj.res.headersSent) obj.res.status(400).json({ success: false, error: msg }).end()
	} finally {
		setTimeout(() => void validatorDepositRedeemClaimProcess(), 3000)
	}
}

function runCommand(label: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
		let out = ''
		child.stdout.on('data', (d) => {
			out += d.toString()
		})
		child.stderr.on('data', (d) => {
			out += d.toString()
		})
		child.on('error', reject)
		child.on('close', (code) => {
			if (code === 0) return resolve(out.slice(-4000))
			reject(new Error(`${label} exited ${code}: ${out.slice(-4000)}`))
		})
	})
}

async function executeValidatorRedeem(state: ValidatorRedeemState): Promise<void> {
	const requestId = state.requestId.toLowerCase()
	const dryRun = validatorDryRun()
	const newCoNETDir = resolveNewCoNETDir()
	const depositPrivateKeyFile = resolveDepositPrivateKeyFile()
	if (!fs.existsSync(newCoNETDir)) throw new Error(`newCoNET dir missing: ${newCoNETDir}`)
	if (!dryRun && (!depositPrivateKeyFile || !fs.existsSync(depositPrivateKeyFile))) {
		throw new Error('CONET_VALIDATOR_DEPOSIT_PRIVATE_KEY_FILE missing; deposits require a dedicated private key file')
	}

	const env = {
		...process.env,
		VALIDATOR_COUNT: state.validatorCount,
		WITHDRAWAL_ADDRESS_RAW: state.beneficiary,
		CONFIRM_OVERRIDE_WITHDRAWAL_ADDRESS: 'YES',
		PRIVATE_KEY_FILE: depositPrivateKeyFile,
		DEPOSIT_DATA_FILE: path.join(newCoNETDir, 'validator_deposits.json'),
		RPC_URL: process.env.CONET_VALIDATOR_DEPOSIT_RPC_URL || masterSetup.validatorDeposit?.rpcUrl || resolveBeamioConetHttpRpcUrl(),
		CHAIN_ID: String(CONET_MAINNET_CHAIN_ID),
		DEPOSIT_CONTRACT: CONET_DEPOSIT_CONTRACT,
	}

	const mark = (stage: string, ok: boolean, detail?: string) => {
		upsertState(requestId, (cur) => ({
			...(cur || state),
			status: ok ? 'running' : 'failed',
			updatedAt: new Date().toISOString(),
			error: ok ? cur?.error : detail,
			stages: { ...(cur?.stages || state.stages), [stage]: { ok, at: new Date().toISOString(), detail } },
			depositPrivateKeyFile: depositPrivateKeyFile || undefined,
		}))
	}

	mark('depin-gb-assignment', true, `beneficiary=${state.beneficiary}; depinIps=${state.conetDepinNodeIps.join(',')}; gbMiningNodeCount=${state.gbMiningNodeCount}`)
	if (dryRun) {
		mark('dry-run', true, 'skipped scripts and deposits')
		return
	}

	const generateOut = await runCommand('generate validators', 'bash', ['./01_generate_append_validator_deposits.sh'], newCoNETDir, env)
	mark('generate-validators', true, generateOut)

	if ((process.env.CONET_VALIDATOR_RUN_JOIN_SCRIPT || '').toUpperCase() === 'YES') {
		const joinOut = await runCommand('join/import validators', 'bash', ['./03_join_v714.sh'], newCoNETDir, env)
		mark('join-import-validators', true, joinOut)
	}

	const depositOut = await runCommand(
		'submit deposits',
		'node',
		['./04_submit_validator_deposits.js'],
		newCoNETDir,
		{ ...env, CONFIRM_SUBMIT: 'YES' }
	)
	mark('submit-deposits', true, depositOut)

	const restartOut = await runCommand('restart beacon validator', 'bash', ['./05_restart_beacon_validator.sh'], newCoNETDir, env)
	mark('restart-validator', true, restartOut)
}

let listenerStarted = false

export function startValidatorDepositRedeemListener(): void {
	if (listenerStarted) return
	listenerStarted = true
	if (process.env.CONET_VALIDATOR_REDEEM_LISTENER !== '1') {
		logger(Colors.yellow('[validatorDepositRedeemListener] disabled; set CONET_VALIDATOR_REDEEM_LISTENER=1'))
		return
	}
	const contract = resolveValidatorDepositRedeemAddress()
	const nodeIp = resolveValidatorNodeIp()
	if (!contract || !nodeIp) {
		logger(Colors.red('[validatorDepositRedeemListener] missing contract or nodeIp'))
		return
	}
	const provider = conetProvider()
	const c = new ethers.Contract(contract, VALIDATOR_DEPOSIT_REDEEM_ABI, provider)
	logger(Colors.green(`[validatorDepositRedeemListener] listening contract=${contract} nodeIp=${nodeIp}`))
	c.on('ValidatorRedeemClaimed', (requestId, codeHash, claimer, beneficiary, validatorCount, targetNodeIp, conetDepinNodeIps, gbMiningNodeCount) => {
		const target = normalizeIp(String(targetNodeIp))
		const rid = String(requestId).toLowerCase()
		if (target !== nodeIp) {
			upsertState(rid, () => ({
				requestId: rid,
				codeHash: String(codeHash),
				claimer: ethers.getAddress(String(claimer)),
				beneficiary: ethers.getAddress(String(beneficiary)),
				validatorCount: String(validatorCount),
				targetNodeIp: target,
				conetDepinNodeIps: (conetDepinNodeIps as string[]).map(normalizeIp),
				gbMiningNodeCount: String(gbMiningNodeCount),
				status: 'ignored',
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				stages: { filter: { ok: true, at: new Date().toISOString(), detail: `target ${target} != local ${nodeIp}` } },
			}))
			return
		}
		const existing = getValidatorDepositRedeemStatus(rid)
		if (existing && (existing.status === 'running' || existing.status === 'succeeded')) return
		const next = upsertState(rid, () => ({
			requestId: rid,
			codeHash: String(codeHash),
			claimer: ethers.getAddress(String(claimer)),
			beneficiary: ethers.getAddress(String(beneficiary)),
			validatorCount: String(validatorCount),
			targetNodeIp: target,
			conetDepinNodeIps: (conetDepinNodeIps as string[]).map(normalizeIp),
			gbMiningNodeCount: String(gbMiningNodeCount),
			status: 'received',
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			stages: { event: { ok: true, at: new Date().toISOString(), detail: 'matched local node IP' } },
		}))
		void (async () => {
			try {
				upsertState(rid, (cur) => ({ ...(cur || next), status: 'running', updatedAt: new Date().toISOString() }))
				await executeValidatorRedeem(next)
				upsertState(rid, (cur) => ({ ...(cur || next), status: 'succeeded', updatedAt: new Date().toISOString() }))
			} catch (e: any) {
				const msg = e?.message ?? String(e)
				logger(Colors.red('[validatorDepositRedeemListener] execute failed:'), msg)
				upsertState(rid, (cur) => ({ ...(cur || next), status: 'failed', error: msg, updatedAt: new Date().toISOString() }))
			}
		})()
	})
}
