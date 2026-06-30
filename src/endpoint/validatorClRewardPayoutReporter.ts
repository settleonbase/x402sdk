/**
 * CL consensus-layer skim payout reporter: scans execution-layer block withdrawals
 * credited to ValidatorDepositRedeem proxy, maps validatorIndex → guardianId → current beneficiary,
 * and calls {settleNodeRewards} on-chain (idempotent eventKey per withdrawal).
 *
 * Restart semantics: persists lastProcessedBlock; on boot scans [lastProcessed+1, head] only
 * (never below proxy deploy block / genesis).
 */

import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { ethers } from 'ethers'
import Colors from 'colors/safe'
import { logger } from '../logger'
import { masterSetup, resolveBeamioConetHttpRpcUrl } from '../util'
import { Settle_ContractPool, ensureSettleContractPoolInitialized } from '../settleContractPool'
import { CONET_VALIDATOR_NODE_ONCHAIN_LANE, enqueueOnchainTxWork } from '../onchainTxSerialQueue'
import {
	CONET_VALIDATOR_DEPOSIT_REDEEM,
	CONET_VALIDATOR_DEPOSIT_REDEEM_DEPLOY_BLOCK,
} from '../chainAddresses'
import { resolveValidatorDepositRedeemAddress } from './validatorDepositRedeem'

ensureSettleContractPoolInitialized()

const PAYOUT_ABI = [
	'function settleNodeRewards(uint256[] guardianIds, uint256[] amounts, bytes32[] eventKeys) external',
	'function getNodeByValidatorPubkeyHash(bytes32 pubkeyHash) view returns (uint256 guardianId)',
	'function consumedRewardEventKey(bytes32 key) view returns (bool)',
] as const

type ClPayoutState = {
	lastProcessedBlock: number
	updatedAt: string
}

type BlockWithdrawal = {
	index: string
	validatorIndex: string
	address: string
	amount: string
}

type RpcBlock = {
	number?: string
	withdrawals?: BlockWithdrawal[]
}

type PayoutEntry = {
	guardianId: bigint
	amount: bigint
	eventKey: string
	blockNumber: number
	withdrawalIndex: number
}

let payoutStarted = false
let payoutTimer: ReturnType<typeof setTimeout> | undefined
let payoutInFlight = false

function resolveStateFile(): string {
	return (
		process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_STATE_FILE?.trim() ||
		path.join(homedir(), '.conet-validator-cl-reward-payout-state.json')
	)
}

function resolveBeaconRestUrl(): string {
	return (process.env.CONET_VALIDATOR_BEACON_REST_URL?.trim() || 'http://127.0.0.1:4100').replace(/\/$/, '')
}

function resolveTickMs(): number {
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_TICK_MS || 60_000)
	return Number.isFinite(n) && n >= 15_000 ? Math.floor(n) : 60_000
}

function resolveChunkBlocks(): number {
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_CHUNK_BLOCKS || 32)
	return Number.isFinite(n) && n >= 1 ? Math.min(512, Math.floor(n)) : 32
}

function payoutDryRun(): boolean {
	const v = (process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_DRY_RUN || process.env.CONET_VALIDATOR_DRY_RUN || '').trim().toLowerCase()
	return v === '1' || v === 'true' || v === 'yes'
}

function payoutEnabled(): boolean {
	if (process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT === '0') return false
	if (process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT === '1') return true
	return process.env.CONET_VALIDATOR_REDEEM_LISTENER === '1'
}

function resolveDeployBlockFloor(): number {
	const env =
		process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_DEPLOY_BLOCK?.trim() ||
		process.env.CONET_VALIDATOR_DEPOSIT_REDEEM_DEPLOY_BLOCK?.trim()
	if (env) {
		const n = Number(env)
		if (Number.isFinite(n) && n >= 0) return Math.floor(n)
	}
	return CONET_VALIDATOR_DEPOSIT_REDEEM_DEPLOY_BLOCK
}

function readState(): ClPayoutState {
	const file = resolveStateFile()
	try {
		if (!fs.existsSync(file)) {
			return { lastProcessedBlock: resolveDeployBlockFloor() - 1, updatedAt: new Date().toISOString() }
		}
		const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as ClPayoutState
		const floor = resolveDeployBlockFloor()
		const last = Number(raw.lastProcessedBlock)
		if (!Number.isFinite(last)) {
			return { lastProcessedBlock: floor - 1, updatedAt: new Date().toISOString() }
		}
		return {
			lastProcessedBlock: Math.max(floor - 1, Math.floor(last)),
			updatedAt: raw.updatedAt ?? new Date().toISOString(),
		}
	} catch (e: unknown) {
		logger(Colors.yellow(`[validatorClRewardPayout] state reset: ${(e as Error)?.message ?? e}`))
		return { lastProcessedBlock: resolveDeployBlockFloor() - 1, updatedAt: new Date().toISOString() }
	}
}

function writeState(state: ClPayoutState): void {
	const file = resolveStateFile()
	state.updatedAt = new Date().toISOString()
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8')
}

const validatorPubkeyCache = new Map<number, string | null>()

async function fetchValidatorPubkeyByIndex(validatorIndex: number): Promise<string | null> {
	if (validatorPubkeyCache.has(validatorIndex)) {
		return validatorPubkeyCache.get(validatorIndex) ?? null
	}
	const base = resolveBeaconRestUrl()
	const url = `${base}/eth/v1/beacon/states/head/validators/${validatorIndex}`
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
		if (!res.ok) {
			validatorPubkeyCache.set(validatorIndex, null)
			return null
		}
		const json = (await res.json()) as { data?: { validator?: { pubkey?: string } } }
		const pk = json?.data?.validator?.pubkey?.trim()
		if (!pk) {
			validatorPubkeyCache.set(validatorIndex, null)
			return null
		}
		const normalized = ethers.hexlify(ethers.getBytes(pk.startsWith('0x') ? pk : `0x${pk}`)).toLowerCase()
		validatorPubkeyCache.set(validatorIndex, normalized)
		return normalized
	} catch {
		return null
	}
}

async function fetchBlockWithWithdrawals(
	provider: ethers.JsonRpcProvider,
	blockNumber: number
): Promise<RpcBlock | null> {
	try {
		const hex = ethers.toQuantity(blockNumber)
		const block = (await provider.send('eth_getBlockByNumber', [hex, false])) as RpcBlock | null
		return block
	} catch {
		return null
	}
}

function withdrawalEventKey(blockNumber: number, withdrawalIndex: number): string {
	return ethers.keccak256(
		ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [BigInt(blockNumber), BigInt(withdrawalIndex)])
	)
}

async function resolveGuardianIdForWithdrawal(
	contract: ethers.Contract,
	validatorIndex: number
): Promise<bigint | null> {
	const pubkey = await fetchValidatorPubkeyByIndex(validatorIndex)
	if (!pubkey) return null
	const pkHash = ethers.keccak256(pubkey)
	try {
		const guardianId = await contract.getNodeByValidatorPubkeyHash!(pkHash)
		const gid = BigInt(guardianId)
		return gid > 0n ? gid : null
	} catch {
		return null
	}
}

async function collectPayoutEntriesForBlock(
	contract: ethers.Contract,
	proxyLower: string,
	blockNumber: number,
	block: RpcBlock
): Promise<PayoutEntry[]> {
	const withdrawals = block.withdrawals ?? []
	const entries: PayoutEntry[] = []
	for (const w of withdrawals) {
		const addr = String(w.address ?? '').toLowerCase()
		if (addr !== proxyLower) continue
		const amountGwei = BigInt(String(w.amount ?? '0'))
		if (amountGwei <= 0n) continue
		const amountWei = amountGwei * 1_000_000_000n
		const validatorIndex = Number(w.validatorIndex)
		if (!Number.isFinite(validatorIndex) || validatorIndex < 0) continue
		const withdrawalIndex = Number(w.index)
		if (!Number.isFinite(withdrawalIndex) || withdrawalIndex < 0) continue

		const guardianId = await resolveGuardianIdForWithdrawal(contract, validatorIndex)
		if (guardianId == null) continue

		entries.push({
			guardianId,
			amount: amountWei,
			eventKey: withdrawalEventKey(blockNumber, withdrawalIndex),
			blockNumber,
			withdrawalIndex,
		})
	}
	return entries
}

async function withSettleWallet<T>(label: string, fn: (wallet: (typeof Settle_ContractPool)[number]) => Promise<T>): Promise<T | undefined> {
	if (!Settle_ContractPool.length) return undefined
	const sc = Settle_ContractPool.shift()
	if (!sc) return undefined
	try {
		return await fn(sc)
	} catch (e: unknown) {
		logger(Colors.red(`[validatorClRewardPayout] ${label} failed: ${(e as Error)?.message ?? e}`))
		return undefined
	} finally {
		Settle_ContractPool.unshift(sc)
	}
}

async function submitPayoutBatch(contractAddr: string, entries: PayoutEntry[]): Promise<boolean> {
	if (!entries.length) return true
	return enqueueOnchainTxWork(
		CONET_VALIDATOR_NODE_ONCHAIN_LANE,
		`settleNodeRewards n=${entries.length}`,
		async () => submitPayoutBatchOnchain(contractAddr, entries),
		'[validatorClRewardPayout]'
	)
}

async function submitPayoutBatchOnchain(contractAddr: string, entries: PayoutEntry[]): Promise<boolean> {
	if (!entries.length) return true
	const guardianIds = entries.map((e) => e.guardianId)
	const amounts = entries.map((e) => e.amount)
	const eventKeys = entries.map((e) => e.eventKey)

	if (payoutDryRun()) {
		logger(
			Colors.cyan(
				`[validatorClRewardPayout] dry-run settleNodeRewards n=${entries.length} total=${ethers.formatEther(
					amounts.reduce((a, b) => a + b, 0n)
				)} CNET`
			)
		)
		return true
	}

	const txHash = await withSettleWallet('settleNodeRewards', async (sc) => {
		const c = new ethers.Contract(contractAddr, PAYOUT_ABI, sc.walletConet)
		const tx = await c.settleNodeRewards!(guardianIds, amounts, eventKeys, { gasLimit: 2_000_000 })
		await tx.wait()
		return tx.hash as string
	})

	if (txHash) {
		logger(Colors.green(`[validatorClRewardPayout] settleNodeRewards ok tx=${txHash} n=${entries.length}`))
		return true
	}
	return false
}

async function processBlockRange(
	provider: ethers.JsonRpcProvider,
	readContract: ethers.Contract,
	proxyAddr: string,
	fromBlock: number,
	toBlock: number
): Promise<boolean> {
	const proxyLower = proxyAddr.toLowerCase()
	let allOk = true
	for (let bn = fromBlock; bn <= toBlock; bn++) {
		const block = await fetchBlockWithWithdrawals(provider, bn)
		if (!block) {
			allOk = false
			continue
		}
		const entries = await collectPayoutEntriesForBlock(readContract, proxyLower, bn, block)
		if (!entries.length) continue
		const ok = await submitPayoutBatch(proxyAddr, entries)
		if (!ok) allOk = false
	}
	return allOk
}

async function payoutTick(): Promise<void> {
	if (payoutInFlight) return
	payoutInFlight = true
	try {
		const proxyAddr = resolveValidatorDepositRedeemAddress()
		if (!proxyAddr) {
			logger(Colors.yellow('[validatorClRewardPayout] CONET_VALIDATOR_DEPOSIT_REDEEM not configured — skip'))
			return
		}

		const provider = new ethers.JsonRpcProvider(
			process.env.CONET_VALIDATOR_DEPOSIT_RPC_URL?.trim() ||
				masterSetup.validatorDeposit?.rpcUrl ||
				resolveBeamioConetHttpRpcUrl()
		)
		const readContract = new ethers.Contract(proxyAddr, PAYOUT_ABI, provider)

		const floor = resolveDeployBlockFloor()
		const state = readState()
		const head = Number(await provider.getBlockNumber())
		let from = Math.max(floor, state.lastProcessedBlock + 1)
		if (from > head) return

		const chunk = resolveChunkBlocks()
		logger(
			Colors.cyan(
				`[validatorClRewardPayout] scan blocks ${from}..${head} (floor=${floor}, proxy=${proxyAddr.slice(0, 10)}…)`
			)
		)

		while (from <= head) {
			const to = Math.min(from + chunk - 1, head)
			const ok = await processBlockRange(provider, readContract, proxyAddr, from, to)
			if (!ok) {
				logger(Colors.yellow(`[validatorClRewardPayout] partial failure ${from}..${to}; will retry next tick`))
				break
			}
			state.lastProcessedBlock = to
			writeState(state)
			from = to + 1
		}
	} catch (e: unknown) {
		logger(Colors.red(`[validatorClRewardPayout] tick error: ${(e as Error)?.message ?? e}`))
	} finally {
		payoutInFlight = false
	}
}

function scheduleNextPayoutTick(): void {
	if (!payoutStarted) return
	payoutTimer = setTimeout(async () => {
		await payoutTick()
		scheduleNextPayoutTick()
	}, resolveTickMs())
}

export function startValidatorClRewardPayoutReporter(): void {
	if (payoutStarted) return
	if (!payoutEnabled()) {
		logger(Colors.yellow('[validatorClRewardPayout] disabled (set CONET_VALIDATOR_CL_REWARD_PAYOUT=1)'))
		return
	}
	payoutStarted = true
	const proxy = resolveValidatorDepositRedeemAddress() || CONET_VALIDATOR_DEPOSIT_REDEEM
	logger(
		Colors.cyan(
			`[validatorClRewardPayout] starting proxy=${proxy || 'unset'} floor=${resolveDeployBlockFloor()} tick=${resolveTickMs()}ms`
		)
	)
	void payoutTick().finally(() => scheduleNextPayoutTick())
}

export function stopValidatorClRewardPayoutReporter(): void {
	payoutStarted = false
	if (payoutTimer !== undefined) {
		clearTimeout(payoutTimer)
		payoutTimer = undefined
	}
}
