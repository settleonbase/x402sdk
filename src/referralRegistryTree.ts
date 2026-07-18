import { ethers } from 'ethers'
import { CONET_REFERRAL_REGISTRY_VAULT_V1 } from './chainAddresses'
import {
	getReferralRegistryTreeSync,
	replaceReferralRegistryTreeMembers,
	setReferralRegistryTreeRebuilding,
	tryStartReferralRegistryTreeRebuild,
	type ReferralRegistryTreeMemberRow,
} from './db'
import { resolveBeamioConetHttpRpcUrl } from './util'

export const REFERRAL_REGISTRY_DEPLOY_BLOCK = 431_457
const LOG_CHUNK_BLOCKS = 5_000

const REFERRAL_REGISTRY_ABI = [
	'function admins(address) view returns (bool)',
	'function members(address) view returns (uint8 role,address parentAdmin,address parentL0,uint256 rebateBps,uint256 ratioBps,bool active)',
] as const

const MEMBER_REGISTERED_EVENT = 'MemberRegistered(address indexed account,uint8 role,address indexed parentL0,address indexed parentAdmin)'
const ADMIN_UPDATED_EVENT = 'AdminUpdated(address indexed account,bool enabled)'
const EVENT_INTERFACE = new ethers.Interface([
	`event ${MEMBER_REGISTERED_EVENT}`,
	`event ${ADMIN_UPDATED_EVENT}`,
])
const MEMBER_REGISTERED_TOPIC = ethers.id('MemberRegistered(address,uint8,address,address)')
const ADMIN_UPDATED_TOPIC = ethers.id('AdminUpdated(address,bool)')

let backfillInFlight: Promise<void> | undefined

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function roleFromValue(value: number): ReferralRegistryTreeMemberRow['role'] {
	if (value === 1) return 'l0'
	if (value === 2) return 'l1'
	if (value === 3) return 'merchant'
	return 'none'
}

async function scanRegisteredAccounts(provider: ethers.JsonRpcProvider, latestBlock: number): Promise<Set<string>> {
	const accounts = new Set<string>()
	for (let fromBlock = REFERRAL_REGISTRY_DEPLOY_BLOCK; fromBlock <= latestBlock; fromBlock += LOG_CHUNK_BLOCKS) {
		const toBlock = Math.min(fromBlock + LOG_CHUNK_BLOCKS - 1, latestBlock)
		const logs = await provider.getLogs({
			address: CONET_REFERRAL_REGISTRY_VAULT_V1,
			fromBlock,
			toBlock,
			topics: [[MEMBER_REGISTERED_TOPIC, ADMIN_UPDATED_TOPIC]],
		})
		for (const log of logs) {
			const parsed = EVENT_INTERFACE.parseLog(log)
			if (!parsed) continue
			const account = parsed.args.account as string
			if (ethers.isAddress(account)) accounts.add(ethers.getAddress(account))
		}
	}
	return accounts
}

async function rebuildReferralRegistryTree(): Promise<void> {
	const provider = new ethers.JsonRpcProvider(resolveBeamioConetHttpRpcUrl())
	const registry = new ethers.Contract(CONET_REFERRAL_REGISTRY_VAULT_V1, REFERRAL_REGISTRY_ABI, provider)
	const latestBlock = await provider.getBlockNumber()
	const accounts = await scanRegisteredAccounts(provider, latestBlock)
	const rows: Array<{
		account: string
		isAdmin: boolean
		role: ReferralRegistryTreeMemberRow['role']
		parentAdmin: string | null
		parentL0: string | null
		rebateBps: string
		ratioBps: string
		active: boolean
		firstSeenBlock: string | null
		lastSeenBlock: string | null
		lastTxHash: string | null
	}> = []

	for (const account of accounts) {
		const [isAdmin, member] = await Promise.all([
			registry.admins(account),
			registry.members(account),
		])
		rows.push({
			account,
			isAdmin: Boolean(isAdmin),
			role: roleFromValue(Number(member.role)),
			parentAdmin: ethers.getAddress(member.parentAdmin) === ethers.ZeroAddress ? null : ethers.getAddress(member.parentAdmin),
			parentL0: ethers.getAddress(member.parentL0) === ethers.ZeroAddress ? null : ethers.getAddress(member.parentL0),
			rebateBps: member.rebateBps.toString(),
			ratioBps: member.ratioBps.toString(),
			active: Boolean(member.active),
			firstSeenBlock: null,
			lastSeenBlock: null,
			lastTxHash: null,
		})
	}

	await replaceReferralRegistryTreeMembers(rows, String(latestBlock))
}

export async function ensureReferralRegistryTreeReady(): Promise<void> {
	if (!backfillInFlight) {
		backfillInFlight = (async () => {
			try {
				let sync = await getReferralRegistryTreeSync()
				if (sync.syncedThroughBlock !== null) return
				while (!(await tryStartReferralRegistryTreeRebuild())) {
					await delay(500)
					sync = await getReferralRegistryTreeSync()
					if (sync.syncedThroughBlock !== null) return
				}
				await rebuildReferralRegistryTree()
			} catch (error) {
				await setReferralRegistryTreeRebuilding(false)
				throw error
			} finally {
				backfillInFlight = undefined
			}
		})()
	}
	return backfillInFlight
}

export async function rebuildReferralRegistryTreeNow(): Promise<void> {
	if (!backfillInFlight) {
		backfillInFlight = (async () => {
			await setReferralRegistryTreeRebuilding(true)
			try {
				await rebuildReferralRegistryTree()
			} catch (error) {
				await setReferralRegistryTreeRebuilding(false)
				throw error
			} finally {
				backfillInFlight = undefined
			}
		})()
	}
	return backfillInFlight
}
