/**
 * Institutional AA V2 — EIP-712 propose / vote Cluster precheck + typed-data helpers.
 * Proxy gas: Master paymaster calls FactoryInstitutionalV2.propose* / vote.
 * See: .cursor/rules/beamio-aa-account-dev.mdc
 */
import { ethers } from 'ethers'
import { BEAMIO_AA_FACTORY_V2, CONET_MAINNET_CHAIN_ID } from './chainAddresses'
import { resolveBeamioConetHttpRpcUrl } from './util'

const JSONRPC_NO_BATCH = { batchMaxCount: 1, batchStallTime: 0 } as const
const providerConet = new ethers.JsonRpcProvider(resolveBeamioConetHttpRpcUrl(), undefined, JSONRPC_NO_BATCH)

export const AA_V2_EIP712_NAME = 'BeamioAccountInstitutionalV2'
export const AA_V2_EIP712_VERSION = '2'

export const AA_V2_FACTORY_ABI = [
	'function admin() view returns (address)',
	'function isPayMaster(address) view returns (bool)',
	'function setPayMaster(address pm, bool enabled)',
	'function isBeamioAccount(address) view returns (bool)',
	'function nextIndexOfCreator(address creator) view returns (uint256)',
	'function accountLimit() view returns (uint256)',
	'function getAddress(address creator, uint256 index) view returns (address)',
	'function myAccounts(address creator) view returns (address[])',
	'function accountsOfManager(address manager) view returns (address[])',
	'function syncAccountManagers(address account, address[] managers)',
	'function createAccountFor(address creator) returns (address)',
	'function proposeTransfer(address account,address token,address to,uint256 amount,uint64 deadline,bytes32 nonce,bytes signature) returns (uint256)',
	'function proposeSetPolicy(address account,address[] managersSorted,uint256 newThreshold,uint64 deadline,bytes32 nonce,bytes signature) returns (uint256)',
	'function vote(address account,uint256 taskId,bool approve,uint64 deadline,bytes32 nonce,bytes signature)',
] as const

export const AA_V2_ACCOUNT_ABI = [
	'function accountVersion() view returns (uint256)',
	'function factory() view returns (address)',
	'function owner() view returns (address)',
	'function threshold() view returns (uint256)',
	'function isThresholdManager(address) view returns (bool)',
	'function isSoleSelfSigner() view returns (bool)',
	'function policyLockActive() view returns (bool)',
	'function spendable(address token) view returns (uint256)',
	'function nextTaskId() view returns (uint256)',
	'function pendingPolicyTaskId() view returns (uint256)',
	'function reservedOf(address token) view returns (uint256)',
	'function usedSigNonces(bytes32) view returns (bool)',
	'function taskVote(uint256 taskId, address voter) view returns (uint8)',
	'function getTask(uint256 taskId) view returns (uint8 kind,uint8 status,address proposer,address token,address to,uint256 amount,uint256 thresholdSnap,uint256 approveCount,uint256 rejectCount,uint64 deadline,bytes32 managersHash,address[] managersSnap)',
] as const

export const proposeTransferTypes: Record<string, Array<{ name: string; type: string }>> = {
	ProposeTransfer: [
		{ name: 'account', type: 'address' },
		{ name: 'token', type: 'address' },
		{ name: 'to', type: 'address' },
		{ name: 'amount', type: 'uint256' },
		{ name: 'deadline', type: 'uint64' },
		{ name: 'nonce', type: 'bytes32' },
	],
}

export const proposeSetPolicyTypes: Record<string, Array<{ name: string; type: string }>> = {
	ProposeSetPolicy: [
		{ name: 'account', type: 'address' },
		{ name: 'managersHash', type: 'bytes32' },
		{ name: 'newThreshold', type: 'uint256' },
		{ name: 'deadline', type: 'uint64' },
		{ name: 'nonce', type: 'bytes32' },
	],
}

export const voteTypes: Record<string, Array<{ name: string; type: string }>> = {
	Vote: [
		{ name: 'account', type: 'address' },
		{ name: 'taskId', type: 'uint256' },
		{ name: 'approve', type: 'bool' },
		{ name: 'deadline', type: 'uint64' },
		{ name: 'nonce', type: 'bytes32' },
	],
}

export function aaV2Eip712Domain(account: string, chainId: number = CONET_MAINNET_CHAIN_ID) {
	return {
		name: AA_V2_EIP712_NAME,
		version: AA_V2_EIP712_VERSION,
		chainId,
		verifyingContract: ethers.getAddress(account),
	}
}

export function managersHashSorted(managersSorted: string[]): string {
	const sorted = managersSorted.map((a) => ethers.getAddress(a))
	return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address[]'], [sorted]))
}

function assertSigHex(sig: string): string | null {
	if (typeof sig !== 'string' || !sig.startsWith('0x') || sig.length < 132) return 'Invalid signature'
	return null
}

function assertNonce(nonce: string): string | null {
	if (typeof nonce !== 'string' || !ethers.isHexString(nonce) || ethers.dataLength(nonce) !== 32) {
		return 'nonce must be bytes32'
	}
	return null
}

async function assertV2Account(account: string): Promise<string | null> {
	const factory = new ethers.Contract(BEAMIO_AA_FACTORY_V2, AA_V2_FACTORY_ABI, providerConet)
	const ok = (await factory.isBeamioAccount(ethers.getAddress(account))) as boolean
	if (!ok) return 'Not a V2 institutional Smart Wallet'
	const aa = new ethers.Contract(account, AA_V2_ACCOUNT_ABI, providerConet)
	try {
		const ver = (await aa.accountVersion()) as bigint
		if (ver !== 2n) return 'Smart Wallet is not accountVersion 2'
	} catch {
		return 'Failed to read accountVersion'
	}
	return null
}

export type AaV2ProposeTransferBody = {
	account: string
	token: string
	to: string
	amount: string
	deadline: number | string
	nonce: string
	signature: string
	signerEoa: string
}

export type AaV2ProposeSetPolicyBody = {
	account: string
	managersSorted: string[]
	newThreshold: number | string
	deadline: number | string
	nonce: string
	signature: string
	signerEoa: string
}

export type AaV2VoteBody = {
	account: string
	taskId: string | number
	approve: boolean
	deadline: number | string
	nonce: string
	signature: string
	signerEoa: string
}

export async function aaInstitutionalV2ProposeTransferPreCheck(
	body: AaV2ProposeTransferBody
): Promise<
	| { success: true; preChecked: AaV2ProposeTransferBody & { account: string; token: string; to: string; amount: string; deadline: number; signerEoa: string } }
	| { success: false; error: string }
> {
	try {
		if (!ethers.isAddress(body.account) || !ethers.isAddress(body.to) || !ethers.isAddress(body.signerEoa)) {
			return { success: false, error: 'Invalid address' }
		}
		const token =
			!body.token || body.token === ethers.ZeroAddress || body.token === '0x'
				? ethers.ZeroAddress
				: ethers.getAddress(body.token)
		const account = ethers.getAddress(body.account)
		const to = ethers.getAddress(body.to)
		const signerEoa = ethers.getAddress(body.signerEoa)
		const amount = BigInt(String(body.amount))
		if (amount <= 0n) return { success: false, error: 'amount must be > 0' }
		const deadline = Number(body.deadline)
		if (!Number.isFinite(deadline) || deadline <= Math.floor(Date.now() / 1000)) {
			return { success: false, error: 'deadline expired or invalid' }
		}
		const nErr = assertNonce(body.nonce)
		if (nErr) return { success: false, error: nErr }
		const sErr = assertSigHex(body.signature)
		if (sErr) return { success: false, error: sErr }

		const v2Err = await assertV2Account(account)
		if (v2Err) return { success: false, error: v2Err }

		const aa = new ethers.Contract(account, AA_V2_ACCOUNT_ABI, providerConet)
		if (await aa.policyLockActive()) {
			return { success: false, error: 'Policy lock active — transfer proposals are frozen' }
		}
		const spendable = (await aa.spendable(token)) as bigint
		if (amount > spendable) {
			return { success: false, error: `Insufficient spendable (need ${amount}, have ${spendable})` }
		}
		if (await aa.usedSigNonces(body.nonce)) {
			return { success: false, error: 'nonce already used' }
		}

		const domain = aaV2Eip712Domain(account)
		const value = {
			account,
			token,
			to,
			amount,
			deadline,
			nonce: body.nonce,
		}
		const recovered = ethers.verifyTypedData(domain, proposeTransferTypes, value, body.signature)
		if (recovered.toLowerCase() !== signerEoa.toLowerCase()) {
			return { success: false, error: 'Signature does not match signerEoa' }
		}
		const isMgr = (await aa.isThresholdManager(signerEoa)) as boolean
		if (!isMgr) return { success: false, error: 'Signer is not a threshold manager' }

		return {
			success: true,
			preChecked: {
				account,
				token,
				to,
				amount: amount.toString(),
				deadline,
				nonce: body.nonce,
				signature: body.signature,
				signerEoa,
			},
		}
	} catch (e: unknown) {
		const err = e as { shortMessage?: string; message?: string }
		return { success: false, error: err?.shortMessage ?? err?.message ?? String(e) }
	}
}

export async function aaInstitutionalV2ProposeSetPolicyPreCheck(
	body: AaV2ProposeSetPolicyBody
): Promise<
	| {
			success: true
			preChecked: AaV2ProposeSetPolicyBody & {
				account: string
				managersSorted: string[]
				newThreshold: number
				deadline: number
				signerEoa: string
			}
	  }
	| { success: false; error: string }
> {
	try {
		if (!ethers.isAddress(body.account) || !ethers.isAddress(body.signerEoa)) {
			return { success: false, error: 'Invalid address' }
		}
		if (!Array.isArray(body.managersSorted) || body.managersSorted.length === 0) {
			return { success: false, error: 'managersSorted required' }
		}
		const account = ethers.getAddress(body.account)
		const signerEoa = ethers.getAddress(body.signerEoa)
		const managersSorted = body.managersSorted.map((a) => ethers.getAddress(a))
		const newThreshold = Math.floor(Number(body.newThreshold))
		if (newThreshold < 1 || newThreshold > managersSorted.length) {
			return { success: false, error: 'Invalid newThreshold' }
		}
		const deadline = Number(body.deadline)
		if (!Number.isFinite(deadline) || deadline <= Math.floor(Date.now() / 1000)) {
			return { success: false, error: 'deadline expired or invalid' }
		}
		const nErr = assertNonce(body.nonce)
		if (nErr) return { success: false, error: nErr }
		const sErr = assertSigHex(body.signature)
		if (sErr) return { success: false, error: sErr }

		const v2Err = await assertV2Account(account)
		if (v2Err) return { success: false, error: v2Err }

		const aa = new ethers.Contract(account, AA_V2_ACCOUNT_ABI, providerConet)
		if (await aa.policyLockActive()) {
			return { success: false, error: 'Policy lock already active' }
		}
		const owner = ethers.getAddress((await aa.owner()) as string)
		if (managersSorted[0].toLowerCase() !== owner.toLowerCase()) {
			return { success: false, error: 'managersSorted[0] must be Smart Wallet owner' }
		}
		if (await aa.usedSigNonces(body.nonce)) {
			return { success: false, error: 'nonce already used' }
		}

		const mHash = managersHashSorted(managersSorted)
		const domain = aaV2Eip712Domain(account)
		const value = {
			account,
			managersHash: mHash,
			newThreshold,
			deadline,
			nonce: body.nonce,
		}
		const recovered = ethers.verifyTypedData(domain, proposeSetPolicyTypes, value, body.signature)
		if (recovered.toLowerCase() !== signerEoa.toLowerCase()) {
			return { success: false, error: 'Signature does not match signerEoa' }
		}
		const isMgr = (await aa.isThresholdManager(signerEoa)) as boolean
		if (!isMgr) return { success: false, error: 'Signer is not a threshold manager' }

		return {
			success: true,
			preChecked: {
				account,
				managersSorted,
				newThreshold,
				deadline,
				nonce: body.nonce,
				signature: body.signature,
				signerEoa,
			},
		}
	} catch (e: unknown) {
		const err = e as { shortMessage?: string; message?: string }
		return { success: false, error: err?.shortMessage ?? err?.message ?? String(e) }
	}
}

export async function aaInstitutionalV2VotePreCheck(
	body: AaV2VoteBody
): Promise<
	| {
			success: true
			preChecked: AaV2VoteBody & { account: string; taskId: string; deadline: number; signerEoa: string }
	  }
	| { success: false; error: string }
> {
	try {
		if (!ethers.isAddress(body.account) || !ethers.isAddress(body.signerEoa)) {
			return { success: false, error: 'Invalid address' }
		}
		const account = ethers.getAddress(body.account)
		const signerEoa = ethers.getAddress(body.signerEoa)
		const taskId = BigInt(String(body.taskId))
		if (taskId <= 0n) return { success: false, error: 'Invalid taskId' }
		const approve = Boolean(body.approve)
		const deadline = Number(body.deadline)
		if (!Number.isFinite(deadline) || deadline <= Math.floor(Date.now() / 1000)) {
			return { success: false, error: 'deadline expired or invalid' }
		}
		const nErr = assertNonce(body.nonce)
		if (nErr) return { success: false, error: nErr }
		const sErr = assertSigHex(body.signature)
		if (sErr) return { success: false, error: sErr }

		const v2Err = await assertV2Account(account)
		if (v2Err) return { success: false, error: v2Err }

		const aa = new ethers.Contract(account, AA_V2_ACCOUNT_ABI, providerConet)
		const t = await aa.getTask(taskId)
		// TaskStatus: None=0, Pending=1, Executed=2, Cancelled=3, Expired=4
		const status = Number(t.status ?? t[1])
		if (status !== 1) return { success: false, error: 'Task is not pending' }
		// TaskKind: None=0, Transfer=1, SetPolicy=2
		const kind = Number(t.kind ?? t[0])
		if (kind === 1 && (await aa.policyLockActive())) {
			const pendingPolicyId = (await aa.pendingPolicyTaskId()) as bigint
			if (pendingPolicyId !== taskId) {
				return { success: false, error: 'Transfer voting frozen while policy change is pending' }
			}
		}
		if (await aa.usedSigNonces(body.nonce)) {
			return { success: false, error: 'nonce already used' }
		}
		const priorVote = Number((await aa.taskVote(taskId, signerEoa)) as bigint)
		if (priorVote !== 0) return { success: false, error: 'Already voted on this task' }

		const managersSnap: string[] = Array.isArray(t.managersSnap)
			? t.managersSnap
			: Array.isArray(t[11])
				? t[11]
				: []
		const isVoter = managersSnap.some((m) => ethers.getAddress(m).toLowerCase() === signerEoa.toLowerCase())
		if (!isVoter) return { success: false, error: 'Signer is not on this task snapshot' }

		const domain = aaV2Eip712Domain(account)
		const value = {
			account,
			taskId,
			approve,
			deadline,
			nonce: body.nonce,
		}
		const recovered = ethers.verifyTypedData(domain, voteTypes, value, body.signature)
		if (recovered.toLowerCase() !== signerEoa.toLowerCase()) {
			return { success: false, error: 'Signature does not match signerEoa' }
		}

		return {
			success: true,
			preChecked: {
				account,
				taskId: taskId.toString(),
				approve,
				deadline,
				nonce: body.nonce,
				signature: body.signature,
				signerEoa,
			},
		}
	} catch (e: unknown) {
		const err = e as { shortMessage?: string; message?: string }
		return { success: false, error: err?.shortMessage ?? err?.message ?? String(e) }
	}
}
