import { ethers } from "ethers"
import { Client } from "pg"
import AccountRegistryAbi from "./ABI/beamio-AccountRegistry.json"
import { logger } from "./logger"
import { inspect } from "util"
import { Request, Response} from 'express'
import Colors from 'colors/safe'
import {masterSetup, resolveBeamioBaseHttpRpcUrl} from './util'
import beamioConetABI from './ABI/beamio-conet.abi.json'
import conetAirdropABI from './ABI/conet_airdrop.abi.json'
import AccountRegistryABI from './ABI/beamio-AccountRegistry.json'
import IPFSAbi from './ABI/Ipfs.abi.json'
import conetPGPABI from './ABI/conetPGP.json'
import {
	normalizeCouponSeriesMetadataJson,
	normalizeProductionSeriesMetadataJson,
	filterClientCouponSeriesRows,
	filterClientProductionSeriesRows,
	seriesMetadataLooksLikeProduction,
} from './couponMetadataCategory'

/**
 * 
 * 
 * 
 */


const RPC_URL = "https://rpc1.conet.network"
const BASE_RPC_URL = resolveBeamioBaseHttpRpcUrl()

/**
 * 判断一次 ethers `view`/`pure` 调用的异常是否等价于「链上无数据」。
 * 当合约返回 0x（如 `getOwnerByAccountName(未注册名字)` / `getAccount(未注册地址)`）时，
 * ethers v6 抛出 `BAD_DATA: could not decode result data (value="0x", ...)`。
 * 这等价于「该 key 不存在」而不是真正的 RPC/合约错误，调用方应当作 `ZeroAddress`/`undefined` 处理。
 */
export const isOnchainEmptyResult = (ex: any): boolean => {
	if (!ex) return false
	if (ex.code === 'BAD_DATA') return true
	const msg: string = ex.shortMessage || ex.message || String(ex)
	return /could not decode result data|value="0x"|BAD_DATA/i.test(msg)
}

const providerConet = new ethers.JsonRpcProvider(RPC_URL)
const providerBase = new ethers.JsonRpcProvider(BASE_RPC_URL)

const beamioConet = '0xCE8e2Cda88FfE2c99bc88D9471A3CBD08F519FEd'
const airdropRecord = '0x070BcBd163a3a280Ab6106bA62A079f228139379'
const beamioConetAccountRegistry = '0x26626a515EDFb5DF9547ac1A32Ec1785352211Ba'
const IpfsStorageRegistryGlobalDedup = '0x121c4dDCa92f07dc53Fd6Db9bc5A07c2918F9591'
const addressPGP = '0xa5F64dd3c034442F5377c8F2Aa1A03ba378D685e'

export const beamio_ContractPool = masterSetup.beamio_Admins.map(n => {
	const walletConet = new ethers.Wallet(n, providerConet)
	logger(`address => ${walletConet.address}`)

	return {
		// baseWalletClient: walletClientBase,
		
		privateKey: n,
		wallet: walletConet,
		conetSC: new ethers.Contract(beamioConet, beamioConetABI, walletConet),
		// event: new ethers.Contract(eventContract, Event_ABI, walletConet),
		conetAirdrop: new ethers.Contract(airdropRecord, conetAirdropABI, walletConet),
		constAccountRegistry: new ethers.Contract(beamioConetAccountRegistry, AccountRegistryABI, walletConet),
		constIPFS: new ethers.Contract(IpfsStorageRegistryGlobalDedup, IPFSAbi, walletConet),
		constPgpManager: new ethers.Contract(addressPGP, conetPGPABI as any, walletConet),
	}
})

const ACCOUNT_REGISTRY_ADMIN_ABI = [
	'function changeAddressInAdminlist(address account, bool status) external',
	'function isAdmin(address account) view returns (bool)',
] as const

const normRegistryAdminPk = (s: string): string => {
	const t = s.trim()
	return t.startsWith('0x') ? t : `0x${t}`
}

const isRegistryAdminPrivateKeyHex = (s: string): boolean => {
	const hex = s.trim().startsWith('0x') ? s.trim().slice(2) : s.trim()
	return hex.length === 64 && /^[0-9a-fA-F]+$/.test(hex)
}

/** ~/.master.json 中应登记为 AccountRegistry admin 的运维钱包地址（去重） */
const collectAccountRegistryAdminTargetAddresses = (): string[] => {
	const lower = new Set<string>()
	const addPk = (pk: string) => {
		if (!isRegistryAdminPrivateKeyHex(pk)) return
		lower.add(new ethers.Wallet(normRegistryAdminPk(pk)).address.toLowerCase())
	}

	for (const pk of masterSetup.beamio_Admins ?? []) addPk(String(pk))
	for (const pk of masterSetup.settle_contractAdmin ?? []) addPk(String(pk))

	const adminList = (masterSetup as { admin?: unknown[] }).admin
	if (Array.isArray(adminList)) {
		for (const entry of adminList) {
			if (typeof entry !== 'string') continue
			const t = entry.trim()
			if (ethers.isAddress(t)) {
				lower.add(ethers.getAddress(t).toLowerCase())
			} else if (isRegistryAdminPrivateKeyHex(t)) {
				addPk(t)
			}
		}
	}

	const extra = process.env.ACCOUNT_REGISTRY_EXTRA_ADMINS?.trim() ?? process.env.REGISTRY_EXTRA_ADMINS?.trim() ?? ''
	if (extra) {
		for (const part of extra.split(/[,;\s]+/).filter(Boolean)) {
			const p = part.trim()
			if (ethers.isAddress(p)) lower.add(ethers.getAddress(p).toLowerCase())
		}
	}

	return [...lower].map((a) => ethers.getAddress(a))
}

/** 可用于 changeAddressInAdminlist 的 signer 候选（须链上已是 admin） */
const collectAccountRegistryOwnerSignerCandidates = (): ethers.Wallet[] => {
	const seen = new Set<string>()
	const wallets: ethers.Wallet[] = []
	const tryAdd = (pkRaw: string | undefined) => {
		if (!pkRaw || !isRegistryAdminPrivateKeyHex(pkRaw)) return
		const pk = normRegistryAdminPk(pkRaw)
		if (seen.has(pk)) return
		seen.add(pk)
		wallets.push(new ethers.Wallet(pk, providerConet))
	}

	tryAdd(process.env.REGISTRY_OWNER_PK?.trim())
	for (const pk of masterSetup.settle_contractAdmin ?? []) tryAdd(String(pk))
	for (const pk of masterSetup.beamio_Admins ?? []) tryAdd(String(pk))

	const adminList = (masterSetup as { admin?: unknown[] }).admin
	if (Array.isArray(adminList)) {
		for (const entry of adminList) {
			if (typeof entry === 'string' && isRegistryAdminPrivateKeyHex(entry)) tryAdd(entry)
		}
	}

	return wallets
}

let accountRegistryAdminBootstrapDone = false

/**
 * Master 启动时：检查 ~/.master.json 中 beamio_Admins / settle_contractAdmin 是否已在
 * AccountRegistry admin 列表；缺失则尝试用已有 admin signer 登记。
 * 修复 addUserPoolProcess 的 NotAdmin()（224422 新 Registry 部署后常见）。
 */
export const ensureAccountRegistryBeamioAdmins = async (): Promise<void> => {
	if (accountRegistryAdminBootstrapDone) return
	accountRegistryAdminBootstrapDone = true

	const targets = collectAccountRegistryAdminTargetAddresses()
	if (!targets.length) {
		logger(Colors.yellow('[ensureAccountRegistryBeamioAdmins] no target admin addresses in masterSetup'))
		return
	}

	const registryRead = new ethers.Contract(beamioConetAccountRegistry, ACCOUNT_REGISTRY_ADMIN_ABI, providerConet)

	const missing: string[] = []
	for (const addr of targets) {
		try {
			const ok = await registryRead.isAdmin(addr)
			if (!ok) missing.push(addr)
		} catch (ex: any) {
			logger(Colors.yellow(`[ensureAccountRegistryBeamioAdmins] isAdmin(${addr}) failed: ${ex?.message ?? ex}`))
			missing.push(addr)
		}
	}

	if (!missing.length) {
		logger(Colors.green(`[ensureAccountRegistryBeamioAdmins] all ${targets.length} ops wallet(s) are AccountRegistry admins`))
		return
	}

	logger(
		Colors.cyan(
			`[ensureAccountRegistryBeamioAdmins] ${missing.length}/${targets.length} wallet(s) missing admin — registering…`
		)
	)

	let adminSigner: ethers.Wallet | null = null
	for (const candidate of collectAccountRegistryOwnerSignerCandidates()) {
		try {
			if (await registryRead.isAdmin(candidate.address)) {
				adminSigner = candidate
				break
			}
		} catch {
			// try next signer
		}
	}

	if (!adminSigner) {
		logger(
			Colors.red(
				'[ensureAccountRegistryBeamioAdmins] no signer is AccountRegistry admin — set REGISTRY_OWNER_PK to deployer key or run scripts/addBeamioAdminsToAccountRegistry.ts'
			)
		)
		return
	}

	logger(Colors.cyan(`[ensureAccountRegistryBeamioAdmins] using admin signer ${adminSigner.address}`))

	const registryWrite = new ethers.Contract(beamioConetAccountRegistry, ACCOUNT_REGISTRY_ADMIN_ABI, adminSigner)

	for (const addr of missing) {
		try {
			const already = await registryRead.isAdmin(addr)
			if (already) continue
			const tx = await registryWrite.changeAddressInAdminlist(addr, true)
			logger(Colors.cyan(`[ensureAccountRegistryBeamioAdmins] changeAddressInAdminlist(${addr}, true) tx=${tx.hash}`))
			await tx.wait()
			logger(Colors.green(`[ensureAccountRegistryBeamioAdmins] registered admin ${addr}`))
		} catch (ex: any) {
			const msg = ex?.shortMessage || ex?.message || String(ex)
			logger(Colors.red(`[ensureAccountRegistryBeamioAdmins] failed for ${addr}: ${msg}`))
		}
	}
}

const ADDRESS_PGP_ADMIN_ABI = [
	'function changeAddressInAdminlist(address addr, bool status) external',
	'function adminList(address) view returns (bool)',
] as const

const collectAddressPgpOwnerSignerCandidates = (): ethers.Wallet[] => {
	const seen = new Set<string>()
	const wallets: ethers.Wallet[] = []
	const tryAdd = (pkRaw: string | undefined) => {
		if (!pkRaw || !isRegistryAdminPrivateKeyHex(pkRaw)) return
		const pk = normRegistryAdminPk(pkRaw)
		if (seen.has(pk)) return
		seen.add(pk)
		wallets.push(new ethers.Wallet(pk, providerConet))
	}

	tryAdd(process.env.ADDRESS_PGP_ADMIN_PK?.trim())
	tryAdd(process.env.REGISTRY_OWNER_PK?.trim())
	for (const pk of masterSetup.settle_contractAdmin ?? []) tryAdd(String(pk))
	for (const pk of masterSetup.beamio_Admins ?? []) tryAdd(String(pk))

	const adminList = (masterSetup as { admin?: unknown[] }).admin
	if (Array.isArray(adminList)) {
		for (const entry of adminList) {
			if (typeof entry === 'string' && isRegistryAdminPrivateKeyHex(entry)) tryAdd(entry)
		}
	}

	return wallets
}

let addressPgpAdminBootstrapDone = false

/** Master 启动时：登记 beamio_Admins 为 AddressPGP admin，修复 regiestChatRoute addPublicPGPByAdmin not admin。 */
export const ensureAddressPgpBeamioAdmins = async (): Promise<void> => {
	if (addressPgpAdminBootstrapDone) return
	addressPgpAdminBootstrapDone = true

	const targets = collectAccountRegistryAdminTargetAddresses()
	if (!targets.length) {
		logger(Colors.yellow('[ensureAddressPgpBeamioAdmins] no target admin addresses in masterSetup'))
		return
	}

	const pgpRead = new ethers.Contract(addressPGP, ADDRESS_PGP_ADMIN_ABI, providerConet)

	const missing: string[] = []
	for (const addr of targets) {
		try {
			const ok = await pgpRead.adminList(addr)
			if (!ok) missing.push(addr)
		} catch (ex: any) {
			logger(Colors.yellow(`[ensureAddressPgpBeamioAdmins] adminList(${addr}) failed: ${ex?.message ?? ex}`))
			missing.push(addr)
		}
	}

	if (!missing.length) {
		logger(Colors.green(`[ensureAddressPgpBeamioAdmins] all ${targets.length} ops wallet(s) are AddressPGP admins`))
		return
	}

	logger(
		Colors.cyan(
			`[ensureAddressPgpBeamioAdmins] ${missing.length}/${targets.length} wallet(s) missing admin — registering…`
		)
	)

	let adminSigner: ethers.Wallet | null = null
	for (const candidate of collectAddressPgpOwnerSignerCandidates()) {
		try {
			if (await pgpRead.adminList(candidate.address)) {
				adminSigner = candidate
				break
			}
		} catch {
			// try next signer
		}
	}

	if (!adminSigner) {
		logger(
			Colors.red(
				'[ensureAddressPgpBeamioAdmins] no signer is AddressPGP admin — set ADDRESS_PGP_ADMIN_PK or run scripts/addBeamioAdminsToAddressPGP.ts'
			)
		)
		return
	}

	logger(Colors.cyan(`[ensureAddressPgpBeamioAdmins] using admin signer ${adminSigner.address}`))

	const pgpWrite = new ethers.Contract(addressPGP, ADDRESS_PGP_ADMIN_ABI, adminSigner)

	for (const addr of missing) {
		try {
			const already = await pgpRead.adminList(addr)
			if (already) continue
			const tx = await pgpWrite.changeAddressInAdminlist(addr, true)
			logger(Colors.cyan(`[ensureAddressPgpBeamioAdmins] changeAddressInAdminlist(${addr}, true) tx=${tx.hash}`))
			await tx.wait()
			logger(Colors.green(`[ensureAddressPgpBeamioAdmins] registered admin ${addr}`))
		} catch (ex: any) {
			const msg = ex?.shortMessage || ex?.message || String(ex)
			logger(Colors.red(`[ensureAddressPgpBeamioAdmins] failed for ${addr}: ${msg}`))
		}
	}
}

let initProcess = false

const initDB = async () => {

	if (initProcess) {
		return
	}
	initProcess = true
	const db = new Client({ connectionString: DB_URL })
	await db.connect()


	// 1) 全量同步用户（用合约的 getAccountsPaginated，倒序也没关系）
	let cursor = 0n
	const pageSize = 500n
	const contract = beamio_ContractPool[0].constAccountRegistry
	while (true) {
		const [owners, names, createdAts, nextCursor] =
		await contract.getAccountsPaginated(cursor, pageSize)

		if (owners.length === 0) break

		for (let i = 0; i < owners.length; i++) {
		const address = owners[i]
		const username = names[i]
		const createdAt = createdAts[i]

		logger(inspect({owners, names, createdAts, nextCursor}, false, 3, true))

		// 可以再调用 getAccount(address) 拿其他字段，也可以先只存 username + createdAt
		await db.query(
			`
			INSERT INTO accounts (address, username, created_at)
			VALUES ($1, $2, $3)
			ON CONFLICT (address) DO UPDATE
			SET username = EXCLUDED.username,
				created_at = EXCLUDED.created_at,
				updated_at = NOW()
			`,
			[address.toLowerCase(), username, createdAt.toString()]
		)
		}

		const next = BigInt(nextCursor)
		if (next === cursor) break
		cursor = next
	}

	// 2) 同步 follow 关系（可以按用户遍历或按 event 扫）
	// 这里演示按用户扫 followList（简单但可能慢，后面可以改用事件）
	const { rows } = await db.query("SELECT address FROM accounts")
	const followPageSize = 500n

	for (const row of rows) {
		const addr: string = row.address

		let fCursor = 0n
		while (true) {
		const [follows, timestamps, nextCursor, total] =
			await contract.getFollowsPaginated(addr, fCursor, followPageSize)

		if (follows.length === 0) break

		for (let i = 0; i < follows.length; i++) {
			const followee = follows[i]
			const ts = timestamps[i]

			await db.query(
			`
			INSERT INTO follows (follower, followee, followed_at)
			VALUES ($1, $2, $3)
			ON CONFLICT (follower, followee) DO UPDATE
				SET followed_at = EXCLUDED.followed_at
			`,
			[addr.toLowerCase(), followee.toLowerCase(), ts.toString()]
			)
		}

		const nf = BigInt(nextCursor)
		if (nf === fCursor || nf >= BigInt(total)) break
			fCursor = nf
		}
	}

	await db.end()
}

type BeamioFollow = {
  follower: string      // 0x...
  followee: string      // 0x...
  followedAt: bigint    // 链上 timestamp（秒）
}

const updateUserFollowsDB = async (follows: BeamioFollow[], db: Client) => {
	if (!follows.length) return

	// 批量插入（这里简单循环，你以后可以优化成 multi-values）
	for (const f of follows) {
		const follower = f.follower.toLowerCase()
		const followee = f.followee.toLowerCase()
		const followedAtStr = f.followedAt.toString()

		await db.query(
		`
		INSERT INTO follows (follower, followee, followed_at)
		VALUES ($1, $2, $3)
		ON CONFLICT (follower, followee) DO UPDATE SET
			followed_at = EXCLUDED.followed_at
		`,
		[follower, followee, followedAtStr]
		)
	}
}

const updateUserDB = async (account: beamioAccount) => {
	const now = new Date()
	const db = new Client({ connectionString: DB_URL })
	await db.connect()
	// 防御性：规范一下 address + createdAt
	const address = account.address.toLowerCase()
	const createdAtStr =
		typeof account.createdAt === "bigint"
		? account.createdAt.toString()
		: new Date().getTime()

	await db.query(
		`
			INSERT INTO accounts (
			address,
			username,
			image,
			dark_theme,
			is_usdc_faucet,
			is_eth_faucet,
			initial_loading,
			first_name,
			last_name,
			created_at,
			updated_at
			)
			VALUES (
			$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
			)
			ON CONFLICT (address) DO UPDATE SET
			username        = EXCLUDED.username,
			image           = EXCLUDED.image,
			dark_theme      = EXCLUDED.dark_theme,
			is_usdc_faucet  = EXCLUDED.is_usdc_faucet,
			is_eth_faucet   = EXCLUDED.is_eth_faucet,
			initial_loading = EXCLUDED.initial_loading,
			first_name      = EXCLUDED.first_name,
			last_name       = EXCLUDED.last_name,
			created_at      = EXCLUDED.created_at,
			updated_at      = EXCLUDED.updated_at
		`,
		[
			address,
			account.accountName,
			account.image ?? null,
			account.darkTheme,
			account.isUSDCFaucet,
			account.isETHFaucet,
			account.initialLoading,
			account.firstName ?? null,
			account.lastName ?? null,
			createdAtStr,
			now
		]
	)

	
	logger(`updateUserDB success! `, inspect(account, false, 3, true))

	await db.end()
}

/** 链上该 handle 未绑定时，清除本地 accounts 表中仍挂着该用户名的陈旧缓存（采信链上）。 */
const clearStaleUsernameFromDb = async (accountName: string): Promise<void> => {
	const nameNorm = String(accountName || '').trim()
	if (!nameNorm) return
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		const r = await db.query(
			`
			UPDATE accounts
			SET username = ''
			WHERE LOWER(TRIM(COALESCE(username, ''))) = LOWER($1)
			`,
			[nameNorm]
		)
		const n = r.rowCount ?? 0
		if (n > 0) {
			logger(
				Colors.yellow(
					`[clearStaleUsernameFromDb] cleared stale handle "${nameNorm}" from ${n} row(s) (align with chain)`
				)
			)
		}
	} finally {
		await db.end().catch(() => {})
	}
}

type GetUserDataResult = {
	address: string
	username: string
	image: string
	darkTheme: boolean
	isUSDCFaucet: boolean
	isETHFaucet: boolean
	initialLoading: boolean
	firstName: string
	lastName: string
	createdAt: bigint
}

const rowToGetUserDataResult = (r: Record<string, unknown>): GetUserDataResult => {
	const ca = r.created_at
	let createdAt: bigint
	if (ca == null || ca === "") {
		createdAt = BigInt(Date.now())
	} else if (typeof ca === "bigint") {
		createdAt = ca
	} else {
		createdAt = BigInt(String(ca))
	}
	return {
		address: String(r.address ?? "").toLowerCase(),
		username: String(r.username ?? ""),
		image: String(r.image ?? ""),
		darkTheme: Boolean(r.dark_theme),
		isUSDCFaucet: Boolean(r.is_usdc_faucet),
		isETHFaucet: Boolean(r.is_eth_faucet),
		initialLoading: r.initial_loading !== false,
		firstName: String(r.first_name ?? ""),
		lastName: String(r.last_name ?? ""),
		createdAt,
	}
}

/** 仅读本地 DB，不访问链。 */
const getUserDataFromDbByUsername = async (
	userName: string
): Promise<GetUserDataResult | null> => {
	const nameNorm = String(userName || "").trim()
	if (!nameNorm) return null
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		const { rows } = await db.query(
			`
			SELECT address, username, image, dark_theme, is_usdc_faucet, is_eth_faucet,
				initial_loading, first_name, last_name, created_at
			FROM accounts
			WHERE LOWER(TRIM(COALESCE(username, ''))) = LOWER($1)
			LIMIT 1
			`,
			[nameNorm]
		)
		const row = rows[0] as Record<string, unknown> | undefined
		if (!row) return null
		return rowToGetUserDataResult(row)
	} catch (e: any) {
		logger(
			Colors.yellow(`[getUserDataFromDbByUsername] ${e?.message ?? e}`)
		)
		return null
	} finally {
		await db.end().catch(() => {})
	}
}

/** 可信链上数据拉取并写回本地（供 getUserData 后台调用）。 */
const syncUserDataFromChainToDb = async (userName: string): Promise<void> => {
	const SC = beamio_ContractPool[0].constAccountRegistry
	const nameNorm = String(userName || "").trim()
	if (!nameNorm) return

	try {
		// getOwnerByAccountName 在新 registry 上对未注册的 username 会返回 0x（BAD_DATA），
		// 这等价于「名字未被占用」，不是错误。其它异常（RPC 抖动等）仍走外层 catch 报错。
		let owner: string
		try {
			owner = await SC.getOwnerByAccountName(nameNorm)
		} catch (probeEx: any) {
			if (!isOnchainEmptyResult(probeEx)) throw probeEx
			owner = ethers.ZeroAddress
		}

		if (!owner || owner === ethers.ZeroAddress) {
			logger(`[syncUserDataFromChainToDb] username not found on-chain: ${nameNorm}`)
			try {
				await clearStaleUsernameFromDb(nameNorm)
			} catch (cle: any) {
				logger(
					Colors.yellow(
						`[syncUserDataFromChainToDb] clearStaleUsernameFromDb failed: ${cle?.message ?? cle}`
					)
				)
			}
			return
		}

		const onchain = await SC.getAccount(owner)
		const accountName: string = onchain.accountName
		const image: string = onchain.image
		const darkTheme: boolean = onchain.darkTheme
		const isUSDCFaucet: boolean = onchain.isUSDCFaucet
		const isETHFaucet: boolean = onchain.isETHFaucet
		const initialLoading: boolean = onchain.initialLoading
		const firstName: string = onchain.firstName
		const lastName: string = onchain.lastName
		const createdAt: bigint = onchain.createdAt * BigInt(1000)
		const exists: boolean = onchain.exists

		if (!exists) {
			logger(
				`[syncUserDataFromChainToDb] account.exists = false on-chain for ${owner} (${nameNorm})`
			)
			return
		}

		const db = new Client({ connectionString: DB_URL })
		await db.connect()
		const now = new Date()

		await db.query(
			`
			INSERT INTO accounts (
				address,
				username,
				image,
				dark_theme,
				is_usdc_faucet,
				is_eth_faucet,
				initial_loading,
				first_name,
				last_name,
				created_at,
				updated_at
			)
			VALUES (
				$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
			)
			ON CONFLICT (address) DO UPDATE SET
				username        = EXCLUDED.username,
				image           = EXCLUDED.image,
				dark_theme      = EXCLUDED.dark_theme,
				is_usdc_faucet  = EXCLUDED.is_usdc_faucet,
				is_eth_faucet   = EXCLUDED.is_eth_faucet,
				initial_loading = EXCLUDED.initial_loading,
				first_name      = EXCLUDED.first_name,
				last_name       = EXCLUDED.last_name,
				created_at      = EXCLUDED.created_at,
				updated_at      = EXCLUDED.updated_at
			`,
			[
				owner.toLowerCase(),
				accountName,
				image,
				darkTheme,
				isUSDCFaucet,
				isETHFaucet,
				initialLoading,
				firstName || null,
				lastName || null,
				createdAt.toString(),
				now,
			]
		)

		logger(
			`[syncUserDataFromChainToDb] synced user ${nameNorm} (${owner}) from chain to DB`
		)
		await db.end()
	} catch (ex: any) {
		logger(
			`[syncUserDataFromChainToDb] failed for username=${nameNorm}:`,
			ex?.shortMessage || ex?.message || ex
		)
	}
}

const syncUserDataFromChainInFlight = new Map<string, Promise<void>>()

const enqueueSyncUserDataFromChain = (userName: string): void => {
	const k = String(userName || "").trim()
	if (!k) return
	let p = syncUserDataFromChainInFlight.get(k)
	if (p) {
		void p.catch(() => {})
		return
	}
	p = syncUserDataFromChainToDb(userName)
		.catch((e: any) =>
			logger(
				Colors.yellow(
					`[getUserData] background sync failed: ${e?.message ?? e}`
				)
			)
		)
		.finally(() => {
			syncUserDataFromChainInFlight.delete(k)
		})
	syncUserDataFromChainInFlight.set(k, p)
	void p
}

/**
 * 先返回本地 DB 缓存（若有），再异步拉取链上可信数据并 upsert 本地。
 * 无本地行时返回 null，后台仍尝试同步（例如链上已有、本地未写入）。
 */
const getUserData = async (
	userName: string
): Promise<GetUserDataResult | null> => {
	const local = await getUserDataFromDbByUsername(userName)
	enqueueSyncUserDataFromChain(userName)
	return local
}


const addUserPool: IAddUserPool [] = []
const addFollowPool: {
	wallet: string
	followAddress: string
	remove: boolean
}[] = []

const regiestChatRoutePool: {
	wallet: string
	keyID: string
	publicKeyArmored: string
	encrypKeyArmored: string
	routeKeyID: string
	res: Response
}[] = []


/** 清洗 firstName/lastName，防止前端误把 JSON 等拼接到字段中 */
const sanitizeName = (s: string | undefined): string => {
	if (s == null || typeof s !== 'string') return ''
	return String(s).split(/[\r\n]/)[0].trim().slice(0, 128)
}

/** 历史 NFC 自动登记曾把 uid / SUN TagID 写入 firstName / lastName（纯 hex）。 */
const NFC_LEGACY_STORED_NAME_HEX_RE = /^[0-9A-Fa-f]{8,32}$/

const isLegacyNfcStoredProfileName = (s: string): boolean => {
	const t = String(s || '').trim()
	return t !== '' && NFC_LEGACY_STORED_NAME_HEX_RE.test(t)
}

const nfcProfileNamesNeedClear = (firstName: string, lastName: string): boolean =>
	isLegacyNfcStoredProfileName(firstName) || isLegacyNfcStoredProfileName(lastName)

/** NFC 持卡 beamioTag 登记：链上 profile 的 first/last 须为空（uid/tagId 仅存 DB，不进 AccountRegistry 姓名）。 */
const NFC_BEAMIO_PROFILE_FIRST_NAME = ''
const NFC_BEAMIO_PROFILE_LAST_NAME = ''

/** 与 Cluster `/addUser` 一致：beamioTag 仅允许 3–20 位字母数字与 _ . */
const BEAMIO_ACCOUNT_NAME_RE = /^[a-zA-Z0-9_.]{3,20}$/

/**
 * NFC CashTree 基础设施卡发卡后的 beamioTag：语义为 CashTreeDamo-{NFT#}，链上/接口不允许 `-`，用 `_`。
 * 过长时缩短为 `CT_` + tokenId 尾部，仍超长则用 `c` + keccak 前 19 位 hex（总长 20）。
 */
export const buildCashTreeNfcBeamioAccountName = (tierTokenId: string): string => {
	const raw = String(tierTokenId || '').replace(/\s/g, '')
	if (!raw || !/^\d+$/.test(raw)) return ''
	let candidate = `CashTreeDamo_${raw}`
	if (candidate.length <= 20 && BEAMIO_ACCOUNT_NAME_RE.test(candidate)) return candidate
	const tail = raw.length > 14 ? raw.slice(-14) : raw
	candidate = `CT_${tail}`
	if (candidate.length <= 20 && BEAMIO_ACCOUNT_NAME_RE.test(candidate)) return candidate
	const h = ethers.keccak256(ethers.toUtf8Bytes(`nfcCashTree:${raw}`)).slice(2, 21)
	return (`c${h}`).slice(0, 20)
}

/** 根据 UID 查 NFC 卡 tag_id（SUN TagID），无则 null */
export const getNfcTagIdByUid = async (uid: string): Promise<string | null> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await db.query(NFC_CARDS_TABLE)
		await db.query(NFC_CARDS_ADD_TAG_ID)
		const u = String(uid || '').trim().toLowerCase()
		if (!u) return null
		const { rows } = await db.query<{ tag_id: string | null }>(
			`SELECT tag_id FROM nfc_cards WHERE LOWER(TRIM(uid)) = $1 LIMIT 1`,
			[u]
		)
		const t = rows[0]?.tag_id
		if (t == null || String(t).trim() === '') return null
		return String(t).trim().toUpperCase()
	} catch (e: any) {
		logger(Colors.yellow(`[getNfcTagIdByUid] failed: ${e?.message ?? e}`))
		return null
	} finally {
		await db.end().catch(() => {})
	}
}

/**
 * NFC 持卡 EOA 在 AccountRegistry 上登记/补全 beamioTag（服务端 setAccountByAdmin 队列）。
 * 若用户已有**其他** beamioTag（与本次期望名不同），不覆盖。
 */
export const maybeEnqueueNfcCashTreeBeamioTag = (params: {
	wallet: string
	uid: string
	tagIdHex?: string | null
	tierTokenId: string
}): void => {
	void (async () => {
		try {
			const wallet = ethers.getAddress(String(params.wallet || '').trim())
			const uid = String(params.uid || '').trim()
			const tierTokenId = String(params.tierTokenId || '').trim()
			if (!uid || !tierTokenId || tierTokenId === '0') return

			const expectedName = buildCashTreeNfcBeamioAccountName(tierTokenId)
			if (!expectedName || !BEAMIO_ACCOUNT_NAME_RE.test(expectedName)) {
				logger(Colors.yellow(`[maybeEnqueueNfcCashTreeBeamioTag] invalid accountName derived from tokenId=${tierTokenId}`))
				return
			}

			let tagId = params.tagIdHex != null && String(params.tagIdHex).trim() !== '' ? String(params.tagIdHex).trim().toUpperCase() : null
			if (!tagId) tagId = await getNfcTagIdByUid(uid)

			const reg = beamio_ContractPool[0]?.constAccountRegistry
			if (!reg) {
				logger(Colors.yellow('[maybeEnqueueNfcCashTreeBeamioTag] no constAccountRegistry'))
				return
			}

			let exists = false
			let accName = ''
			let fnOn = ''
			let lnOn = ''
			let onchain: Awaited<ReturnType<typeof reg.getAccount>> | null = null
			try {
				onchain = await reg.getAccount(wallet)
				exists = !!onchain?.exists
				accName = String(onchain?.accountName ?? '').trim()
				fnOn = sanitizeName(onchain?.firstName as string | undefined)
				lnOn = sanitizeName(onchain?.lastName as string | undefined)
			} catch {
				exists = false
				onchain = null
			}

			if (exists && accName !== '' && accName !== expectedName) {
				logger(Colors.gray(`[maybeEnqueueNfcCashTreeBeamioTag] skip: wallet already has tag ${accName} (expected ${expectedName})`))
				return
			}
			if (exists && accName === expectedName && fnOn === NFC_BEAMIO_PROFILE_FIRST_NAME && lnOn === NFC_BEAMIO_PROFILE_LAST_NAME) {
				return
			}
			if (exists && accName === expectedName && !nfcProfileNamesNeedClear(fnOn, lnOn) && (fnOn !== '' || lnOn !== '')) {
				logger(Colors.gray(`[maybeEnqueueNfcCashTreeBeamioTag] skip: wallet has custom profile names`))
				return
			}

			const getExistsUserData = await getUserData(expectedName)
			const fullInput: beamioAccount = {
				accountName: expectedName,
				image: exists && onchain ? String(onchain.image ?? '') : '',
				darkTheme: exists && onchain ? !!onchain.darkTheme : false,
				isUSDCFaucet: exists && onchain ? !!onchain.isUSDCFaucet : false,
				isETHFaucet: exists && onchain ? !!onchain.isETHFaucet : false,
				initialLoading: true,
				firstName: NFC_BEAMIO_PROFILE_FIRST_NAME,
				lastName: NFC_BEAMIO_PROFILE_LAST_NAME,
				pgpKeyID: '',
				pgpKey: '',
				address: wallet,
				createdAt: getExistsUserData?.createdAt,
			}

			addUserPool.push({
				wallet,
				account: fullInput,
				recover: [],
				followBeamioOfficial: false,
			})
			addUserPoolProcess()
			logger(Colors.cyan(`[maybeEnqueueNfcCashTreeBeamioTag] queued setAccountByAdmin wallet=${wallet.slice(0, 10)}… tag=${expectedName} (empty profile names)`))
		} catch (e: any) {
			logger(Colors.yellow(`[maybeEnqueueNfcCashTreeBeamioTag] error: ${e?.message ?? e}`))
		}
	})()
}

/**
 * 无基础设施会员 NFT 时的 NFC 默认 beamioTag：beamio_nfc_{N}。
 * N 来自全局 beamio_nfc_seq；登记前用 getOwnerByAccountName 链上排查，占用则递增再试。
 * tagIdHex 绑定 nfc_cards.beamio_nfc_number 幂等复用同一序号。
 */
export const maybeEnqueueNfcBeamioTag = (params: {
	wallet: string
	uid: string
	tagIdHex?: string | null
}): void => {
	void (async () => {
		try {
			const wallet = ethers.getAddress(String(params.wallet || '').trim())
			const uid = String(params.uid || '').trim()
			if (!uid) return

			const reg = beamio_ContractPool[0]?.constAccountRegistry
			if (!reg) {
				logger(Colors.yellow('[maybeEnqueueNfcBeamioTag] no constAccountRegistry'))
				return
			}

			let exists = false
			let accName = ''
			let fnOn = ''
			let lnOn = ''
			try {
				const o = await reg.getAccount(wallet)
				exists = !!o?.exists
				accName = String(o?.accountName ?? '').trim()
				fnOn = sanitizeName(o?.firstName as string | undefined)
				lnOn = sanitizeName(o?.lastName as string | undefined)
			} catch {
				exists = false
			}
			if (exists && accName !== '') return

			const expectedName = await resolveUniqueBeamioNfcAccountName(
				reg as unknown as { getOwnerByAccountName: (name: string) => Promise<string> },
				wallet,
				params.tagIdHex
			)
			if (!expectedName || !BEAMIO_ACCOUNT_NAME_RE.test(expectedName)) {
				logger(Colors.yellow('[maybeEnqueueNfcBeamioTag] could not allocate unique beamio_nfc_* name'))
				return
			}

			if (exists && accName === expectedName && fnOn === NFC_BEAMIO_PROFILE_FIRST_NAME && lnOn === NFC_BEAMIO_PROFILE_LAST_NAME) {
				return
			}
			if (exists && accName === expectedName && !nfcProfileNamesNeedClear(fnOn, lnOn) && (fnOn !== '' || lnOn !== '')) {
				return
			}

			const getExistsUserData = await getUserData(expectedName)
			const fullInput: beamioAccount = {
				accountName: expectedName,
				image: '',
				darkTheme: false,
				isUSDCFaucet: false,
				isETHFaucet: false,
				initialLoading: true,
				firstName: NFC_BEAMIO_PROFILE_FIRST_NAME,
				lastName: NFC_BEAMIO_PROFILE_LAST_NAME,
				pgpKeyID: '',
				pgpKey: '',
				address: wallet,
				createdAt: getExistsUserData?.createdAt,
			}
			addUserPool.push({
				wallet,
				account: fullInput,
				recover: [],
				followBeamioOfficial: false,
			})
			addUserPoolProcess()
			logger(
				Colors.cyan(
					`[maybeEnqueueNfcBeamioTag] queued setAccountByAdmin wallet=${wallet.slice(0, 10)}… tag=${expectedName} (empty profile names)`
				)
			)
		} catch (e: any) {
			logger(Colors.yellow(`[maybeEnqueueNfcBeamioTag] error: ${e?.message ?? e}`))
		}
	})()
}

/** @deprecated 使用 maybeEnqueueNfcBeamioTag（beamio_nfc_{N}） */
export const maybeEnqueueNfcVerraBeamioTag = (params: {
	wallet: string
	uid: string
	tagIdHex?: string | null
}): void => {
	maybeEnqueueNfcBeamioTag(params)
}

/**
 * 将历史误写入 AccountRegistry 的 NFC uid/tagId（hex）从 firstName/lastName 清空。
 * 在持卡 EOA 已有 beamioTag 时由 scheduleEnsureNfcBeamioTagForEoa 触发。
 */
export const maybeClearLegacyNfcBeamioProfileNames = (wallet: string): void => {
	void (async () => {
		try {
			const w = ethers.getAddress(String(wallet || '').trim())
			const reg = beamio_ContractPool[0]?.constAccountRegistry
			if (!reg) return

			let onchain: Awaited<ReturnType<typeof reg.getAccount>> | null = null
			try {
				onchain = await reg.getAccount(w)
			} catch {
				return
			}
			if (!onchain?.exists) return

			const accName = String(onchain.accountName ?? '').trim()
			if (!accName) return

			const fnOn = sanitizeName(onchain.firstName as string | undefined)
			const lnOn = sanitizeName(onchain.lastName as string | undefined)
			if (!nfcProfileNamesNeedClear(fnOn, lnOn)) return
			if (fnOn === NFC_BEAMIO_PROFILE_FIRST_NAME && lnOn === NFC_BEAMIO_PROFILE_LAST_NAME) return

			const getExistsUserData = await getUserData(accName)
			const fullInput: beamioAccount = {
				accountName: accName,
				image: String(onchain.image ?? ''),
				darkTheme: !!onchain.darkTheme,
				isUSDCFaucet: !!onchain.isUSDCFaucet,
				isETHFaucet: !!onchain.isETHFaucet,
				initialLoading: !!onchain.initialLoading,
				firstName: NFC_BEAMIO_PROFILE_FIRST_NAME,
				lastName: NFC_BEAMIO_PROFILE_LAST_NAME,
				pgpKeyID: '',
				pgpKey: '',
				address: w,
				createdAt: getExistsUserData?.createdAt,
			}

			addUserPool.push({
				wallet: w,
				account: fullInput,
				recover: [],
				followBeamioOfficial: false,
			})
			addUserPoolProcess()
			logger(
				Colors.cyan(
					`[maybeClearLegacyNfcBeamioProfileNames] queued clear legacy hex names wallet=${w.slice(0, 10)}… tag=${accName}`
				)
			)
		} catch (e: any) {
			logger(Colors.yellow(`[maybeClearLegacyNfcBeamioProfileNames] error: ${e?.message ?? e}`))
		}
	})()
}

const addUserPoolProcess = async () => {
	const obj = addUserPool.shift()
	if (!obj) {
		return
	}

	const SC = beamio_ContractPool.shift()
	if (!SC) {
		addUserPool.unshift(obj)
		setTimeout(() => {
			addUserPoolProcess()
		}, 2000)
		return
	}
	const account = {
		accountName: obj.account.accountName,
		image: obj.account.image ?? '',
		darkTheme: obj.account.darkTheme,
		isUSDCFaucet:  obj.account.isUSDCFaucet,
		isETHFaucet: obj.account.isETHFaucet,
		initialLoading: obj.account.initialLoading,
		firstName: sanitizeName(obj.account.firstName),
		lastName: sanitizeName(obj.account.lastName),
		pgpKeyID: obj.account.pgpKeyID ?? '',
		pgpKey: obj.account.pgpKey ?? ''
	}

	// 写入数据库和 CoNET L1 之前，查询链上记录是否有变化；无变化则跳过
	const isUnchanged = async (): Promise<boolean> => {
		try {
			const onchain = await SC.constAccountRegistry.getAccount(obj.wallet)
			if (!onchain?.exists) return false
			const s = (v: unknown) => (v == null ? '' : String(v).trim())
			const eq = (a: unknown, b: unknown) => s(a) === s(b)
			return (
				eq(onchain.accountName, obj.account.accountName) &&
				eq(onchain.image, obj.account.image ?? '') &&
				!!onchain.darkTheme === !!obj.account.darkTheme &&
				!!onchain.isUSDCFaucet === !!obj.account.isUSDCFaucet &&
				!!onchain.isETHFaucet === !!obj.account.isETHFaucet &&
				!!onchain.initialLoading === !!obj.account.initialLoading &&
				eq(onchain.firstName, account.firstName) &&
				eq(onchain.lastName, account.lastName)
			)
		} catch {
			return false
		}
	}
	if (await isUnchanged()) {
		logger(Colors.cyan(`[addUserPoolProcess] skip: no change from on-chain wallet=${obj.wallet} accountName=${obj.account?.accountName}`))
		beamio_ContractPool.unshift(SC)
		setTimeout(addUserPoolProcess, 2000)
		return
	}

	try {
		const tx = await SC.constAccountRegistry.setAccountByAdmin(
			obj.wallet, account
		)
		await tx.wait()
		logger('addUserPoolProcess constAccountRegistry SUCCESS!', tx.hash)
		if (obj.recover?.length) {
			for (const n of obj.recover) {
				if (!n?.encrypto || !n?.hash || n.hash === ethers.ZeroHash) continue
				try {
					const tr = await SC.constAccountRegistry.setBase64NameByAdmin(
						n.hash,
						n.encrypto,
						account.accountName,
						obj.wallet
					)
					await tr.wait()
					logger('addUserPoolProcess setBase64NameByAdmin', tr.hash)
				} catch (ex: any) {
					const msg = ex?.shortMessage || ex?.message || ''
					logger(`addUserPoolProcess setBase64NameByAdmin failed (non-fatal): ${msg} | wallet=${obj.wallet} hash=${n.hash?.slice(0, 18)}...`)
					// 不抛出：setAccountByAdmin 已成功，recover 写入失败时仍完成 updateUserDB 与 follow
				}
			}
		}

		await updateUserDB(obj.account)
		
		// 在 setAccountByAdmin 成功后执行 follow BeamioOfficial。
		// 先用 getAccount 探测 BeamioOfficial 是否已经在 registry 上注册；
		// 链上无账户时 ethers 会抛 BAD_DATA: could not decode result data（返回 0x），
		// 与 AccountNotFound 同义，视作"BeamioOfficial 还没注册"安静跳过即可，避免误报为 followByAdmin 失败。
		if (obj.wallet.toLowerCase() !== BeamioOfficial.toLowerCase() && obj.followBeamioOfficial) {
			let officialExists = false
			try {
				const onchain = await (SC.constAccountRegistry as any).getAccount(BeamioOfficial)
				officialExists = !!onchain?.exists
			} catch (_probeEx: any) {
				officialExists = false
			}
			if (!officialExists) {
				logger(`addUserPoolProcess skip followBeamioOfficial: BeamioOfficial not yet onchain | wallet=${obj.wallet}`)
			} else {
				try {
					const followTx = await SC.constAccountRegistry.followByAdmin(obj.wallet, BeamioOfficial)
					await followTx.wait()
					logger('addUserPoolProcess followByAdmin BeamioOfficial SUCCESS!', followTx.hash)
					await updateUserFollowDB(obj.wallet, BeamioOfficial)
				} catch (followEx: any) {
					const msg = followEx?.shortMessage || followEx?.message || ''
					if (/AccountNotFound|routePgpKeyID not in|route key not recorded|could not decode result data|BAD_DATA/i.test(msg)) {
						logger(`addUserPoolProcess skip followBeamioOfficial: ${msg}`)
					} else {
						logger(`addUserPoolProcess followByAdmin Error: ${msg} | wallet=${obj.wallet}`)
					}
				}
			}
		}

	} catch (ex: any) {
		const msg = ex?.data ? (() => {
			try {
				const iface = (SC.constAccountRegistry as any).interface
				const err = iface?.parseError?.(ex.data)
				return err ? `revert: ${err.name}()` : ex.message
			} catch (_) { return ex.message }
		})() : ex.message
		const hint = msg?.includes?.('missing revert data') ? ' [检查: signer 是否在 AccountRegistry admin 列表]' : ''
		logger(`addUserPoolProcess Error: ${msg}${hint} | wallet=${obj.wallet} accountName=${obj.account?.accountName}`)
	}

	beamio_ContractPool.unshift(SC)
	setTimeout(() => {
		addUserPoolProcess()
	}, 2000)

}

const addFollowPoolProcess = async () => {
	const obj = addFollowPool.shift()
	if (!obj) {
		return
	}

	const SC = beamio_ContractPool.shift()
	if (!SC) {
		addFollowPool.unshift(obj)
		setTimeout(() => {
			addFollowPoolProcess()
		}, 2000)
		return
	}
	
	try {
		const tx = obj.remove ? await SC.constAccountRegistry.unfollowByAdmin(
			obj.wallet, obj.followAddress
		) : await SC.constAccountRegistry.followByAdmin(
			obj.wallet, obj.followAddress
		)

		await tx.wait()
		logger(`addFollowPoolProcess constAccountRegistry remove ${obj.remove} SUCCESS!`, tx.hash)
		obj.remove ? await updateUserFollowRemoveDB(obj.wallet, obj.followAddress) : await updateUserFollowDB(obj.wallet, obj.followAddress)

	} catch (ex: any) {
		const msg = ex?.data ? (() => {
			try {
				const iface = (SC.constAccountRegistry as any).interface
				const err = iface?.parseError?.(ex.data)
				return err ? `revert: ${err.name}()` : ex.message
			} catch (_) { return ex.message }
		})() : ex.message
		logger(`addFollowPoolProcess Error: ${msg} | wallet=${obj.wallet} followAddress=${obj.followAddress} remove=${obj.remove}`)
	}

	beamio_ContractPool.unshift(SC)
	setTimeout(() => {
		addFollowPoolProcess()
	}, 2000)

}


const BeamioOfficial = '0xeabf0a98ac208647247eaa25fdd4eb0e67793d61'

/**
 * addUser 前：以 AccountRegistry 链上为准。handle 未绑定时清理本地该用户名的缓存；
 * 钱包在链上无账户时删除本地该地址的 accounts/follows（避免陈旧行阻碍重新登记）。
 */
const reconcileLocalDbBeforeAddUser = async (
	accountName: string,
	walletRaw: string
): Promise<void> => {
	const reg = beamio_ContractPool[0]?.constAccountRegistry
	if (!reg) return
	let wallet: string
	try {
		wallet = ethers.getAddress(String(walletRaw || '').trim()).toLowerCase()
	} catch {
		return
	}
	const nameNorm = String(accountName || '').trim()
	if (!nameNorm) return

	try {
		// 新 registry 对未注册名字会返回 0x（BAD_DATA），等价于「名字未被占用」。
		let ownerByName: string
		try {
			ownerByName = await reg.getOwnerByAccountName(nameNorm)
		} catch (probeEx: any) {
			if (!isOnchainEmptyResult(probeEx)) throw probeEx
			ownerByName = ethers.ZeroAddress
		}
		const nameFreeOnChain =
			!ownerByName || ownerByName === ethers.ZeroAddress

		if (nameFreeOnChain) {
			await clearStaleUsernameFromDb(nameNorm)
		}

		// getAccount 在新 registry 对未注册地址同样返回 0x（BAD_DATA），等价于 exists=false。
		let walletHasAccount: boolean | null = null
		try {
			const acc = await reg.getAccount(wallet)
			walletHasAccount = !!acc?.exists
		} catch (probeEx: any) {
			walletHasAccount = isOnchainEmptyResult(probeEx) ? false : null
		}

		// 仅当链上明确 exists=false 时删本地；RPC 抖动等不采信为「无账户」，避免误删
		if (walletHasAccount === false) {
			logger(
				Colors.yellow(
					`[reconcileLocalDbBeforeAddUser] chain has no account for ${wallet.slice(0, 10)}… — drop stale DB rows if any`
				)
			)
			await deleteAccountFromDB(wallet)
		}
	} catch (ex: any) {
		logger(
			Colors.yellow(
				`[reconcileLocalDbBeforeAddUser] skipped: ${ex?.shortMessage || ex?.message || ex}`
			)
		)
	}
}

export const addUser = async (req: Request, res: Response) => {
	const { accountName, wallet, recover, image, isUSDCFaucet, darkTheme, isETHFaucet, firstName, lastName, pgpKeyID, pgpKey } = req.body as {
		accountName: string
		wallet: string
		recover: IAccountRecover[]
		image: string
		isUSDCFaucet: boolean
		darkTheme: boolean
		isETHFaucet: boolean
		firstName: string
		lastName: string
		pgpKeyID?: string
		pgpKey?: string
	}

	try {

		await reconcileLocalDbBeforeAddUser(accountName, wallet)

		const getExistsUserData = await getUserData(accountName)
		
		// 2. 填默认值，保证所有 field 都存在；firstName/lastName 用 sanitizeName 防止 JSON 污染
		const fullInput: beamioAccount = {
			accountName: accountName,
			image: image ?? '',
			darkTheme,
			isUSDCFaucet,
			isETHFaucet,
			initialLoading: true,
			firstName: sanitizeName(firstName),
			lastName: sanitizeName(lastName),
			pgpKeyID: pgpKeyID ?? '',
			pgpKey: pgpKey ?? '',
			address: wallet,
			createdAt: getExistsUserData?.createdAt
		}
		

		addUserPool.push({
			wallet,
			account: fullInput,
			recover: recover,
			followBeamioOfficial: true
		})

		addUserPoolProcess()

		// addFollow 改为在 addUserPoolProcess 内 setAccountByAdmin 成功后执行，避免 AccountNotFound（账户尚未上链时 follow 会 revert）
		// 3. 组装 calldata：ethers v6 struct 传参可以直接用对象
		console.log("[setAccountByAdmin] sending tx for", accountName, fullInput)

		return res.json({
			ok: true
		})

	} catch (err: any) {
		console.error("[setAccountByAdmin] error:", err)
		// ethers v6 报错信息在 err.shortMessage / err.info 等
		return res.status(500).json({
			ok: false,
			error: err.shortMessage || err.message || "Unknown error"
		})
	}
		
}

const regiestChatRouteProcess = async () => {
	const obj = regiestChatRoutePool.shift()
	if (!obj) return

	const SC = beamio_ContractPool.shift()
	if (!SC) {
		regiestChatRoutePool.unshift(obj)
		setTimeout(regiestChatRouteProcess, 2000)
		return
	}
	const respond = (status: number, body: object) => {
		if (!obj.res.headersSent) {
			obj.res.status(status).json(body)
		}
	}
	try {
		const tx = await SC.constPgpManager.addPublicPGPByAdmin(
			obj.wallet,
			obj.keyID,
			obj.publicKeyArmored,
			obj.encrypKeyArmored,
			obj.routeKeyID
		)
		// 立即返回，避免 Cluster/nginx 等待 tx.wait() 超时 502（与 addUser 入队语义一致）
		respond(200, { ok: true, txHash: tx.hash })
		void tx
			.wait()
			.then(() => {
				logger('regiestChatRouteProcess addPublicPGPByAdmin SUCCESS!', tx.hash)
			})
			.catch((waitErr: unknown) => {
				const msg = waitErr instanceof Error ? waitErr.message : String(waitErr)
				logger(Colors.red(`regiestChatRouteProcess tx.wait failed tx=${tx.hash}: ${msg}`))
			})
	} catch (err: any) {
		const msg = err?.shortMessage || err?.message || 'Unknown error'
		logger('regiestChatRouteProcess Error:', msg)
		respond(500, { ok: false, error: msg })
	}
	beamio_ContractPool.unshift(SC)
	setTimeout(regiestChatRouteProcess, 2000)
}

/** 登记 chat route：由 cluster 预检后转发。push regiestChatRoutePool，daemon 排队调用 addPublicPGPByAdmin。*/
export const regiestChatRoute = async (req: Request, res: Response) => {
	const { wallet, keyID, publicKeyArmored, encrypKeyArmored, routeKeyID } = req.body as {
		wallet?: string
		keyID?: string
		publicKeyArmored?: string
		encrypKeyArmored?: string
		routeKeyID?: string
	}
	if (!ethers.isAddress(wallet) || !keyID || !publicKeyArmored || !encrypKeyArmored || !routeKeyID) {
		return res.status(400).json({ ok: false, error: 'Missing or invalid: wallet, keyID, publicKeyArmored, encrypKeyArmored, routeKeyID' })
	}
	if (!beamio_ContractPool[0]?.constPgpManager) {
		return res.status(500).json({ ok: false, error: 'Service unavailable' })
	}
	regiestChatRoutePool.push({
		wallet: wallet.toLowerCase(),
		keyID: String(keyID).trim(),
		publicKeyArmored: String(publicKeyArmored),
		encrypKeyArmored: String(encrypKeyArmored),
		routeKeyID: String(routeKeyID).trim(),
		res
	})
	logger(Colors.cyan(`[regiestChatRoute] pushed to pool, wallet=${wallet} routeKeyID=${routeKeyID}`))
	regiestChatRouteProcess().catch((err: any) => {
		logger(Colors.red('[regiestChatRouteProcess] unhandled error:'), err?.message ?? err)
	})
}

const DB_URL = "postgres://postgres:your_password@127.0.0.1:5432/postgres"

/** beamio_cards 表：存储 createCard 创建的卡，供最新发行卡列表等查询。total_points_minted_6、holder_count 初始为 0，可由 indexer 后续更新。 */
const BEAMIO_CARDS_TABLE = `CREATE TABLE IF NOT EXISTS beamio_cards (
	id SERIAL PRIMARY KEY,
	card_address TEXT UNIQUE NOT NULL,
	card_owner TEXT NOT NULL,
	currency TEXT NOT NULL,
	price_in_currency_e6 TEXT NOT NULL,
	uri TEXT,
	metadata_json JSONB,
	tx_hash TEXT,
	total_points_minted_6 BIGINT DEFAULT 0,
	holder_count INT DEFAULT 0,
	created_at TIMESTAMPTZ DEFAULT NOW()
)`

/** POS 终端 EOA（商户子 admin）→ 登记为 admin 的 BeamioUserCard；供跨卡冲突拒绝与 GET myPosAddress。 */
const BEAMIO_POS_TERMINAL_ADMIN_CARD_TABLE = `CREATE TABLE IF NOT EXISTS beamio_pos_terminal_admin_card (
	pos_eoa TEXT PRIMARY KEY,
	card_address TEXT NOT NULL,
	tx_hash TEXT,
	updated_at TIMESTAMPTZ DEFAULT NOW()
)`
const BEAMIO_POS_TERMINAL_ADMIN_CARD_IDX_CARD = `CREATE INDEX IF NOT EXISTS idx_beamio_pos_terminal_admin_card_card ON beamio_pos_terminal_admin_card (LOWER(TRIM(card_address)))`

async function ensureBeamioPosTerminalAdminCardSchema(db: Client): Promise<void> {
	await db.query(BEAMIO_POS_TERMINAL_ADMIN_CARD_TABLE)
	await db.query(BEAMIO_POS_TERMINAL_ADMIN_CARD_IDX_CARD)
	await db.query(
		`ALTER TABLE beamio_pos_terminal_admin_card ADD COLUMN IF NOT EXISTS metadata_json JSONB`
	).catch(() => {})
}

/** cardAddAdmin 预检：POS EOA 已绑定其他卡则拒绝。同一卡重复登记允许（更新 mint limit 等）。 */
export const assertPosEoaAvailableForCardBinding = async (
	posLoose: string,
	cardAddressLoose: string
): Promise<{ ok: true } | { ok: false; error: string }> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureBeamioPosTerminalAdminCardSchema(db)
		const pos = ethers.getAddress(posLoose).toLowerCase()
		const card = ethers.getAddress(cardAddressLoose).toLowerCase()
		const { rows } = await db.query<{ card_address: string }>(
			`SELECT card_address FROM beamio_pos_terminal_admin_card WHERE pos_eoa = $1 LIMIT 1`,
			[pos]
		)
		if (rows.length > 0 && rows[0].card_address !== card) {
			return {
				ok: false,
				error:
					'This terminal address is already registered as a POS terminal. Remove it there before linking to this POS terminal.',
			}
		}
		return { ok: true }
	} catch (e: any) {
		logger(Colors.yellow(`[assertPosEoaAvailableForCardBinding] failed: ${e?.message ?? e}`))
		return { ok: false, error: 'Could not verify terminal registration. Try again later.' }
	} finally {
		await db.end().catch(() => {})
	}
}

/** adminManager(add) 上链成功后写入；remove 成功后可 delete。metadataJson：Link terminal UI 随 calldata 上链的 JSON（同步解析入库）。 */
export const upsertPosTerminalAdminCardBinding = async (params: {
	posEoa: string
	cardAddress: string
	txHash?: string
	/** Parsed object or JSON-serializable value; omit on non-terminal upserts (e.g. redeem) to preserve existing row. */
	metadataJson?: unknown
}): Promise<void> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureBeamioPosTerminalAdminCardSchema(db)
		const pos = ethers.getAddress(params.posEoa).toLowerCase()
		const card = ethers.getAddress(params.cardAddress).toLowerCase()
		const meta = params.metadataJson === undefined ? null : params.metadataJson
		await db.query(
			`
			INSERT INTO beamio_pos_terminal_admin_card (pos_eoa, card_address, tx_hash, metadata_json, updated_at)
			VALUES ($1, $2, $3, $4::jsonb, NOW())
			ON CONFLICT (pos_eoa) DO UPDATE SET
				card_address = EXCLUDED.card_address,
				tx_hash = EXCLUDED.tx_hash,
				metadata_json = COALESCE(EXCLUDED.metadata_json, beamio_pos_terminal_admin_card.metadata_json),
				updated_at = NOW()
			`,
			[pos, card, params.txHash ?? null, meta]
		)
		logger(Colors.green(`[upsertPosTerminalAdminCardBinding] pos=${pos} card=${card}`))
	} catch (e: any) {
		logger(Colors.yellow(`[upsertPosTerminalAdminCardBinding] failed: ${e?.message ?? e}`))
	} finally {
		await db.end().catch(() => {})
	}
}

export const deletePosTerminalAdminCardBinding = async (posLoose: string, cardAddressLoose: string): Promise<void> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureBeamioPosTerminalAdminCardSchema(db)
		const pos = ethers.getAddress(posLoose).toLowerCase()
		const card = ethers.getAddress(cardAddressLoose).toLowerCase()
		await db.query(`DELETE FROM beamio_pos_terminal_admin_card WHERE pos_eoa = $1 AND card_address = $2`, [pos, card])
	} catch (e: any) {
		logger(Colors.yellow(`[deletePosTerminalAdminCardBinding] failed: ${e?.message ?? e}`))
	} finally {
		await db.end().catch(() => {})
	}
}

/** POS 问询已登记商户卡地址（Registration Device 成功且链上 confirm 后即有记录）。 */
export const getPosTerminalCardAddressForWallet = async (walletLoose: string): Promise<string | null> => {
	const row = await getPosTerminalCardBindingRow(walletLoose)
	return row?.cardAddress ?? null
}

/** 含 DB 内保存的终端 metadata（Link & activate terminal 时从链上 adminManager metadata 解析）。 */
export const getPosTerminalCardBindingRow = async (
	walletLoose: string
): Promise<{ cardAddress: string; txHash: string | null; terminalMetadata: unknown | null } | null> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureBeamioPosTerminalAdminCardSchema(db)
		const w = ethers.getAddress(walletLoose).toLowerCase()
		const { rows } = await db.query<{ card_address: string; tx_hash: string | null; metadata_json: unknown | null }>(
			`SELECT card_address, tx_hash, metadata_json FROM beamio_pos_terminal_admin_card WHERE pos_eoa = $1 LIMIT 1`,
			[w]
		)
		if (rows.length === 0) return null
		const raw = rows[0].card_address
		if (!raw || !ethers.isAddress(raw)) return null
		return {
			cardAddress: ethers.getAddress(raw),
			txHash: rows[0].tx_hash ?? null,
			terminalMetadata: rows[0].metadata_json ?? null,
		}
	} catch (e: any) {
		logger(Colors.yellow(`[getPosTerminalCardBindingRow] failed: ${e?.message ?? e}`))
		return null
	} finally {
		await db.end().catch(() => {})
	}
}

/** beamio_nft_series 表：存储 issued NFT 系列，含 sharedSeriesMetadata 的 IPFS 引用；metadata_json 为通用型 JSONB（应用场景扩展用，如电影/演唱会/商品等） */
const BEAMIO_NFT_SERIES_TABLE = `CREATE TABLE IF NOT EXISTS beamio_nft_series (
	id SERIAL PRIMARY KEY,
	card_address TEXT NOT NULL,
	token_id TEXT NOT NULL,
	shared_metadata_hash TEXT NOT NULL,
	ipfs_cid TEXT NOT NULL,
	card_owner TEXT NOT NULL,
	metadata_json JSONB,
	created_at TIMESTAMPTZ DEFAULT NOW(),
	UNIQUE(card_address, token_id)
)`

/** beamio_nft_mint_metadata 表：每笔 mint 的通用型 metadata_json（电影票座位、商品序列号、演唱会区域等），由 purchase/mint 流程登记 */
const BEAMIO_NFT_MINT_METADATA_TABLE = `CREATE TABLE IF NOT EXISTS beamio_nft_mint_metadata (
	id SERIAL PRIMARY KEY,
	card_address TEXT NOT NULL,
	token_id TEXT NOT NULL,
	owner_address TEXT NOT NULL,
	tx_hash TEXT,
	metadata_json JSONB NOT NULL,
	created_at TIMESTAMPTZ DEFAULT NOW()
)`

/** beamio_nft_tier_metadata 表：按 (card_owner, token_id) 存储每张成员 NFT 的 tier metadata，供 GET /metadata/0x{owner}{NFT#}.json 返回 */
const BEAMIO_NFT_TIER_METADATA_TABLE = `CREATE TABLE IF NOT EXISTS beamio_nft_tier_metadata (
	id SERIAL PRIMARY KEY,
	card_owner TEXT NOT NULL,
	token_id BIGINT NOT NULL,
	card_address TEXT NOT NULL,
	metadata_json JSONB NOT NULL,
	created_at TIMESTAMPTZ DEFAULT NOW(),
	UNIQUE(card_owner, token_id)
)`

/** 每次 Base 上成功 top-up（USDC 购点 / POS NFC mint）后写入：会员档 NFT#、EOA、AA，供 biz 按卡查询会员地址（与 indexer 互补）。base_tx_hash 幂等。 */
const BEAMIO_MEMBER_TOPUP_EVENTS_TABLE = `CREATE TABLE IF NOT EXISTS beamio_member_topup_events (
	id SERIAL PRIMARY KEY,
	card_address TEXT NOT NULL,
	base_tx_hash TEXT NOT NULL,
	member_eoa TEXT NOT NULL,
	member_aa TEXT NOT NULL,
	tier_token_id TEXT NOT NULL,
	topup_source TEXT NOT NULL,
	topup_category TEXT,
	created_at TIMESTAMPTZ DEFAULT NOW(),
	UNIQUE(base_tx_hash)
)`
const BEAMIO_MEMBER_TOPUP_EVENTS_IDX_CARD = `CREATE INDEX IF NOT EXISTS idx_beamio_member_topup_events_card ON beamio_member_topup_events (LOWER(TRIM(card_address)))`
const BEAMIO_MEMBER_TOPUP_EVENTS_ADD_POINTS = `ALTER TABLE beamio_member_topup_events ADD COLUMN IF NOT EXISTS points_e6 TEXT`
const BEAMIO_MEMBER_TOPUP_EVENTS_ADD_USDC = `ALTER TABLE beamio_member_topup_events ADD COLUMN IF NOT EXISTS usdc_e6 TEXT`
/** PR #4 (USDC charge orchestrator): 把外部 USDC 结算 tx 挂到 topup 行上，便于
 *  「USDC settle → tmp wallet topup → tmp wallet charge」三段对账（同一 sid 共享 USDC_tx）。 */
const BEAMIO_MEMBER_TOPUP_EVENTS_ADD_ORIG_USDC_TX = `ALTER TABLE beamio_member_topup_events ADD COLUMN IF NOT EXISTS originating_usdc_tx TEXT`
const BEAMIO_MEMBER_TOPUP_EVENTS_ADD_CHARGE_SID = `ALTER TABLE beamio_member_topup_events ADD COLUMN IF NOT EXISTS charge_session_id TEXT`
const BEAMIO_MEMBER_TOPUP_EVENTS_ADD_POS_OPERATOR = `ALTER TABLE beamio_member_topup_events ADD COLUMN IF NOT EXISTS pos_operator TEXT`

/** 每卡每 EOA 聚合：top-up 次数、累计 points(6) / USDC(6)、仅保留最后一次 top-up 时间戳。 */
const BEAMIO_CARD_MEMBER_TOPUP_STATS_TABLE = `CREATE TABLE IF NOT EXISTS beamio_card_member_topup_stats (
	card_address TEXT NOT NULL,
	member_eoa TEXT NOT NULL,
	member_aa TEXT NOT NULL,
	tier_token_id TEXT NOT NULL,
	topup_count INTEGER NOT NULL DEFAULT 0,
	topup_points_total_e6 NUMERIC(48,0) NOT NULL DEFAULT 0,
	topup_usdc_total_e6 NUMERIC(48,0) NOT NULL DEFAULT 0,
	last_topup_at TIMESTAMPTZ NOT NULL,
	last_base_tx_hash TEXT,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	PRIMARY KEY (card_address, member_eoa)
)`
const BEAMIO_CARD_MEMBER_TOPUP_STATS_IDX_CARD = `CREATE INDEX IF NOT EXISTS idx_beamio_card_member_topup_stats_card_last ON beamio_card_member_topup_stats (card_address, last_topup_at DESC)`

/** 每张卡汇总：成功 top-up 总次数、repeat top-up 次数（非新用户：未新发/升级档 NFT，与 MemberCard topupCategory 一致）。 */
const BEAMIO_CARD_TOPUP_ROLLUPS_TABLE = `CREATE TABLE IF NOT EXISTS beamio_card_topup_rollups (
	card_address TEXT PRIMARY KEY,
	total_topup_count BIGINT NOT NULL DEFAULT 0,
	total_repeat_topup_count BIGINT NOT NULL DEFAULT 0,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`
async function ensureBeamioCardTopupRollupsSchema(db: Client): Promise<void> {
	await db.query(BEAMIO_CARD_TOPUP_ROLLUPS_TABLE)
	/** Top-up 前无有效会员 NFT 时按渠道累计（近场 NFC / App USDC）。 */
	await db.query(
		`ALTER TABLE beamio_card_topup_rollups ADD COLUMN IF NOT EXISTS nfc_activation_count BIGINT NOT NULL DEFAULT 0`
	)
	await db.query(
		`ALTER TABLE beamio_card_topup_rollups ADD COLUMN IF NOT EXISTS app_activation_count BIGINT NOT NULL DEFAULT 0`
	)
}

/** USDC：`usdcTopupCard`；NFC：`topupCard`。其余（newCard / upgrade / usdcNewCard 等）不计入 repeat。 */
export function topupCategoryIsRepeatMemberTopup(category: string | null | undefined): boolean {
	if (category == null) return false
	const c = String(category).trim()
	return c === 'usdcTopupCard' || c === 'topupCard'
}

export type CardTopupRollupRow = {
	totalTopupCount: number
	totalRepeatTopupCount: number
	/** Top-up 成功且当时用户在该卡无有效会员 NFT：近场 NFC 渠道累计 */
	nfcActivationCount: number
	/** 同上：App USDC 购点渠道累计 */
	appActivationCount: number
}

export const getCardTopupRollup = async (cardAddress: string): Promise<CardTopupRollupRow> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureBeamioCardTopupRollupsSchema(db)
		const card = ethers.getAddress(cardAddress).toLowerCase()
		const { rows } = await db.query<{
			total_topup_count: string
			total_repeat_topup_count: string
			nfc_activation_count: string
			app_activation_count: string
		}>(
			`
			SELECT
				total_topup_count::text,
				total_repeat_topup_count::text,
				COALESCE(nfc_activation_count, 0)::text AS nfc_activation_count,
				COALESCE(app_activation_count, 0)::text AS app_activation_count
			FROM beamio_card_topup_rollups
			WHERE card_address = $1
			LIMIT 1
			`,
			[card]
		)
		if (!rows.length) {
			return {
				totalTopupCount: 0,
				totalRepeatTopupCount: 0,
				nfcActivationCount: 0,
				appActivationCount: 0,
			}
		}
		return {
			totalTopupCount: Number(rows[0].total_topup_count) || 0,
			totalRepeatTopupCount: Number(rows[0].total_repeat_topup_count) || 0,
			nfcActivationCount: Number(rows[0].nfc_activation_count) || 0,
			appActivationCount: Number(rows[0].app_activation_count) || 0,
		}
	} catch (e: any) {
		logger(Colors.yellow(`[getCardTopupRollup] failed: ${e?.message ?? e}`))
		return {
			totalTopupCount: 0,
			totalRepeatTopupCount: 0,
			nfcActivationCount: 0,
			appActivationCount: 0,
		}
	} finally {
		await db.end().catch(() => {})
	}
}

async function ensureBeamioMemberTopupEventsSchema(db: Client): Promise<void> {
	await db.query(BEAMIO_MEMBER_TOPUP_EVENTS_TABLE)
	await db.query(BEAMIO_MEMBER_TOPUP_EVENTS_ADD_POINTS)
	await db.query(BEAMIO_MEMBER_TOPUP_EVENTS_ADD_USDC)
	await db.query(BEAMIO_MEMBER_TOPUP_EVENTS_ADD_ORIG_USDC_TX)
	await db.query(BEAMIO_MEMBER_TOPUP_EVENTS_ADD_CHARGE_SID)
	await db.query(BEAMIO_MEMBER_TOPUP_EVENTS_ADD_POS_OPERATOR)
	await db.query(BEAMIO_MEMBER_TOPUP_EVENTS_IDX_CARD)
}

async function ensureBeamioCardMemberTopupStatsSchema(db: Client): Promise<void> {
	await db.query(BEAMIO_CARD_MEMBER_TOPUP_STATS_TABLE)
	await db.query(BEAMIO_CARD_MEMBER_TOPUP_STATS_IDX_CARD)
}

function topupAmountToNumericString(v: bigint | string | number | null | undefined): string {
	if (v == null) return '0'
	if (typeof v === 'bigint') return v.toString()
	if (typeof v === 'number')
		return String(Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)
	const s = String(v).trim()
	if (!s || !/^\d+$/.test(s)) return '0'
	return s
}

export type MemberTopupEventRow = {
	memberEoa: string
	memberAa: string
	tierTokenId: string
	baseTxHash: string
	topupSource: string
	topupCategory: string | null
	createdAt: string
	/** 该笔 top-up 入账 points（6 位小数整数），事件表审计用 */
	pointsE6?: string
	/** 该笔对应 USDC 数量（6 位小数整数） */
	usdcE6?: string
}

/** 每用户聚合（按卡 + EOA）：次数、累计额、最后一次 top-up 时间 */
export type MemberTopupMemberAggRow = {
	memberEoa: string
	memberAa: string
	tierTokenId: string
	topupCount: number
	topupPointsTotalE6: string
	topupUsdcTotalE6: string
	lastTopupAt: string
	lastBaseTxHash: string | null
}

export type MemberTopupPage<T> = { items: T[]; total: number }

/** Master：Base top-up 成功后写入事件（幂等 base_tx_hash）；仅在新插入时累加 beamio_card_member_topup_stats。 */
export const insertMemberTopupEvent = async (params: {
	cardAddress: string
	baseTxHash: string
	memberEoa: string
	memberAa: string
	tierTokenId: string
	topupSource: 'usdcPurchasingCard' | 'androidNfcTopup' | 'webPosNfcTopup'
	topupCategory?: string | null
	/** 本笔 top-up 入账 points（6 位精度整数） */
	pointsE6?: bigint | string | number
	/** 本笔对应 USDC（6 位精度整数） */
	usdcE6?: bigint | string | number
	/**
	 * Top-up 前该用户在该卡上无有效会员 NFT（与 usdcTopup hasMembership 语义一致）时由 MemberCard 置 true，
	 * 在幂等新插入事件时给对应渠道 activation +1。
	 */
	countAsNfcActivation?: boolean
	countAsAppActivation?: boolean
	/** PR #4 (USDC charge orchestrator)：本 topup 由 USDC charge 编排器触发时，
	 *  挂上原始 x402 settle tx hash + POS sid + 操作员，三段对账（settle → topup → charge）共享一组标识。 */
	originatingUsdcTx?: string | null
	chargeSessionId?: string | null
	posOperator?: string | null
}): Promise<void> => {
	const db = new Client({ connectionString: DB_URL })
	const pointsStr = topupAmountToNumericString(params.pointsE6)
	const usdcStr = topupAmountToNumericString(params.usdcE6)
	try {
		await db.connect()
		await ensureBeamioMemberTopupEventsSchema(db)
		await ensureBeamioCardMemberTopupStatsSchema(db)
		await ensureBeamioCardTopupRollupsSchema(db)
		const card = ethers.getAddress(params.cardAddress).toLowerCase()
		const hash = String(params.baseTxHash).toLowerCase()
		const eoa = ethers.getAddress(params.memberEoa).toLowerCase()
		const aa = ethers.isAddress(params.memberAa) ? ethers.getAddress(params.memberAa).toLowerCase() : ethers.ZeroAddress.toLowerCase()
		const repeatInc: 0 | 1 = topupCategoryIsRepeatMemberTopup(params.topupCategory) ? 1 : 0
		const nfcActInc: 0 | 1 =
			params.topupSource === 'androidNfcTopup' && params.countAsNfcActivation === true ? 1 : 0
		const appActInc: 0 | 1 =
			params.topupSource === 'usdcPurchasingCard' && params.countAsAppActivation === true ? 1 : 0
		const origUsdcTxNorm =
			typeof params.originatingUsdcTx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(params.originatingUsdcTx.trim())
				? params.originatingUsdcTx.trim().toLowerCase()
				: null
		const chargeSidNorm =
			typeof params.chargeSessionId === 'string' && params.chargeSessionId.trim().length > 0
				? params.chargeSessionId.trim().toLowerCase()
				: null
		const posOpNorm =
			typeof params.posOperator === 'string' && ethers.isAddress(params.posOperator.trim())
				? ethers.getAddress(params.posOperator.trim()).toLowerCase()
				: null
		await db.query('BEGIN')
		try {
			const ins = await db.query<{ id: number }>(
				`
				INSERT INTO beamio_member_topup_events (card_address, base_tx_hash, member_eoa, member_aa, tier_token_id, topup_source, topup_category, points_e6, usdc_e6, originating_usdc_tx, charge_session_id, pos_operator)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
				ON CONFLICT (base_tx_hash) DO NOTHING
				RETURNING id
				`,
				[card, hash, eoa, aa, String(params.tierTokenId), params.topupSource, params.topupCategory ?? null, pointsStr, usdcStr, origUsdcTxNorm, chargeSidNorm, posOpNorm]
			)
			if (!ins.rows?.length) {
				await db.query('COMMIT')
				return
			}
			await db.query(
				`
				INSERT INTO beamio_card_member_topup_stats (
					card_address, member_eoa, member_aa, tier_token_id,
					topup_count, topup_points_total_e6, topup_usdc_total_e6,
					last_topup_at, last_base_tx_hash
				) VALUES ($1, $2, $3, $4, 1, $5::numeric, $6::numeric, NOW(), $7)
				ON CONFLICT (card_address, member_eoa) DO UPDATE SET
					member_aa = EXCLUDED.member_aa,
					tier_token_id = EXCLUDED.tier_token_id,
					topup_count = beamio_card_member_topup_stats.topup_count + 1,
					topup_points_total_e6 = beamio_card_member_topup_stats.topup_points_total_e6 + EXCLUDED.topup_points_total_e6,
					topup_usdc_total_e6 = beamio_card_member_topup_stats.topup_usdc_total_e6 + EXCLUDED.topup_usdc_total_e6,
					last_topup_at = EXCLUDED.last_topup_at,
					last_base_tx_hash = EXCLUDED.last_base_tx_hash,
					updated_at = NOW()
				`,
				[card, eoa, aa, String(params.tierTokenId), pointsStr, usdcStr, hash]
			)
			await db.query(
				`
				INSERT INTO beamio_card_topup_rollups (
					card_address, total_topup_count, total_repeat_topup_count,
					nfc_activation_count, app_activation_count
				)
				VALUES ($1, 1, $2, $3, $4)
				ON CONFLICT (card_address) DO UPDATE SET
					total_topup_count = beamio_card_topup_rollups.total_topup_count + 1,
					total_repeat_topup_count = beamio_card_topup_rollups.total_repeat_topup_count + EXCLUDED.total_repeat_topup_count,
					nfc_activation_count = beamio_card_topup_rollups.nfc_activation_count + EXCLUDED.nfc_activation_count,
					app_activation_count = beamio_card_topup_rollups.app_activation_count + EXCLUDED.app_activation_count,
					updated_at = NOW()
				`,
				[card, repeatInc, nfcActInc, appActInc]
			)
			await db.query('COMMIT')
			logger(
				Colors.green(
					`[insertMemberTopupEvent] card=${card} tx=${hash.slice(0, 12)}… eoa=${eoa.slice(0, 10)}… tier=${params.tierTokenId} pts+${pointsStr} usdc+${usdcStr} repeat+${repeatInc} nfcAct+${nfcActInc} appAct+${appActInc}`
				)
			)
		} catch (inner: any) {
			await db.query('ROLLBACK').catch(() => {})
			throw inner
		}
	} catch (e: any) {
		logger(Colors.yellow(`[insertMemberTopupEvent] failed: ${e?.message ?? e}`))
	} finally {
		await db.end().catch(() => {})
	}
}

const mapMemberTopupRow = (r: {
	member_eoa: string
	member_aa: string
	tier_token_id: string
	base_tx_hash: string
	topup_source: string
	topup_category: string | null
	created_at: Date
	points_e6?: string | null
	usdc_e6?: string | null
}): MemberTopupEventRow => ({
	memberEoa: r.member_eoa,
	memberAa: r.member_aa,
	tierTokenId: r.tier_token_id,
	baseTxHash: r.base_tx_hash,
	topupSource: r.topup_source,
	topupCategory: r.topup_category,
	createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
	...(r.points_e6 != null && r.points_e6 !== '' ? { pointsE6: r.points_e6 } : {}),
	...(r.usdc_e6 != null && r.usdc_e6 !== '' ? { usdcE6: r.usdc_e6 } : {}),
})

const mapMemberTopupStatsRow = (r: {
	member_eoa: string
	member_aa: string
	tier_token_id: string
	topup_count: string | number
	topup_points_total_e6: string
	topup_usdc_total_e6: string
	last_topup_at: Date
	last_base_tx_hash: string | null
}): MemberTopupMemberAggRow => ({
	memberEoa: r.member_eoa,
	memberAa: r.member_aa,
	tierTokenId: r.tier_token_id,
	topupCount: typeof r.topup_count === 'number' ? r.topup_count : Number(r.topup_count) || 0,
	topupPointsTotalE6: String(r.topup_points_total_e6 ?? '0'),
	topupUsdcTotalE6: String(r.topup_usdc_total_e6 ?? '0'),
	lastTopupAt: r.last_topup_at instanceof Date ? r.last_topup_at.toISOString() : String(r.last_topup_at),
	lastBaseTxHash: r.last_base_tx_hash,
})

/** Cluster：按卡分页拉取 top-up 事件，按登记时间 created_at 倒序。total 为该卡事件总行数。limit 默认 20，最大 2000。 */
export const listCardMemberTopupEvents = async (
	cardAddress: string,
	opts?: { limit?: number; offset?: number }
): Promise<MemberTopupPage<MemberTopupEventRow>> => {
	const db = new Client({ connectionString: DB_URL })
	const limit = Math.min(Math.max(Number(opts?.limit) || 20, 1), 2000)
	const offset = Math.max(Number(opts?.offset) || 0, 0)
	try {
		await db.connect()
		await ensureBeamioMemberTopupEventsSchema(db)
		const card = ethers.getAddress(cardAddress).toLowerCase()
		const countRes = await db.query<{ c: string }>(
			`SELECT COUNT(*)::text AS c FROM beamio_member_topup_events WHERE LOWER(TRIM(card_address)) = $1`,
			[card]
		)
		const total = Number(countRes.rows[0]?.c ?? 0) || 0
		const { rows } = await db.query<{
			member_eoa: string
			member_aa: string
			tier_token_id: string
			base_tx_hash: string
			topup_source: string
			topup_category: string | null
			created_at: Date
			points_e6: string | null
			usdc_e6: string | null
		}>(
			`
			SELECT member_eoa, member_aa, tier_token_id, base_tx_hash, topup_source, topup_category, created_at, points_e6, usdc_e6
			FROM beamio_member_topup_events
			WHERE LOWER(TRIM(card_address)) = $1
			ORDER BY created_at DESC, id DESC
			LIMIT $2 OFFSET $3
			`,
			[card, limit, offset]
		)
		return { items: rows.map(mapMemberTopupRow), total }
	} catch (e: any) {
		logger(Colors.yellow(`[listCardMemberTopupEvents] failed: ${e?.message ?? e}`))
		return { items: [], total: 0 }
	} finally {
		await db.end().catch(() => {})
	}
}

/** POS Balance Detail：该会员 EOA 在此商户卡上 DB 最新一条 top-up（与 [insertMemberTopupEvent] 同源）。无记录返回 null。 */
export type MemberLastTopupOnCardRow = {
	lastTopupAt: string
	usdcE6: string | null
	pointsE6: string | null
	baseTxHash: string | null
}

export const getMemberLastTopupOnCard = async (
	cardAddress: string,
	memberEoa: string
): Promise<MemberLastTopupOnCardRow | null> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureBeamioMemberTopupEventsSchema(db)
		const card = ethers.getAddress(cardAddress).toLowerCase()
		const eoa = ethers.getAddress(memberEoa).toLowerCase()
		const { rows } = await db.query<{
			created_at: Date
			usdc_e6: string | null
			points_e6: string | null
			base_tx_hash: string
		}>(
			`
			SELECT created_at, usdc_e6, points_e6, base_tx_hash
			FROM beamio_member_topup_events
			WHERE LOWER(TRIM(card_address)) = $1 AND LOWER(TRIM(member_eoa)) = $2
			ORDER BY created_at DESC, id DESC
			LIMIT 1
			`,
			[card, eoa]
		)
		if (!rows.length) return null
		const r = rows[0]
		return {
			lastTopupAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
			usdcE6: r.usdc_e6 != null && String(r.usdc_e6).trim() !== '' ? String(r.usdc_e6).trim() : null,
			pointsE6: r.points_e6 != null && String(r.points_e6).trim() !== '' ? String(r.points_e6).trim() : null,
			baseTxHash: r.base_tx_hash ?? null,
		}
	} catch (e: any) {
		logger(Colors.yellow(`[getMemberLastTopupOnCard] failed: ${e?.message ?? e}`))
		return null
	} finally {
		await db.end().catch(() => {})
	}
}

/**
 * Cluster：按卡读取 beamio_card_member_topup_stats（每用户 top-up 次数、累计 points/USDC、仅最后一次时间戳），按 last_topup_at 倒序分页。
 * total 为该卡聚合行数（会员地址数）。
 */
export const listDistinctCardMemberTopupMembers = async (
	cardAddress: string,
	opts?: { limit?: number; offset?: number }
): Promise<MemberTopupPage<MemberTopupMemberAggRow>> => {
	const db = new Client({ connectionString: DB_URL })
	const limit = Math.min(Math.max(Number(opts?.limit) || 20, 1), 2000)
	const offset = Math.max(Number(opts?.offset) || 0, 0)
	try {
		await db.connect()
		await ensureBeamioCardMemberTopupStatsSchema(db)
		const card = ethers.getAddress(cardAddress).toLowerCase()
		const countRes = await db.query<{ c: string }>(
			`SELECT COUNT(*)::text AS c FROM beamio_card_member_topup_stats WHERE card_address = $1`,
			[card]
		)
		const total = Number(countRes.rows[0]?.c ?? 0) || 0
		const { rows } = await db.query<{
			member_eoa: string
			member_aa: string
			tier_token_id: string
			topup_count: string
			topup_points_total_e6: string
			topup_usdc_total_e6: string
			last_topup_at: Date
			last_base_tx_hash: string | null
		}>(
			`
			SELECT member_eoa, member_aa, tier_token_id, topup_count, topup_points_total_e6, topup_usdc_total_e6, last_topup_at, last_base_tx_hash
			FROM beamio_card_member_topup_stats
			WHERE card_address = $1
			ORDER BY last_topup_at DESC, member_eoa ASC
			LIMIT $2 OFFSET $3
			`,
			[card, limit, offset]
		)
		return { items: rows.map(mapMemberTopupStatsRow), total }
	} catch (e: any) {
		logger(Colors.yellow(`[listDistinctCardMemberTopupMembers] failed: ${e?.message ?? e}`))
		return { items: [], total: 0 }
	} finally {
		await db.end().catch(() => {})
	}
}

/** 每卡会员目录：`beamio_card_member_topup_stats` + `beamio_member_topup_events` 推断 NFC / App 渠道 */
export type CardMemberDirectoryRow = MemberTopupMemberAggRow & {
	usedNfc: boolean
	usedApp: boolean
	firstTopupSource: string | null
	firstTopupAt: string
}

const mapCardMemberDirectoryRow = (
	r: {
		member_eoa: string
		member_aa: string
		tier_token_id: string
		topup_count: string
		topup_points_total_e6: string
		topup_usdc_total_e6: string
		last_topup_at: Date
		last_base_tx_hash: string | null
		used_nfc: boolean
		used_app: boolean
		first_topup_source: string | null
		first_topup_at: Date | null
	}
): CardMemberDirectoryRow => ({
	...mapMemberTopupStatsRow(r),
	usedNfc: Boolean(r.used_nfc),
	usedApp: Boolean(r.used_app),
	firstTopupSource: r.first_topup_source != null && String(r.first_topup_source).trim() !== '' ? String(r.first_topup_source).trim() : null,
	firstTopupAt:
		r.first_topup_at instanceof Date
			? r.first_topup_at.toISOString()
			: r.first_topup_at != null
				? String(r.first_topup_at)
				: '',
})

/** Cluster：同 `listDistinctCardMemberTopupMembers` 排序与分页，附加每笔会员在该卡上的 NFC/App top-up 轨迹 */
export const listCardMemberDirectory = async (
	cardAddress: string,
	opts?: { limit?: number; offset?: number }
): Promise<MemberTopupPage<CardMemberDirectoryRow>> => {
	const db = new Client({ connectionString: DB_URL })
	const limit = Math.min(Math.max(Number(opts?.limit) || 20, 1), 2000)
	const offset = Math.max(Number(opts?.offset) || 0, 0)
	try {
		await db.connect()
		await ensureBeamioCardMemberTopupStatsSchema(db)
		await ensureBeamioMemberTopupEventsSchema(db)
		const card = ethers.getAddress(cardAddress).toLowerCase()
		const countRes = await db.query<{ c: string }>(
			`SELECT COUNT(*)::text AS c FROM beamio_card_member_topup_stats WHERE card_address = $1`,
			[card]
		)
		const total = Number(countRes.rows[0]?.c ?? 0) || 0
		const { rows } = await db.query<{
			member_eoa: string
			member_aa: string
			tier_token_id: string
			topup_count: string
			topup_points_total_e6: string
			topup_usdc_total_e6: string
			last_topup_at: Date
			last_base_tx_hash: string | null
			used_nfc: boolean
			used_app: boolean
			first_topup_source: string | null
			first_topup_at: Date | null
		}>(
			`
			WITH ch AS (
				SELECT
					LOWER(TRIM(member_eoa)) AS eoa,
					BOOL_OR(topup_source = 'androidNfcTopup') AS used_nfc,
					BOOL_OR(topup_source = 'usdcPurchasingCard') AS used_app
				FROM beamio_member_topup_events
				WHERE LOWER(TRIM(card_address)) = $1
				GROUP BY LOWER(TRIM(member_eoa))
			),
			fs AS (
				SELECT DISTINCT ON (LOWER(TRIM(member_eoa)))
					LOWER(TRIM(member_eoa)) AS eoa,
					topup_source AS first_topup_source,
					created_at AS first_topup_at
				FROM beamio_member_topup_events
				WHERE LOWER(TRIM(card_address)) = $1
				ORDER BY LOWER(TRIM(member_eoa)), created_at ASC, id ASC
			)
			SELECT
				s.member_eoa,
				s.member_aa,
				s.tier_token_id,
				s.topup_count,
				s.topup_points_total_e6::text,
				s.topup_usdc_total_e6::text,
				s.last_topup_at,
				s.last_base_tx_hash,
				COALESCE(ch.used_nfc, false) AS used_nfc,
				COALESCE(ch.used_app, false) AS used_app,
				fs.first_topup_source,
				fs.first_topup_at
			FROM beamio_card_member_topup_stats s
			LEFT JOIN ch ON LOWER(TRIM(s.member_eoa)) = ch.eoa
			LEFT JOIN fs ON LOWER(TRIM(s.member_eoa)) = fs.eoa
			WHERE s.card_address = $1
			ORDER BY s.last_topup_at DESC, s.member_eoa ASC
			LIMIT $2 OFFSET $3
			`,
			[card, limit, offset]
		)
		return { items: rows.map(mapCardMemberDirectoryRow), total }
	} catch (e: any) {
		logger(Colors.yellow(`[listCardMemberDirectory] failed: ${e?.message ?? e}`))
		return { items: [], total: 0 }
	} finally {
		await db.end().catch(() => {})
	}
}

/** nfc_cards 表：NTAG 424 DNA 登记卡。uid 为 NFC 卡 UID（兼容旧数据）；tag_id 为 SUN 解密得到的 TagID（16 hex），用于合法性校验与查卡。private_key 为关联私钥（仅服务端使用，不返回客户端） */
const NFC_CARDS_TABLE = `CREATE TABLE IF NOT EXISTS nfc_cards (
	id SERIAL PRIMARY KEY,
	uid TEXT UNIQUE NOT NULL,
	private_key TEXT NOT NULL,
	created_at TIMESTAMPTZ DEFAULT NOW()
)`
const NFC_CARDS_ADD_TAG_ID = `ALTER TABLE nfc_cards ADD COLUMN IF NOT EXISTS tag_id TEXT UNIQUE`
/** Link App 认领完成后写入用户 EOA，供按钱包枚举已绑定 NFC（不暴露私钥） */
const NFC_CARDS_ADD_LINKED_OWNER = `ALTER TABLE nfc_cards ADD COLUMN IF NOT EXISTS linked_owner_eoa TEXT`
const NFC_CARDS_IDX_LINKED_OWNER = `CREATE INDEX IF NOT EXISTS idx_nfc_cards_linked_owner_eoa ON nfc_cards (LOWER(TRIM(linked_owner_eoa))) WHERE linked_owner_eoa IS NOT NULL`
/** user-linked 卡：active 允许 NFC 交易；deactive 仅允许查余额；remove 后清空私钥与 linked_owner */
const NFC_CARDS_ADD_LINK_STATE = `ALTER TABLE nfc_cards ADD COLUMN IF NOT EXISTS nfc_link_state TEXT`
const NFC_CARDS_PRIVATE_KEY_DROP_NOT_NULL = `ALTER TABLE nfc_cards ALTER COLUMN private_key DROP NOT NULL`
/** NFC 自动分配的 verra 序号（遗留），按 tag_id 绑定便于幂等 */
const NFC_CARDS_ADD_VERRA_NUMBER = `ALTER TABLE nfc_cards ADD COLUMN IF NOT EXISTS verra_number BIGINT`
/** NFC 自动分配的 beamio_nfc_* 序号，按 tag_id 绑定便于幂等 */
const NFC_CARDS_ADD_BEAMIO_NFC_NUMBER = `ALTER TABLE nfc_cards ADD COLUMN IF NOT EXISTS beamio_nfc_number BIGINT`

/** NFC TagID -> 已可信确认持有资产的 BeamioUserCard 列表。只在可信链上读成功后 upsert，不因失败/空窗口清空。 */
const NFC_BEAMIO_USER_CARD_HOLDINGS_TABLE = `CREATE TABLE IF NOT EXISTS nfc_beamio_user_card_holdings (
	id SERIAL PRIMARY KEY,
	tag_id TEXT NOT NULL,
	uid TEXT,
	owner_eoa TEXT NOT NULL,
	aa_address TEXT,
	card_address TEXT NOT NULL,
	card_name TEXT,
	card_type TEXT,
	points6 TEXT NOT NULL DEFAULT '0',
	charge_reward_points6 TEXT NOT NULL DEFAULT '0',
	primary_member_token_id TEXT,
	last_trusted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	UNIQUE(tag_id, card_address)
)`
const NFC_BEAMIO_USER_CARD_HOLDINGS_IDX_OWNER = `CREATE INDEX IF NOT EXISTS idx_nfc_beamio_user_card_holdings_owner ON nfc_beamio_user_card_holdings (LOWER(TRIM(owner_eoa)))`
const NFC_BEAMIO_USER_CARD_HOLDINGS_IDX_CARD = `CREATE INDEX IF NOT EXISTS idx_nfc_beamio_user_card_holdings_card ON nfc_beamio_user_card_holdings (LOWER(TRIM(card_address)))`

/** 全局自增 verra 编号（PostgreSQL 单行原子 UPDATE） */
const BEAMIO_VERRA_SEQ_TABLE = `CREATE TABLE IF NOT EXISTS beamio_verra_seq (
	id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
	last_assigned BIGINT NOT NULL DEFAULT 0
)`
const BEAMIO_VERRA_SEQ_SEED = `INSERT INTO beamio_verra_seq (id, last_assigned) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`

/** 全局自增 beamio_nfc_* 编号（PostgreSQL 单行原子 UPDATE） */
const BEAMIO_NFC_SEQ_TABLE = `CREATE TABLE IF NOT EXISTS beamio_nfc_seq (
	id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
	last_assigned BIGINT NOT NULL DEFAULT 0
)`
const BEAMIO_NFC_SEQ_SEED = `INSERT INTO beamio_nfc_seq (id, last_assigned) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`

export const NFC_CARD_LINK_STATE_SCOPE = 'beamio:NfcCardLinkState:v1'
const NFC_GATE_DEACTIVATED_MSG =
	'This NFC card is deactivated. Only balance checks are allowed. Reactivate it in your wallet app first.'
const NFC_GATE_UNLINKED_MSG = 'This NFC card is not linked or the link was removed.'

export type NfcCardSignedTxGate = { ok: true } | { ok: false; code: string; message: string }

async function ensureNfcCardsExtendedSchema(db: Client): Promise<void> {
	await db.query(NFC_CARDS_TABLE)
	await db.query(NFC_CARDS_ADD_TAG_ID)
	await db.query(NFC_CARDS_ADD_LINKED_OWNER)
	await db.query(NFC_CARDS_ADD_LINK_STATE)
	await db.query(NFC_CARDS_PRIVATE_KEY_DROP_NOT_NULL)
	await db.query(NFC_CARDS_ADD_VERRA_NUMBER)
	await db.query(NFC_CARDS_ADD_BEAMIO_NFC_NUMBER)
	await db.query(NFC_CARDS_IDX_LINKED_OWNER)
}

async function ensureNfcBeamioUserCardHoldingsSchema(db: Client): Promise<void> {
	await db.query(NFC_BEAMIO_USER_CARD_HOLDINGS_TABLE)
	await db.query(NFC_BEAMIO_USER_CARD_HOLDINGS_IDX_OWNER)
	await db.query(NFC_BEAMIO_USER_CARD_HOLDINGS_IDX_CARD)
}

export type NfcBeamioUserCardHoldingRow = {
	tagId: string
	uid: string | null
	ownerEoa: string
	aaAddress: string | null
	cardAddress: string
	cardName: string | null
	cardType: string | null
	points6: string
	chargeRewardPoints6: string
	primaryMemberTokenId: string | null
	lastTrustedAt: string
}

function normalizeNfcHoldingTagId(tagIdHex: string): string {
	const tag = String(tagIdHex || '').trim().replace(/^0x/i, '').toUpperCase()
	if (!tag || tag.length !== 16 || !/^[0-9A-F]+$/.test(tag)) {
		throw new Error('Invalid NFC tagId')
	}
	return tag
}

function nfcHoldingRowFromDb(r: {
	tag_id: string
	uid: string | null
	owner_eoa: string
	aa_address: string | null
	card_address: string
	card_name: string | null
	card_type: string | null
	points6: string | null
	charge_reward_points6: string | null
	primary_member_token_id: string | null
	last_trusted_at: Date | string
}): NfcBeamioUserCardHoldingRow {
	return {
		tagId: String(r.tag_id || '').toUpperCase(),
		uid: r.uid ?? null,
		ownerEoa: ethers.getAddress(r.owner_eoa),
		aaAddress: r.aa_address && ethers.isAddress(r.aa_address) ? ethers.getAddress(r.aa_address) : null,
		cardAddress: ethers.getAddress(r.card_address),
		cardName: r.card_name ?? null,
		cardType: r.card_type ?? null,
		points6: String(r.points6 ?? '0'),
		chargeRewardPoints6: String(r.charge_reward_points6 ?? '0'),
		primaryMemberTokenId: r.primary_member_token_id ?? null,
		lastTrustedAt: r.last_trusted_at instanceof Date ? r.last_trusted_at.toISOString() : String(r.last_trusted_at),
	}
}

export async function upsertNfcBeamioUserCardHoldingsFromTrustedCards(params: {
	tagIdHex: string
	uid?: string | null
	ownerEoa: string
	aaAddress?: string | null
	cards: ReadonlyArray<{
		cardAddress: string
		cardName?: string
		cardType?: string
		points6?: string
		chargeRewardPoints6?: string
		primaryMemberTokenId?: string
		nfts?: ReadonlyArray<{ tokenId?: string }>
	}>
}): Promise<void> {
	const tagId = normalizeNfcHoldingTagId(params.tagIdHex)
	const owner = ethers.getAddress(params.ownerEoa).toLowerCase()
	const aa = params.aaAddress && ethers.isAddress(params.aaAddress) ? ethers.getAddress(params.aaAddress).toLowerCase() : null
	const uid = params.uid ? String(params.uid).trim().replace(/^0x/i, '').toLowerCase() : null
	const trustedCards = params.cards.filter((c) => {
		if (!c?.cardAddress || !ethers.isAddress(c.cardAddress)) return false
		let points6 = 0n
		let chargeRewardPoints6 = 0n
		try {
			points6 = BigInt(String(c.points6 ?? '0'))
			chargeRewardPoints6 = BigInt(String(c.chargeRewardPoints6 ?? '0'))
		} catch {
			return false
		}
		const hasNft = Array.isArray(c.nfts) && c.nfts.some((n) => {
			try {
				return BigInt(String(n?.tokenId ?? '0')) > 0n
			} catch {
				return false
			}
		})
		return points6 > 0n || chargeRewardPoints6 > 0n || hasNft
	})
	if (trustedCards.length === 0) return
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureNfcBeamioUserCardHoldingsSchema(db)
		for (const c of trustedCards) {
			const card = ethers.getAddress(c.cardAddress).toLowerCase()
			await db.query(
				`
				INSERT INTO nfc_beamio_user_card_holdings (
					tag_id, uid, owner_eoa, aa_address, card_address,
					card_name, card_type, points6, charge_reward_points6,
					primary_member_token_id, last_trusted_at, updated_at
				)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
				ON CONFLICT (tag_id, card_address) DO UPDATE SET
					uid = COALESCE(EXCLUDED.uid, nfc_beamio_user_card_holdings.uid),
					owner_eoa = EXCLUDED.owner_eoa,
					aa_address = EXCLUDED.aa_address,
					card_name = COALESCE(EXCLUDED.card_name, nfc_beamio_user_card_holdings.card_name),
					card_type = COALESCE(EXCLUDED.card_type, nfc_beamio_user_card_holdings.card_type),
					points6 = EXCLUDED.points6,
					charge_reward_points6 = EXCLUDED.charge_reward_points6,
					primary_member_token_id = COALESCE(EXCLUDED.primary_member_token_id, nfc_beamio_user_card_holdings.primary_member_token_id),
					last_trusted_at = NOW(),
					updated_at = NOW()
				`,
				[
					tagId,
					uid,
					owner,
					aa,
					card,
					c.cardName ?? null,
					c.cardType ?? null,
					String(c.points6 ?? '0'),
					String(c.chargeRewardPoints6 ?? '0'),
					c.primaryMemberTokenId ?? null,
				]
			)
		}
		logger(Colors.green(`[upsertNfcBeamioUserCardHoldings] tagId=${tagId.slice(0, 8)}... cards=${trustedCards.length}`))
	} catch (e: any) {
		logger(Colors.yellow(`[upsertNfcBeamioUserCardHoldings] failed: ${e?.message ?? e}`))
	} finally {
		await db.end().catch(() => {})
	}
}

export async function listNfcBeamioUserCardHoldingsByTagId(tagIdHex: string): Promise<NfcBeamioUserCardHoldingRow[]> {
	const tagId = normalizeNfcHoldingTagId(tagIdHex)
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureNfcBeamioUserCardHoldingsSchema(db)
		const { rows } = await db.query<{
			tag_id: string
			uid: string | null
			owner_eoa: string
			aa_address: string | null
			card_address: string
			card_name: string | null
			card_type: string | null
			points6: string | null
			charge_reward_points6: string | null
			primary_member_token_id: string | null
			last_trusted_at: Date | string
		}>(
			`
			SELECT tag_id, uid, owner_eoa, aa_address, card_address, card_name, card_type,
				points6, charge_reward_points6, primary_member_token_id, last_trusted_at
			FROM nfc_beamio_user_card_holdings
			WHERE tag_id = $1
			ORDER BY last_trusted_at DESC
			`,
			[tagId]
		)
		return rows.map(nfcHoldingRowFromDb)
	} catch (e: any) {
		logger(Colors.yellow(`[listNfcBeamioUserCardHoldingsByTagId] failed: ${e?.message ?? e}`))
		return []
	} finally {
		await db.end().catch(() => {})
	}
}

export async function nfcBeamioUserCardHoldingContains(tagIdHex: string, cardAddress: string): Promise<boolean> {
	const tagId = normalizeNfcHoldingTagId(tagIdHex)
	const card = ethers.getAddress(cardAddress).toLowerCase()
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureNfcBeamioUserCardHoldingsSchema(db)
		const { rows } = await db.query<{ ok: number }>(
			`SELECT 1 AS ok FROM nfc_beamio_user_card_holdings WHERE tag_id = $1 AND card_address = $2 LIMIT 1`,
			[tagId, card]
		)
		return rows.length > 0
	} catch (e: any) {
		logger(Colors.yellow(`[nfcBeamioUserCardHoldingContains] failed: ${e?.message ?? e}`))
		return false
	} finally {
		await db.end().catch(() => {})
	}
}

async function ensureBeamioVerraSeqSchema(db: Client): Promise<void> {
	await db.query(BEAMIO_VERRA_SEQ_TABLE)
	await db.query(BEAMIO_VERRA_SEQ_SEED)
}

/** 分配下一个 verra 序号（全局递增，持久化在 beamio_verra_seq） */
export const allocateNextVerraNumber = async (): Promise<number> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureBeamioVerraSeqSchema(db)
		const { rows } = await db.query<{ last_assigned: string }>(
			`UPDATE beamio_verra_seq SET last_assigned = last_assigned + 1 WHERE id = 1 RETURNING last_assigned`
		)
		const n = rows[0]?.last_assigned
		return n != null ? Number(n) : 1
	} catch (e: any) {
		logger(Colors.yellow(`[allocateNextVerraNumber] failed: ${e?.message ?? e}`))
		return 1
	} finally {
		await db.end().catch(() => {})
	}
}

export const getNfcVerraNumberByTagId = async (tagIdHex: string): Promise<number | null> => {
	const db = new Client({ connectionString: DB_URL })
	const normalized = String(tagIdHex || '').trim().replace(/^0x/i, '').toUpperCase()
	if (!normalized || normalized.length !== 16 || !/^[0-9A-F]+$/.test(normalized)) return null
	try {
		await db.connect()
		await ensureNfcCardsExtendedSchema(db)
		const { rows } = await db.query<{ verra_number: string | null }>(
			`SELECT verra_number FROM nfc_cards WHERE UPPER(TRIM(tag_id)) = $1 LIMIT 1`,
			[normalized]
		)
		const v = rows[0]?.verra_number
		if (v == null) return null
		const n = Number(v)
		return Number.isFinite(n) && n > 0 ? n : null
	} catch (e: any) {
		logger(Colors.yellow(`[getNfcVerraNumberByTagId] failed: ${e?.message ?? e}`))
		return null
	} finally {
		await db.end().catch(() => {})
	}
}

export const setNfcCardVerraNumberIfUnset = async (tagIdHex: string, verraNum: number): Promise<void> => {
	const db = new Client({ connectionString: DB_URL })
	const normalized = String(tagIdHex || '').trim().replace(/^0x/i, '').toUpperCase()
	if (!normalized || normalized.length !== 16 || !/^[0-9A-F]+$/.test(normalized) || !Number.isFinite(verraNum) || verraNum <= 0) return
	try {
		await db.connect()
		await ensureNfcCardsExtendedSchema(db)
		await db.query(
			`UPDATE nfc_cards SET verra_number = $2 WHERE UPPER(TRIM(tag_id)) = $1 AND (verra_number IS NULL OR verra_number <= 0)`,
			[normalized, verraNum]
		)
	} catch (e: any) {
		logger(Colors.yellow(`[setNfcCardVerraNumberIfUnset] failed: ${e?.message ?? e}`))
	} finally {
		await db.end().catch(() => {})
	}
}

export const upsertNfcCardVerraNumberByTagId = async (tagIdHex: string, verraNum: number): Promise<void> => {
	const db = new Client({ connectionString: DB_URL })
	const normalized = String(tagIdHex || '').trim().replace(/^0x/i, '').toUpperCase()
	if (!normalized || normalized.length !== 16 || !/^[0-9A-F]+$/.test(normalized) || !Number.isFinite(verraNum) || verraNum <= 0) return
	try {
		await db.connect()
		await ensureNfcCardsExtendedSchema(db)
		await db.query(`UPDATE nfc_cards SET verra_number = $2 WHERE UPPER(TRIM(tag_id)) = $1`, [normalized, verraNum])
	} catch (e: any) {
		logger(Colors.yellow(`[upsertNfcCardVerraNumberByTagId] failed: ${e?.message ?? e}`))
	} finally {
		await db.end().catch(() => {})
	}
}

/**
 * NFC 自动 beamioTag：verra_{N}（遗留；新登记请用 beamio_nfc_{N}）。
 */
export const buildVerraBeamioAccountName = (verraNumber: number): string => {
	const n = Math.floor(Number(verraNumber))
	if (!Number.isFinite(n) || n <= 0) return ''
	const s = `verra_${n}`
	return BEAMIO_ACCOUNT_NAME_RE.test(s) ? s : ''
}

async function ensureBeamioNfcSeqSchema(db: Client): Promise<void> {
	await db.query(BEAMIO_NFC_SEQ_TABLE)
	await db.query(BEAMIO_NFC_SEQ_SEED)
}

/** 当前 beamio_nfc_seq 已分配到的最大序号（持久化游标） */
export const getBeamioNfcSeqLastAssigned = async (): Promise<number> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureBeamioNfcSeqSchema(db)
		const { rows } = await db.query<{ last_assigned: string }>(
			`SELECT last_assigned FROM beamio_nfc_seq WHERE id = 1 LIMIT 1`
		)
		const n = rows[0]?.last_assigned
		return n != null && Number.isFinite(Number(n)) ? Number(n) : 0
	} catch (e: any) {
		logger(Colors.yellow(`[getBeamioNfcSeqLastAssigned] failed: ${e?.message ?? e}`))
		return 0
	} finally {
		await db.end().catch(() => {})
	}
}

/** 分配下一个 beamio_nfc_* 序号（全局递增，持久化在 beamio_nfc_seq） */
export const allocateNextBeamioNfcNumber = async (): Promise<number> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureBeamioNfcSeqSchema(db)
		const { rows } = await db.query<{ last_assigned: string }>(
			`UPDATE beamio_nfc_seq SET last_assigned = last_assigned + 1 WHERE id = 1 RETURNING last_assigned`
		)
		const n = rows[0]?.last_assigned
		return n != null ? Number(n) : 1
	} catch (e: any) {
		logger(Colors.yellow(`[allocateNextBeamioNfcNumber] failed: ${e?.message ?? e}`))
		return 1
	} finally {
		await db.end().catch(() => {})
	}
}

export const getNfcBeamioNfcNumberByTagId = async (tagIdHex: string): Promise<number | null> => {
	const db = new Client({ connectionString: DB_URL })
	const normalized = String(tagIdHex || '').trim().replace(/^0x/i, '').toUpperCase()
	if (!normalized || normalized.length !== 16 || !/^[0-9A-F]+$/.test(normalized)) return null
	try {
		await db.connect()
		await ensureNfcCardsExtendedSchema(db)
		const { rows } = await db.query<{ beamio_nfc_number: string | null }>(
			`SELECT beamio_nfc_number FROM nfc_cards WHERE UPPER(TRIM(tag_id)) = $1 LIMIT 1`,
			[normalized]
		)
		const v = rows[0]?.beamio_nfc_number
		if (v == null) return null
		const n = Number(v)
		return Number.isFinite(n) && n > 0 ? n : null
	} catch (e: any) {
		logger(Colors.yellow(`[getNfcBeamioNfcNumberByTagId] failed: ${e?.message ?? e}`))
		return null
	} finally {
		await db.end().catch(() => {})
	}
}

export const setNfcCardBeamioNfcNumberIfUnset = async (tagIdHex: string, nfcNum: number): Promise<void> => {
	const db = new Client({ connectionString: DB_URL })
	const normalized = String(tagIdHex || '').trim().replace(/^0x/i, '').toUpperCase()
	if (!normalized || normalized.length !== 16 || !/^[0-9A-F]+$/.test(normalized) || !Number.isFinite(nfcNum) || nfcNum <= 0) return
	try {
		await db.connect()
		await ensureNfcCardsExtendedSchema(db)
		await db.query(
			`UPDATE nfc_cards SET beamio_nfc_number = $2 WHERE UPPER(TRIM(tag_id)) = $1 AND (beamio_nfc_number IS NULL OR beamio_nfc_number <= 0)`,
			[normalized, nfcNum]
		)
	} catch (e: any) {
		logger(Colors.yellow(`[setNfcCardBeamioNfcNumberIfUnset] failed: ${e?.message ?? e}`))
	} finally {
		await db.end().catch(() => {})
	}
}

export const upsertNfcCardBeamioNfcNumberByTagId = async (tagIdHex: string, nfcNum: number): Promise<void> => {
	const db = new Client({ connectionString: DB_URL })
	const normalized = String(tagIdHex || '').trim().replace(/^0x/i, '').toUpperCase()
	if (!normalized || normalized.length !== 16 || !/^[0-9A-F]+$/.test(normalized) || !Number.isFinite(nfcNum) || nfcNum <= 0) return
	try {
		await db.connect()
		await ensureNfcCardsExtendedSchema(db)
		await db.query(`UPDATE nfc_cards SET beamio_nfc_number = $2 WHERE UPPER(TRIM(tag_id)) = $1`, [normalized, nfcNum])
	} catch (e: any) {
		logger(Colors.yellow(`[upsertNfcCardBeamioNfcNumberByTagId] failed: ${e?.message ?? e}`))
	} finally {
		await db.end().catch(() => {})
	}
}

/** NFC 自动 beamioTag：beamio_nfc_{N}（accountName 3–20，须链上未被他人占用） */
export const buildBeamioNfcBeamioAccountName = (nfcNumber: number): string => {
	const n = Math.floor(Number(nfcNumber))
	if (!Number.isFinite(n) || n <= 0) return ''
	const s = `beamio_nfc_${n}`
	return BEAMIO_ACCOUNT_NAME_RE.test(s) ? s : ''
}

async function isBeamioAccountNameAvailableForWallet(
	reg: { getOwnerByAccountName: (name: string) => Promise<string> },
	accountName: string,
	wallet: string
): Promise<boolean> {
	if (!accountName || !BEAMIO_ACCOUNT_NAME_RE.test(accountName)) return false
	try {
		let ow: string
		try {
			ow = await reg.getOwnerByAccountName(accountName)
		} catch (probeEx: unknown) {
			if (isOnchainEmptyResult(probeEx)) return true
			throw probeEx
		}
		if (!ow || ow === ethers.ZeroAddress) return true
		return ow.toLowerCase() === wallet.toLowerCase()
	} catch {
		return false
	}
}

/** 拉取链上 owner 校验；若已被占用则递增序号直至可用（最多 24 次）。 */
export const resolveUniqueBeamioNfcAccountName = async (
	reg: { getOwnerByAccountName: (name: string) => Promise<string> },
	wallet: string,
	tagIdHex: string | null | undefined
): Promise<string> => {
	const tagRaw = tagIdHex != null ? String(tagIdHex).trim().replace(/^0x/i, '').toUpperCase() : ''
	const tagOk = tagRaw.length === 16 && /^[0-9A-F]+$/.test(tagRaw)

	let n: number | null = null
	if (tagOk) {
		n = await getNfcBeamioNfcNumberByTagId(tagRaw)
	}
	if (n == null) {
		n = await allocateNextBeamioNfcNumber()
		if (tagOk) await setNfcCardBeamioNfcNumberIfUnset(tagRaw, n)
	}

	for (let attempt = 0; attempt < 24; attempt++) {
		if (attempt > 0) {
			n = await allocateNextBeamioNfcNumber()
			if (tagOk) await upsertNfcCardBeamioNfcNumberByTagId(tagRaw, n)
		}
		const cand = buildBeamioNfcBeamioAccountName(n)
		if (!cand) continue
		if (await isBeamioAccountNameAvailableForWallet(reg, cand, wallet)) {
			return cand
		}
	}
	return ''
}

function normalizeNfcLinkStateRow(state: string | null | undefined, hasPk: boolean): 'active' | 'deactive' | 'removed' {
	if (!hasPk) return 'removed'
	const s = String(state ?? '').trim().toLowerCase()
	if (s === 'deactive') return 'deactive'
	return 'active'
}

/**
 * NFC 发起支付/充值/Link 等写操作前检查：DB 行存在且 deactive/removed 时拒绝；无行则不限制（兼容 mnemonic 路径，由私钥解析后续处理）。
 */
export const getNfcCardSignedTxGateByTagId = async (tagIdHex: string): Promise<NfcCardSignedTxGate> => {
	const db = new Client({ connectionString: DB_URL })
	const normalized = String(tagIdHex || '').trim().toUpperCase()
	if (!normalized || normalized.length !== 16 || !/^[0-9A-F]+$/.test(normalized)) return { ok: true }
	try {
		await db.connect()
		await ensureNfcCardsExtendedSchema(db)
		const { rows } = await db.query<{ private_key: string | null; nfc_link_state: string | null }>(
			`SELECT private_key, nfc_link_state FROM nfc_cards WHERE UPPER(TRIM(tag_id)) = $1 LIMIT 1`,
			[normalized]
		)
		if (rows.length === 0) return { ok: true }
		const hasPk = rows[0].private_key != null && String(rows[0].private_key).trim() !== ''
		const st = normalizeNfcLinkStateRow(rows[0].nfc_link_state, hasPk)
		if (st === 'removed' || !hasPk) return { ok: false, code: 'NFC_CARD_UNLINKED', message: NFC_GATE_UNLINKED_MSG }
		if (st === 'deactive') return { ok: false, code: 'NFC_CARD_DEACTIVATED', message: NFC_GATE_DEACTIVATED_MSG }
		return { ok: true }
	} catch (e: any) {
		logger(Colors.yellow(`[getNfcCardSignedTxGateByTagId] failed: ${e?.message ?? e}`))
		return { ok: true }
	} finally {
		await db.end().catch(() => {})
	}
}

export const getNfcCardSignedTxGateByUid = async (uid: string): Promise<NfcCardSignedTxGate> => {
	const db = new Client({ connectionString: DB_URL })
	const normalizedUid = String(uid || '').trim().toLowerCase()
	if (!normalizedUid) return { ok: true }
	try {
		await db.connect()
		await ensureNfcCardsExtendedSchema(db)
		const { rows } = await db.query<{ private_key: string | null; nfc_link_state: string | null }>(
			`SELECT private_key, nfc_link_state FROM nfc_cards WHERE LOWER(TRIM(uid)) = $1 LIMIT 1`,
			[normalizedUid]
		)
		if (rows.length === 0) return { ok: true }
		const hasPk = rows[0].private_key != null && String(rows[0].private_key).trim() !== ''
		const st = normalizeNfcLinkStateRow(rows[0].nfc_link_state, hasPk)
		if (st === 'removed' || !hasPk) return { ok: false, code: 'NFC_CARD_UNLINKED', message: NFC_GATE_UNLINKED_MSG }
		if (st === 'deactive') return { ok: false, code: 'NFC_CARD_DEACTIVATED', message: NFC_GATE_DEACTIVATED_MSG }
		return { ok: true }
	} catch (e: any) {
		logger(Colors.yellow(`[getNfcCardSignedTxGateByUid] failed: ${e?.message ?? e}`))
		return { ok: true }
	} finally {
		await db.end().catch(() => {})
	}
}

/** 与 UI `wallet.signMessage(message)` 一致：键名排序后的 JSON 字符串。 */
export function buildNfcCardLinkStateSignMessage(
	action: 'active' | 'deactive' | 'remove',
	tagId16: string,
	issuedAtSec: number
): string {
	const tag = String(tagId16 || '')
		.trim()
		.replace(/^0x/i, '')
		.toUpperCase()
	if (!/^[0-9A-F]{16}$/.test(tag)) {
		throw new Error('tagId must be 16 hex characters')
	}
	if (!Number.isFinite(issuedAtSec) || issuedAtSec <= 0) {
		throw new Error('issuedAt must be a positive Unix timestamp in seconds')
	}
	if (action !== 'active' && action !== 'deactive' && action !== 'remove') {
		throw new Error('action must be active, deactive, or remove')
	}
	const o = {
		action,
		issuedAt: Math.floor(issuedAtSec),
		scope: NFC_CARD_LINK_STATE_SCOPE,
		tagId: tag,
	}
	return JSON.stringify(o, Object.keys(o).sort())
}

export const applyNfcCardLinkStateChange = async (params: {
	message: string
	signature: string
}): Promise<
	| { ok: true; action: 'active' | 'deactive' | 'remove'; tagId: string }
	| { ok: false; error: string; errorCode?: string }
> => {
	const msgRaw = String(params.message || '').trim()
	const sigRaw = String(params.signature || '').trim()
	if (!msgRaw || !sigRaw) {
		return { ok: false, error: 'Missing message or signature.', errorCode: 'MISSING_PARAMS' }
	}
	let parsed: { action?: string; issuedAt?: number; scope?: string; tagId?: string }
	try {
		parsed = JSON.parse(msgRaw) as typeof parsed
	} catch {
		return { ok: false, error: 'Invalid message JSON.', errorCode: 'INVALID_JSON' }
	}
	const action = parsed.action
	const issuedAt = parsed.issuedAt
	const scope = parsed.scope
	const tagIdRaw = parsed.tagId
	if (action !== 'active' && action !== 'deactive' && action !== 'remove') {
		return { ok: false, error: 'Invalid action.', errorCode: 'INVALID_ACTION' }
	}
	if (scope !== NFC_CARD_LINK_STATE_SCOPE) {
		return { ok: false, error: 'Invalid scope.', errorCode: 'INVALID_SCOPE' }
	}
	const tagUpper = String(tagIdRaw || '')
		.trim()
		.replace(/^0x/i, '')
		.toUpperCase()
	if (!/^[0-9A-F]{16}$/.test(tagUpper)) {
		return { ok: false, error: 'Invalid tagId.', errorCode: 'INVALID_TAG_ID' }
	}
	if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) {
		return { ok: false, error: 'Invalid issuedAt.', errorCode: 'INVALID_ISSUED_AT' }
	}
	const now = Math.floor(Date.now() / 1000)
	if (Math.abs(now - Math.floor(issuedAt)) > 600) {
		return { ok: false, error: 'issuedAt expired or out of range.', errorCode: 'STALE_MESSAGE' }
	}
	let canonical: string
	try {
		canonical = buildNfcCardLinkStateSignMessage(action, tagUpper, issuedAt)
	} catch (e: any) {
		return { ok: false, error: e?.message ?? 'Invalid payload', errorCode: 'INVALID_PAYLOAD' }
	}
	if (canonical !== msgRaw) {
		return {
			ok: false,
			error: 'Message must be canonical JSON (sorted keys: action, issuedAt, scope, tagId).',
			errorCode: 'NON_CANONICAL_MESSAGE',
		}
	}
	let recovered: string
	try {
		recovered = ethers.verifyMessage(msgRaw, sigRaw)
	} catch {
		return { ok: false, error: 'Invalid signature.', errorCode: 'INVALID_SIGNATURE' }
	}
	const recoveredNorm = ethers.getAddress(recovered).toLowerCase()

	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureNfcCardsExtendedSchema(db)
		const { rows } = await db.query<{ private_key: string | null; linked_owner_eoa: string | null }>(
			`SELECT private_key, linked_owner_eoa FROM nfc_cards WHERE UPPER(TRIM(tag_id)) = $1 LIMIT 1`,
			[tagUpper]
		)
		if (rows.length === 0) {
			return { ok: false, error: 'Card not found for tagId.', errorCode: 'NOT_FOUND' }
		}
		const pk = rows[0].private_key
		const ownerCol = rows[0].linked_owner_eoa
		if (!pk || !String(pk).trim()) {
			return { ok: false, error: 'Card has no bound private key.', errorCode: 'NOT_LINKED' }
		}
		if (!ownerCol || !String(ownerCol).trim()) {
			return { ok: false, error: 'Only user-linked cards can change link state this way.', errorCode: 'NOT_USER_LINKED' }
		}
		let pkAddr: string
		try {
			pkAddr = ethers.getAddress(new ethers.Wallet(String(pk).trim()).address).toLowerCase()
		} catch {
			return { ok: false, error: 'Stored key is invalid.', errorCode: 'INVALID_STORED_KEY' }
		}
		const ownerNorm = ethers.getAddress(String(ownerCol).trim()).toLowerCase()
		if (pkAddr !== recoveredNorm || ownerNorm !== recoveredNorm) {
			return { ok: false, error: 'Signer does not match the card bound wallet.', errorCode: 'SIGNER_MISMATCH' }
		}

		if (action === 'remove') {
			await db.query(
				`UPDATE nfc_cards SET private_key = NULL, linked_owner_eoa = NULL, nfc_link_state = 'removed' WHERE UPPER(TRIM(tag_id)) = $1`,
				[tagUpper]
			)
		} else if (action === 'deactive') {
			await db.query(`UPDATE nfc_cards SET nfc_link_state = 'deactive' WHERE UPPER(TRIM(tag_id)) = $1`, [tagUpper])
		} else {
			await db.query(`UPDATE nfc_cards SET nfc_link_state = 'active' WHERE UPPER(TRIM(tag_id)) = $1`, [tagUpper])
		}
		return { ok: true, action, tagId: tagUpper }
	} catch (e: any) {
		logger(Colors.red(`[applyNfcCardLinkStateChange] ${e?.message ?? e}`))
		return { ok: false, error: e?.message ?? 'Database error.', errorCode: 'DB_ERROR' }
	} finally {
		await db.end().catch(() => {})
	}
}

/** beamio_sun_counter_state 表：仅存 SUN 防重放状态，uid 对应最新成功通过验真的 counter。 */
const BEAMIO_SUN_COUNTER_STATE_TABLE = `CREATE TABLE IF NOT EXISTS beamio_sun_counter_state (
	id SERIAL PRIMARY KEY,
	uid TEXT UNIQUE NOT NULL,
	last_counter TEXT NOT NULL,
	updated_at TIMESTAMPTZ DEFAULT NOW()
)`

/** nfc_link_app_sessions：Link App 进行中会话（Cluster/Master 共用 PG，替代进程内 Map） */
const NFC_LINK_APP_SESSIONS_TABLE = `CREATE TABLE IF NOT EXISTS nfc_link_app_sessions (
	tag_id_hex TEXT PRIMARY KEY,
	uid_hex TEXT NOT NULL,
	counter_hex TEXT NOT NULL,
	payer_eoa TEXT NOT NULL,
	aa_address TEXT NOT NULL,
	redeem_hash_bytes32 TEXT,
	chain_tx_hash TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	released_at TIMESTAMPTZ
)`
const NFC_LINK_APP_SESSIONS_IDX_PAYER = `CREATE INDEX IF NOT EXISTS idx_nfc_link_app_sessions_active_payer ON nfc_link_app_sessions (LOWER(payer_eoa)) WHERE released_at IS NULL`
const NFC_LINK_APP_SESSIONS_IDX_AA = `CREATE INDEX IF NOT EXISTS idx_nfc_link_app_sessions_active_aa ON nfc_link_app_sessions (LOWER(aa_address)) WHERE released_at IS NULL AND LOWER(TRIM(aa_address)) <> '0x0000000000000000000000000000000000000000'`
const NFC_LINK_APP_SESSIONS_ADD_PLAINTEXT = `ALTER TABLE nfc_link_app_sessions ADD COLUMN IF NOT EXISTS link_redeem_plaintext TEXT`
const NFC_LINK_APP_SESSIONS_ADD_PUBLIC = `ALTER TABLE nfc_link_app_sessions ADD COLUMN IF NOT EXISTS link_redeem_public TEXT`
const NFC_LINK_APP_SESSIONS_ADD_AUTO_CANCEL_AT = `ALTER TABLE nfc_link_app_sessions ADD COLUMN IF NOT EXISTS auto_cancel_at TIMESTAMPTZ`
const NFC_LINK_APP_SESSIONS_IDX_AUTO_CANCEL = `CREATE INDEX IF NOT EXISTS idx_nfc_link_app_sessions_auto_cancel ON nfc_link_app_sessions (auto_cancel_at) WHERE released_at IS NULL AND auto_cancel_at IS NOT NULL`
const NFC_LINK_APP_SESSIONS_ADD_MIGRATE_VIA_CONTAINER = `ALTER TABLE nfc_link_app_sessions ADD COLUMN IF NOT EXISTS migrate_via_container BOOLEAN NOT NULL DEFAULT FALSE`

/** ai_learning_feedback 表：AI 学习反馈，共享给所有 Beamio 用户。kind: approved=满意, corrected=纠正 */
const AI_LEARNING_FEEDBACK_TABLE = `CREATE TABLE IF NOT EXISTS ai_learning_feedback (
	id SERIAL PRIMARY KEY,
	kind TEXT NOT NULL,
	user_input TEXT NOT NULL,
	action_json JSONB NOT NULL,
	custom_rule TEXT,
	created_at TIMESTAMPTZ DEFAULT NOW()
)`

/** 插入 AI 学习反馈。correctedAction：Beamio 提供的期望 action（用于 UI 学习，存入 custom_rule 的 JSON） */
export const insertAiLearningFeedback = async (
	kind: string,
	userInput: string,
	actionJson: object,
	customRule?: string,
	correctedAction?: object
): Promise<boolean> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await db.query(AI_LEARNING_FEEDBACK_TABLE)
		// correctedAction 时：custom_rule 存 JSON {_correctedAction: action}，供 prompt 解析
		const ruleVal = correctedAction
			? JSON.stringify({ _correctedAction: correctedAction })
			: (customRule ?? null)
		await db.query(
			`INSERT INTO ai_learning_feedback (kind, user_input, action_json, custom_rule) VALUES ($1, $2, $3, $4)`,
			[kind, String(userInput || '').trim().slice(0, 500), JSON.stringify(actionJson), ruleVal]
		)
		return true
	} catch (e: any) {
		logger(Colors.yellow(`[insertAiLearningFeedback] failed: ${e?.message ?? e}`))
		return false
	} finally {
		await db.end().catch(() => {})
	}
}

/** 获取所有 AI 学习反馈（共享给所有用户，取最近 50 条） */
export const getAiLearningFeedback = async (): Promise<Array<{ kind: string; user_input: string; action_json: object; custom_rule: string | null }>> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await db.query(AI_LEARNING_FEEDBACK_TABLE)
		const { rows } = await db.query(
			`SELECT kind, user_input, action_json, custom_rule FROM ai_learning_feedback ORDER BY created_at DESC LIMIT 50`
		)
		return rows.map((r: any) => ({
			kind: r.kind,
			user_input: r.user_input,
			action_json: r.action_json ?? {},
			custom_rule: r.custom_rule,
		}))
	} catch (e: any) {
		logger(Colors.yellow(`[getAiLearningFeedback] failed: ${e?.message ?? e}`))
		return []
	} finally {
		await db.end().catch(() => {})
	}
}

/** 根据 UID 查询 NFC 卡状态（不返回 private_key）；若已登记则从 private_key 推导 address 返回 */
export const getNfcCardByUid = async (uid: string): Promise<{ registered: boolean; address?: string }> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureNfcCardsExtendedSchema(db)
		const normalizedUid = String(uid || '').trim().toLowerCase()
		if (!normalizedUid) return { registered: false }
		const { rows } = await db.query<{ private_key: string | null }>(
			`SELECT private_key FROM nfc_cards WHERE LOWER(uid) = $1 LIMIT 1`,
			[normalizedUid]
		)
		if (rows.length === 0) return { registered: false }
		const pk = rows[0].private_key
		if (pk == null || String(pk).trim() === '') return { registered: false }
		try {
			const wallet = new ethers.Wallet(pk)
			const address = await wallet.getAddress()
			return { registered: true, address }
		} catch (e: any) {
			logger(Colors.yellow(`[getNfcCardByUid] derive address failed: ${e?.message ?? e}`))
			return { registered: true }
		}
	} catch (e: any) {
		logger(Colors.yellow(`[getNfcCardByUid] failed: ${e?.message ?? e}`))
		return { registered: false }
	} finally {
		await db.end().catch(() => {})
	}
}

/** 服务端专用：根据 UID 获取 private_key（仅 Master 支付流程使用，不返回客户端）。若 DB 无则从 mnemonic 派生，与 getNfcRecipientAddressByUid / nfcTopup 一致 */
export const getNfcCardPrivateKeyByUid = async (uid: string): Promise<string | null> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureNfcCardsExtendedSchema(db)
		const normalizedUid = String(uid || '').trim().toLowerCase()
		if (!normalizedUid) return null
		const { rows } = await db.query<{ private_key: string | null }>(
			`SELECT private_key FROM nfc_cards WHERE LOWER(uid) = $1 LIMIT 1`,
			[normalizedUid]
		)
		if (rows.length > 0) {
			const pk = rows[0].private_key
			if (pk != null && String(pk).trim() !== '') return String(pk).trim()
			return null
		}
	} catch (e: any) {
		logger(Colors.yellow(`[getNfcCardPrivateKeyByUid] failed: ${e?.message ?? e}`))
		return null
	} finally {
		await db.end().catch(() => {})
	}
	// DB 无则从 mnemonic 派生（与 getNfcRecipientAddressByUid 一致）
	const mnemonic = (masterSetup as any)?.cryptoPayWallet
	if (!mnemonic || typeof mnemonic !== 'string') return null
	const uidNorm = String(uid || '').trim().toLowerCase()
	if (!uidNorm || !/^[0-9a-f]+$/i.test(uidNorm)) return null
	const uidHex = uidNorm.padStart(14, '0').slice(-14)
	try {
		const uidBytes = ethers.getBytes('0x' + uidHex)
		const hash = ethers.keccak256(uidBytes)
		const offset = Number(BigInt(hash) % (2n ** 31n))
		const path = `m/44'/60'/0'/0/${offset}`
		const derived = ethers.HDNodeWallet.fromPhrase(mnemonic.trim(), path)
		return derived.privateKey
	} catch {
		return null
	}
}

/** 根据 TagID（SUN 解密得到的 16 hex）获取 NFC 卡对应的 private_key。仅查 DB，TagID 未登记则返回 null（非法卡）。供 Charge 流程用卡私钥签名。 */
export const getNfcCardPrivateKeyByTagId = async (tagIdHex: string): Promise<string | null> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureNfcCardsExtendedSchema(db)
		const normalized = String(tagIdHex || '').trim().toUpperCase()
		if (!normalized || normalized.length !== 16 || !/^[0-9A-F]+$/.test(normalized)) return null
		const { rows } = await db.query<{ private_key: string | null }>(
			`SELECT private_key FROM nfc_cards WHERE UPPER(TRIM(tag_id)) = $1 LIMIT 1`,
			[normalized]
		)
		if (rows.length === 0) return null
		const pk = rows[0].private_key
		if (pk == null || String(pk).trim() === '') return null
		return String(pk).trim()
	} catch (e: any) {
		logger(Colors.yellow(`[getNfcCardPrivateKeyByTagId] failed: ${e?.message ?? e}`))
		return null
	} finally {
		await db.end().catch(() => {})
	}
}

/** 根据 TagID（SUN 解密得到的 16 hex）获取 NFC 卡对应的 recipient EOA。仅查 DB，TagID 未登记则返回 null（非法卡）。 */
export const getNfcRecipientAddressByTagId = async (tagIdHex: string): Promise<string | null> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureNfcCardsExtendedSchema(db)
		const normalized = String(tagIdHex || '').trim().toUpperCase()
		if (!normalized || normalized.length !== 16 || !/^[0-9A-F]+$/.test(normalized)) return null
		const { rows } = await db.query<{ private_key: string | null }>(
			`SELECT private_key FROM nfc_cards WHERE UPPER(TRIM(tag_id)) = $1 LIMIT 1`,
			[normalized]
		)
		if (rows.length === 0) return null
		const pk = rows[0].private_key
		if (pk == null || String(pk).trim() === '') return null
		const wallet = new ethers.Wallet(String(pk).trim())
		return await wallet.getAddress()
	} catch (e: any) {
		logger(Colors.yellow(`[getNfcRecipientAddressByTagId] failed: ${e?.message ?? e}`))
		return null
	} finally {
		await db.end().catch(() => {})
	}
}

function normalizeTagIdHexForLinkSession(raw: string): string {
	return String(raw || '').trim().replace(/^0x/i, '').toLowerCase()
}

async function ensureNfcLinkAppSessionsSchema(db: Client): Promise<void> {
	await db.query(NFC_LINK_APP_SESSIONS_TABLE)
	await db.query(NFC_LINK_APP_SESSIONS_ADD_PLAINTEXT)
	await db.query(NFC_LINK_APP_SESSIONS_ADD_PUBLIC)
	await db.query(NFC_LINK_APP_SESSIONS_ADD_AUTO_CANCEL_AT)
	await db.query(NFC_LINK_APP_SESSIONS_ADD_MIGRATE_VIA_CONTAINER)
	await db.query(NFC_LINK_APP_SESSIONS_IDX_AUTO_CANCEL)
	await db.query(NFC_LINK_APP_SESSIONS_IDX_PAYER)
	await db.query(NFC_LINK_APP_SESSIONS_IDX_AA)
}

export type NfcLinkAppSessionDb = {
	tagIdHex: string
	uid: string
	counterHex: string
	payerEoa: string
	aaAddress: string
	redeemHashBytes32: `0x${string}` | null
	chainTxHash: string | null
	/** 仅服务端用于 POS cancelRedeem；勿对外 API 返回 */
	linkRedeemPlaintext: string | null
	/** 深链 nftRedeemcode 公开段（不含 6 位 security），供校验 */
	linkRedeemPublic: string | null
	/** POST /api/nfcLinkApp 锁定后计划自动解锁时间（Master 定时任务） */
	autoCancelAt: Date | null
	/** 有 infra #0 时：认领阶段用 NFC 私钥签 Container 迁移，而非 createRedeemBatch/redeemForUser */
	migrateViaContainer: boolean
}

function rowToNfcLinkSession(r: {
	tag_id_hex: string
	uid_hex: string
	counter_hex: string
	payer_eoa: string
	aa_address: string
	redeem_hash_bytes32: string | null
	chain_tx_hash: string | null
	link_redeem_plaintext?: string | null
	link_redeem_public?: string | null
	auto_cancel_at?: Date | string | null
	migrate_via_container?: boolean | null
}): NfcLinkAppSessionDb {
	const h = r.redeem_hash_bytes32
	const plain = r.link_redeem_plaintext
	const pub = r.link_redeem_public
	const ac = r.auto_cancel_at
	let autoCancelAt: Date | null = null
	if (ac != null) {
		autoCancelAt = ac instanceof Date ? ac : new Date(ac)
		if (Number.isNaN(autoCancelAt.getTime())) autoCancelAt = null
	}
	return {
		tagIdHex: r.tag_id_hex,
		uid: r.uid_hex,
		counterHex: r.counter_hex,
		payerEoa: ethers.getAddress(r.payer_eoa),
		aaAddress: ethers.getAddress(r.aa_address),
		redeemHashBytes32: h && String(h).length > 0 ? (String(h) as `0x${string}`) : null,
		chainTxHash: r.chain_tx_hash,
		linkRedeemPlaintext: plain != null && String(plain).length > 0 ? String(plain) : null,
		linkRedeemPublic: pub != null && String(pub).length > 0 ? String(pub) : null,
		autoCancelAt,
		migrateViaContainer: Boolean(r.migrate_via_container),
	}
}

/** 写入或刷新当前 tag 的 Link App 活跃会话（released_at 置空） */
export const upsertActiveNfcLinkAppSession = async (rec: {
	tagIdHex: string
	uid: string
	counterHex: string
	payerEoa: string
	aaAddress: string
	redeemHashBytes32: string | null
	chainTxHash: string | null
	linkRedeemPlaintext?: string | null
	linkRedeemPublic?: string | null
	migrateViaContainer?: boolean
}): Promise<void> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureNfcLinkAppSessionsSchema(db)
		const tag = normalizeTagIdHexForLinkSession(rec.tagIdHex)
		if (!tag || tag.length !== 16 || !/^[0-9a-f]+$/.test(tag)) {
			throw new Error('Invalid tagIdHex for nfc link session')
		}
		const payer = ethers.getAddress(rec.payerEoa).toLowerCase()
		const aa = ethers.getAddress(rec.aaAddress).toLowerCase()
		const ctr = String(rec.counterHex || '').trim().toLowerCase()
		const rh = rec.redeemHashBytes32 ? String(rec.redeemHashBytes32).toLowerCase() : null
		const ctx = rec.chainTxHash ? String(rec.chainTxHash).trim() : null
		const plain = rec.linkRedeemPlaintext != null && String(rec.linkRedeemPlaintext).length > 0 ? String(rec.linkRedeemPlaintext) : null
		const pub = rec.linkRedeemPublic != null && String(rec.linkRedeemPublic).length > 0 ? String(rec.linkRedeemPublic) : null
		const mvc = Boolean(rec.migrateViaContainer)
		await db.query(
			`INSERT INTO nfc_link_app_sessions (tag_id_hex, uid_hex, counter_hex, payer_eoa, aa_address, redeem_hash_bytes32, chain_tx_hash, link_redeem_plaintext, link_redeem_public, migrate_via_container, released_at, auto_cancel_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, NOW() + INTERVAL '5 minutes')
			ON CONFLICT (tag_id_hex) DO UPDATE SET
				uid_hex = EXCLUDED.uid_hex,
				counter_hex = EXCLUDED.counter_hex,
				payer_eoa = EXCLUDED.payer_eoa,
				aa_address = EXCLUDED.aa_address,
				redeem_hash_bytes32 = EXCLUDED.redeem_hash_bytes32,
				chain_tx_hash = EXCLUDED.chain_tx_hash,
				link_redeem_plaintext = EXCLUDED.link_redeem_plaintext,
				link_redeem_public = EXCLUDED.link_redeem_public,
				migrate_via_container = EXCLUDED.migrate_via_container,
				released_at = NULL,
				auto_cancel_at = NOW() + INTERVAL '5 minutes',
				created_at = NOW()`,
			[tag, rec.uid.trim(), ctr, payer, aa, rh, ctx, plain, pub, mvc]
		)
	} catch (e: any) {
		logger(Colors.yellow(`[upsertActiveNfcLinkAppSession] failed: ${e?.message ?? e}`))
		throw e
	} finally {
		await db.end().catch(() => {})
	}
}

/** 按 tag → AA → payer 顺序查找未释放会话，供付款拦截与校验 */
export const fetchActiveNfcLinkAppSessionForPaymentBlock = async (opts: {
	tagIdHex?: string
	aaAddress?: string
	payerEoa?: string
}): Promise<NfcLinkAppSessionDb | null> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureNfcLinkAppSessionsSchema(db)
		if (opts.tagIdHex) {
			const tag = normalizeTagIdHexForLinkSession(opts.tagIdHex)
			if (tag) {
				const { rows } = await db.query(
					`SELECT tag_id_hex, uid_hex, counter_hex, payer_eoa, aa_address, redeem_hash_bytes32, chain_tx_hash, link_redeem_plaintext, link_redeem_public, auto_cancel_at, migrate_via_container
					FROM nfc_link_app_sessions WHERE tag_id_hex = $1 AND released_at IS NULL LIMIT 1`,
					[tag]
				)
				if (rows[0]) return rowToNfcLinkSession(rows[0] as any)
			}
		}
		if (opts.aaAddress && ethers.isAddress(opts.aaAddress)) {
			const aa = ethers.getAddress(opts.aaAddress).toLowerCase()
			if (aa !== ethers.ZeroAddress.toLowerCase()) {
				const { rows } = await db.query(
					`SELECT tag_id_hex, uid_hex, counter_hex, payer_eoa, aa_address, redeem_hash_bytes32, chain_tx_hash, link_redeem_plaintext, link_redeem_public, auto_cancel_at, migrate_via_container
					FROM nfc_link_app_sessions WHERE LOWER(TRIM(aa_address)) = $1 AND released_at IS NULL LIMIT 1`,
					[aa]
				)
				if (rows[0]) return rowToNfcLinkSession(rows[0] as any)
			}
		}
		if (opts.payerEoa && ethers.isAddress(opts.payerEoa)) {
			const pay = ethers.getAddress(opts.payerEoa).toLowerCase()
			const { rows } = await db.query(
				`SELECT tag_id_hex, uid_hex, counter_hex, payer_eoa, aa_address, redeem_hash_bytes32, chain_tx_hash, link_redeem_plaintext, link_redeem_public, auto_cancel_at, migrate_via_container
				FROM nfc_link_app_sessions WHERE LOWER(TRIM(payer_eoa)) = $1 AND released_at IS NULL LIMIT 1`,
				[pay]
			)
			if (rows[0]) return rowToNfcLinkSession(rows[0] as any)
		}
		return null
	} catch (e: any) {
		logger(Colors.yellow(`[fetchActiveNfcLinkAppSessionForPaymentBlock] failed: ${e?.message ?? e}`))
		return null
	} finally {
		await db.end().catch(() => {})
	}
}

/** 链上 redeem 已结束或业务清会话：按 tag 标记释放 */
export const markNfcLinkAppSessionReleasedByTag = async (tagIdHex: string): Promise<void> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureNfcLinkAppSessionsSchema(db)
		const tag = normalizeTagIdHexForLinkSession(tagIdHex)
		if (!tag) return
		await db.query(
			`UPDATE nfc_link_app_sessions SET released_at = NOW(), auto_cancel_at = NULL WHERE tag_id_hex = $1 AND released_at IS NULL`,
			[tag]
		)
	} catch (e: any) {
		logger(Colors.yellow(`[markNfcLinkAppSessionReleasedByTag] failed: ${e?.message ?? e}`))
	} finally {
		await db.end().catch(() => {})
	}
}

/** Master 定时任务：已到 auto_cancel_at 且仍锁定的会话（POST /api/nfcLinkApp 后 5 分钟自动解锁） */
export const listNfcLinkAppSessionsDueForAutoCancel = async (limit: number = 12): Promise<NfcLinkAppSessionDb[]> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureNfcLinkAppSessionsSchema(db)
		const lim = Math.min(Math.max(1, Math.floor(limit)), 50)
		const { rows } = await db.query(
			`SELECT tag_id_hex, uid_hex, counter_hex, payer_eoa, aa_address, redeem_hash_bytes32, chain_tx_hash, link_redeem_plaintext, link_redeem_public, auto_cancel_at, migrate_via_container
			FROM nfc_link_app_sessions
			WHERE released_at IS NULL
			  AND auto_cancel_at IS NOT NULL
			  AND auto_cancel_at <= NOW()
			ORDER BY auto_cancel_at ASC
			LIMIT $1`,
			[lim]
		)
		return (rows as any[]).map((r) => rowToNfcLinkSession(r))
	} catch (e: any) {
		logger(Colors.yellow(`[listNfcLinkAppSessionsDueForAutoCancel] failed: ${e?.message ?? e}`))
		return []
	} finally {
		await db.end().catch(() => {})
	}
}

/** App 完成 Link 后释放会话（校验 tag/uid/counter） */
export const releaseNfcLinkAppSessionIfMatches = async (body: {
	tagid?: string
	uid?: string
	counter?: string | number
}): Promise<{ ok: true } | { ok: false; error: string }> => {
	const tag = String(body.tagid || '').trim().replace(/^0x/i, '').toLowerCase()
	const uid = String(body.uid || '').trim()
	if (!tag || !uid) return { ok: false, error: 'Missing tagid or uid.' }

	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureNfcLinkAppSessionsSchema(db)
		const { rows } = await db.query(
			`SELECT tag_id_hex, uid_hex, counter_hex, payer_eoa, aa_address, redeem_hash_bytes32, chain_tx_hash, link_redeem_plaintext, link_redeem_public, auto_cancel_at, migrate_via_container
			FROM nfc_link_app_sessions WHERE tag_id_hex = $1 AND released_at IS NULL LIMIT 1`,
			[tag]
		)
		if (!rows[0]) return { ok: false, error: 'No active link session for this tag.' }
		const rec = rowToNfcLinkSession(rows[0] as any)
		if (rec.uid.trim().toLowerCase() !== uid.trim().toLowerCase()) return { ok: false, error: 'uid mismatch.' }
		const ctr = body.counter
		const ctrNum = typeof ctr === 'number' && Number.isFinite(ctr) ? ctr : parseInt(String(ctr ?? ''), 10)
		const expected = parseInt(rec.counterHex, 16)
		if (!Number.isFinite(ctrNum) || ctrNum !== expected) return { ok: false, error: 'counter mismatch.' }
		await db.query(
			`UPDATE nfc_link_app_sessions SET released_at = NOW(), auto_cancel_at = NULL WHERE tag_id_hex = $1 AND released_at IS NULL`,
			[tag]
		)
		return { ok: true }
	} catch (e: any) {
		logger(Colors.yellow(`[releaseNfcLinkAppSessionIfMatches] failed: ${e?.message ?? e}`))
		return { ok: false, error: 'Database error.' }
	} finally {
		await db.end().catch(() => {})
	}
}

/** TagID 是否已登记（合法卡） */
export const isTagIdRegistered = async (tagIdHex: string): Promise<boolean> => {
	const addr = await getNfcRecipientAddressByTagId(tagIdHex)
	return addr != null
}

/** 根据 TagID 查找或创建钱包。若已登记则返回 EOA；若未登记则创建新 EOA、登记到 nfc_cards（tag_id 为主键语义）。uidHex 可选，仅兼容旧客户端；缺省时用 tagIdHex 作为 DB uid 列值。 */
export const provisionOrGetNfcWalletByTagId = async (tagIdHex: string, uidHex?: string): Promise<{ eoa: string; wasNewlyProvisioned: boolean }> => {
	const existing = await getNfcRecipientAddressByTagId(tagIdHex)
	if (existing) return { eoa: existing, wasNewlyProvisioned: false }
	const wallet = ethers.Wallet.createRandom()
	await registerNfcCardToDb({
		uid: uidHex?.trim() || tagIdHex.trim(),
		privateKey: wallet.privateKey,
		tagId: tagIdHex
	})
	const after = await getNfcRecipientAddressByTagId(tagIdHex)
	const eoa = after ?? (await wallet.getAddress())
	const wasNewlyProvisioned = true
	logger(Colors.green(`[provisionOrGetNfcWalletByTagId] provisioned EOA ${eoa} for tagId=${tagIdHex.slice(0, 8)}...`))
	return { eoa, wasNewlyProvisioned }
}

/** 根据 UID 获取 NFC 卡对应的 recipient EOA 地址（用于 mintPointsByAdmin 的 to 参数）。若 DB 无则从 mnemonic 派生，不写入 DB。 */
export const getNfcRecipientAddressByUid = async (uid: string): Promise<string | null> => {
	const normalizedUidRow = String(uid || '').trim().toLowerCase()
	if (normalizedUidRow && /^[0-9a-f]+$/i.test(normalizedUidRow)) {
		const db = new Client({ connectionString: DB_URL })
		try {
			await db.connect()
			await ensureNfcCardsExtendedSchema(db)
			const { rows } = await db.query<{ private_key: string | null }>(
				`SELECT private_key FROM nfc_cards WHERE LOWER(TRIM(uid)) = $1 LIMIT 1`,
				[normalizedUidRow]
			)
			if (rows.length > 0) {
				const pk = rows[0].private_key
				if (pk == null || String(pk).trim() === '') return null
				try {
					const w = new ethers.Wallet(String(pk).trim())
					return await w.getAddress()
				} catch {
					return null
				}
			}
		} catch (e: any) {
			logger(Colors.yellow(`[getNfcRecipientAddressByUid] db read: ${e?.message ?? e}`))
		} finally {
			await db.end().catch(() => {})
		}
	}
	let privateKey = await getNfcCardPrivateKeyByUid(uid)
	if (privateKey) {
		try {
			const wallet = new ethers.Wallet(privateKey)
			return await wallet.getAddress()
		} catch {
			return null
		}
	}
	const mnemonic = (masterSetup as any)?.cryptoPayWallet
	if (!mnemonic || typeof mnemonic !== 'string') return null
	const normalizedUid = String(uid || '').trim().toLowerCase()
	if (!/^[0-9a-f]+$/i.test(normalizedUid)) return null
	const uidHex = normalizedUid.padStart(14, '0').slice(-14)
	try {
		const uidBytes = ethers.getBytes('0x' + uidHex)
		const hash = ethers.keccak256(uidBytes)
		const offset = Number(BigInt(hash) % (2n ** 31n))
		const path = `m/44'/60'/0'/0/${offset}`
		const derived = ethers.HDNodeWallet.fromPhrase(mnemonic.trim(), path)
		const wallet = new ethers.Wallet(derived.privateKey)
		return await wallet.getAddress()
	} catch {
		return null
	}
}

/** 登记 NFC 卡到 DB（uid + private_key；tag_id 可选，SUN 解密得到的 TagID，用于合法性校验）。 */
export const registerNfcCardToDb = async (params: { uid: string; privateKey: string; tagId?: string }): Promise<void> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await db.query(NFC_CARDS_TABLE)
		await db.query(NFC_CARDS_ADD_TAG_ID)
		const uid = String(params.uid || '').trim()
		const privateKey = String(params.privateKey || '').trim()
		const tagId = params.tagId ? String(params.tagId).trim().toUpperCase() : null
		if (!uid || !privateKey) return
		if (tagId && tagId.length === 16 && /^[0-9A-F]+$/.test(tagId)) {
			await db.query(
				`INSERT INTO nfc_cards (uid, private_key, tag_id) VALUES ($1, $2, $3)
				ON CONFLICT (uid) DO UPDATE SET
					private_key = CASE WHEN nfc_cards.tag_id IS NULL THEN EXCLUDED.private_key ELSE nfc_cards.private_key END,
					tag_id = COALESCE(nfc_cards.tag_id, EXCLUDED.tag_id)`,
				[uid, privateKey, tagId]
			)
			logger(Colors.green(`[registerNfcCardToDb] registered uid=${uid.slice(0, 16)}... tagId=${tagId.slice(0, 8)}...`))
		} else {
			await db.query(
				`INSERT INTO nfc_cards (uid, private_key) VALUES ($1, $2)
				ON CONFLICT (uid) DO UPDATE SET private_key = EXCLUDED.private_key`,
				[uid, privateKey]
			)
			logger(Colors.green(`[registerNfcCardToDb] registered uid=${uid.slice(0, 16)}...`))
		}
	} catch (e: any) {
		logger(Colors.yellow(`[registerNfcCardToDb] failed: ${e?.message ?? e}`))
	} finally {
		await db.end().catch(() => {})
	}
}

/**
 * Link App 完成后：按 TagID 将 nfc_cards 的私钥替换为用户钱包私钥，并同步 uid（SUN 14 hex）。
 * 先 UPDATE tag_id 命中行；若无行则 INSERT（新卡首次绑定用户密钥）。
 * [linkedOwnerEoa] 写入 linked_owner_eoa，供 listLinkedNfcCards 按 EOA 查询。
 */
export const replaceNfcCardKeyByTagId = async (params: {
	tagIdHex: string
	privateKey: string
	uidHex: string
	linkedOwnerEoa: string
}): Promise<void> => {
	const db = new Client({ connectionString: DB_URL })
	const tagUpper = String(params.tagIdHex || '').trim().replace(/^0x/i, '').toUpperCase()
	const pk = String(params.privateKey || '').trim()
	const uid = String(params.uidHex || '').trim().toLowerCase()
	let ownerEoaLower: string
	try {
		ownerEoaLower = ethers.getAddress(String(params.linkedOwnerEoa || '').trim()).toLowerCase()
	} catch {
		throw new Error('replaceNfcCardKeyByTagId: invalid linkedOwnerEoa')
	}
	if (!tagUpper || tagUpper.length !== 16 || !/^[0-9A-F]+$/.test(tagUpper) || !pk || !uid) {
		throw new Error('replaceNfcCardKeyByTagId: invalid tagIdHex, privateKey, or uidHex')
	}
	try {
		await db.connect()
		await db.query(NFC_CARDS_TABLE)
		await db.query(NFC_CARDS_ADD_TAG_ID)
		await db.query(NFC_CARDS_ADD_LINKED_OWNER)
		await db.query(NFC_CARDS_IDX_LINKED_OWNER)
		await db.query(NFC_CARDS_ADD_LINK_STATE)
		const up = await db.query(
			`UPDATE nfc_cards SET private_key = $1, uid = $2, linked_owner_eoa = $4, nfc_link_state = 'active' WHERE UPPER(TRIM(tag_id)) = $3`,
			[pk, uid, tagUpper, ownerEoaLower]
		)
		if ((up.rowCount ?? 0) > 0) return
		await db.query(
			`INSERT INTO nfc_cards (uid, private_key, tag_id, linked_owner_eoa, nfc_link_state) VALUES ($1, $2, $3, $4, 'active')
			ON CONFLICT (tag_id) DO UPDATE SET
				private_key = EXCLUDED.private_key,
				uid = EXCLUDED.uid,
				linked_owner_eoa = EXCLUDED.linked_owner_eoa,
				nfc_link_state = 'active'`,
			[uid, pk, tagUpper, ownerEoaLower]
		)
	} finally {
		await db.end().catch(() => {})
	}
}

/** 按用户 EOA 列出已通过 Link App 绑定到该钱包的 NFC（返回 uid 14 hex、tagId 16 hex、linkState；不含私钥） */
export const listLinkedNfcCardsByOwnerEoa = async (
	ownerEoa: string
): Promise<{ uid: string; tagId: string; linkState: 'active' | 'deactive' }[]> => {
	let eoaNorm: string
	try {
		eoaNorm = ethers.getAddress(String(ownerEoa || '').trim()).toLowerCase()
	} catch {
		return []
	}
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureNfcCardsExtendedSchema(db)
		const { rows } = await db.query<{ uid: string; tag_id: string; nfc_link_state: string | null }>(
			`SELECT uid, tag_id, nfc_link_state FROM nfc_cards
			 WHERE linked_owner_eoa IS NOT NULL AND LOWER(TRIM(linked_owner_eoa)) = $1
			 AND tag_id IS NOT NULL AND TRIM(tag_id) <> ''
			 AND private_key IS NOT NULL AND TRIM(COALESCE(private_key, '')) <> ''
			 AND COALESCE(NULLIF(LOWER(TRIM(nfc_link_state)), ''), 'active') <> 'removed'
			 ORDER BY id ASC`,
			[eoaNorm]
		)
		return rows.map((r) => ({
			uid: String(r.uid || '').replace(/^0x/i, '').toLowerCase(),
			tagId: String(r.tag_id || '').replace(/^0x/i, '').toUpperCase(),
			linkState: String(r.nfc_link_state || '').trim().toLowerCase() === 'deactive' ? 'deactive' : 'active',
		}))
	} catch (e: any) {
		logger(Colors.yellow(`[listLinkedNfcCardsByOwnerEoa] failed: ${e?.message ?? e}`))
		return []
	} finally {
		await db.end().catch(() => {})
	}
}

export const getBeamioSunLastCounterByUid = async (uid: string): Promise<string | null> => {
	const state = await getBeamioSunLastCounterStateByUid(uid)
	return state?.lastCounterHex ?? null
}

/** 返回 lastCounter 与 updated_at，供 counter 防重放 + 同 tap 短时 grace 使用 */
export const getBeamioSunLastCounterStateByUid = async (uid: string): Promise<{ lastCounterHex: string; updatedAt: Date } | null> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await db.query(BEAMIO_SUN_COUNTER_STATE_TABLE)
		const normalizedUid = String(uid || '').trim().toLowerCase()
		if (!normalizedUid) return null
		const { rows } = await db.query<{ last_counter: string; updated_at: Date }>(
			`SELECT last_counter, updated_at FROM beamio_sun_counter_state WHERE LOWER(uid) = $1 LIMIT 1`,
			[normalizedUid]
		)
		const r = rows[0]
		if (!r?.last_counter) return null
		return {
			lastCounterHex: String(r.last_counter).trim().toUpperCase(),
			updatedAt: r.updated_at
		}
	} catch (e: any) {
		logger(Colors.yellow(`[getBeamioSunLastCounterStateByUid] failed: ${e?.message ?? e}`))
		return null
	} finally {
		await db.end().catch(() => {})
	}
}

export const upsertBeamioSunLastCounterByUid = async (params: {
	uid: string
	lastCounterHex: string
}): Promise<void> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await db.query(BEAMIO_SUN_COUNTER_STATE_TABLE)
		const uid = String(params.uid || '').trim().toLowerCase()
		const lastCounterHex = String(params.lastCounterHex || '').trim().toUpperCase()
		if (!uid || !lastCounterHex) return
		await db.query(
			`
			INSERT INTO beamio_sun_counter_state (uid, last_counter, updated_at)
			VALUES ($1, $2, NOW())
			ON CONFLICT (uid) DO UPDATE SET
				last_counter = EXCLUDED.last_counter,
				updated_at = NOW()
			`,
			[uid, lastCounterHex]
		)
	} catch (e: any) {
		logger(Colors.yellow(`[upsertBeamioSunLastCounterByUid] failed: ${e?.message ?? e}`))
	} finally {
		await db.end().catch(() => {})
	}
}

/** Deep-merge metadata_json patch into an existing beamio_cards row (shareTokenMetadata shallow-merged). */
export function mergeBeamioCardMetadataJsonPatch(
	existing: Record<string, unknown> | null | undefined,
	patch: Record<string, unknown>
): Record<string, unknown> {
	const base =
		existing != null && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {}
	const patchShare =
		patch.shareTokenMetadata != null &&
		typeof patch.shareTokenMetadata === 'object' &&
		!Array.isArray(patch.shareTokenMetadata)
			? (patch.shareTokenMetadata as Record<string, unknown>)
			: null
	const baseShare =
		base.shareTokenMetadata != null &&
		typeof base.shareTokenMetadata === 'object' &&
		!Array.isArray(base.shareTokenMetadata)
			? (base.shareTokenMetadata as Record<string, unknown>)
			: {}
	const merged: Record<string, unknown> = { ...base, ...patch }
	if (patchShare || Object.keys(baseShare).length > 0) {
		merged.shareTokenMetadata = { ...baseShare, ...(patchShare ?? {}) }
	}
	if (patch.tiers === undefined && base.tiers !== undefined) merged.tiers = base.tiers
	if (patch.upgradeType === undefined && base.upgradeType !== undefined) {
		merged.upgradeType = base.upgradeType
	}
	if (patch.transferWhitelistEnabled === undefined && base.transferWhitelistEnabled !== undefined) {
		merged.transferWhitelistEnabled = base.transferWhitelistEnabled
	}
	return merged
}

/** createCard 成功后登记到本地 DB */
export const registerCardToDb = async (params: {
	cardAddress: string
	cardOwner: string
	currency: string
	priceInCurrencyE6: string
	uri?: string
	/** Persisted into metadata_json for full createCard audit */
	upgradeType?: 0 | 1 | 2
	transferWhitelistEnabled?: boolean
	shareTokenMetadata?: {
		name?: string
		description?: string
		image?: string
		merchantImage?: string
		categories?: string[]
		Symbol?: string
		displayName?: string
		backgroundColor?: string
		minimumTopup?: number
		maximumTopup?: number
		logoDisplayTier?: number
		bonusRule?: { paymentAmount: number; bonusValue: number; bonusProportional?: boolean }
		bonusRules?: Array<{ paymentAmount: number; bonusValue: number; bonusProportional?: boolean }>
		pointSystem?: {
			enabled: boolean
			chargeRewardRatioE6?: string
			rewardTokenId?: number
		}
	}
	tiers?: Array<{
		index: number
		minUsdc6: string
		attr: number
		tierExpirySeconds?: number
		name?: string
		description?: string
		image?: string
		backgroundColor?: string
		upgradeByBalance?: boolean
	}>
	txHash?: string
}): Promise<void> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await db.query(BEAMIO_CARDS_TABLE)
		const addrLower = params.cardAddress.toLowerCase()
		const existingRes = await db.query<{ metadata_json: Record<string, unknown> | null }>(
			`SELECT metadata_json FROM beamio_cards WHERE card_address = $1 LIMIT 1`,
			[addrLower]
		)
		const existingMeta = existingRes.rows[0]?.metadata_json ?? null
		const patchJson: Record<string, unknown> = {
			...(params.shareTokenMetadata && { shareTokenMetadata: params.shareTokenMetadata }),
			...(params.tiers && params.tiers.length > 0 && { tiers: params.tiers }),
			...(params.upgradeType != null && { upgradeType: params.upgradeType }),
			...(typeof params.transferWhitelistEnabled === 'boolean' && {
				transferWhitelistEnabled: params.transferWhitelistEnabled,
			}),
		}
		const mergedMetadata = mergeBeamioCardMetadataJsonPatch(existingMeta, patchJson)
		const metadataJson =
			Object.keys(mergedMetadata).length > 0 ? JSON.stringify(mergedMetadata) : null
		await db.query(
			`
			INSERT INTO beamio_cards (card_address, card_owner, currency, price_in_currency_e6, uri, metadata_json, tx_hash)
			VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
			ON CONFLICT (card_address) DO UPDATE SET
				card_owner = EXCLUDED.card_owner,
				currency = EXCLUDED.currency,
				price_in_currency_e6 = EXCLUDED.price_in_currency_e6,
				uri = EXCLUDED.uri,
				metadata_json = EXCLUDED.metadata_json,
				tx_hash = EXCLUDED.tx_hash
			`,
			[
				addrLower,
				params.cardOwner.toLowerCase(),
				params.currency,
				params.priceInCurrencyE6,
				params.uri ?? null,
				metadataJson,
				params.txHash ?? null,
			]
		)
		const cats = params.shareTokenMetadata?.categories
		if (Array.isArray(cats) && cats.length > 0) {
			logger(
				Colors.green(
					`[registerCardToDb] registered card=${params.cardAddress} categories=${cats.filter((c) => typeof c === 'string' && c.trim()).join(',')}`
				)
			)
		} else {
			logger(Colors.green(`[registerCardToDb] registered card=${params.cardAddress}`))
		}
	} catch (e: any) {
		logger(Colors.yellow(`[registerCardToDb] failed: ${e?.message ?? e}`))
		throw e
	} finally {
		await db.end().catch(() => {})
	}
}

/** 供 metadata 热更新：读取 beamio_cards 登记行（不写链，只同步 JSON + metadata_json）。 */
export const getBeamioCardRowForMetadataSync = async (
	cardAddress: string
): Promise<{
	cardOwner: string
	currency: string
	priceInCurrencyE6: string
	uri: string | null
	txHash: string | null
} | null> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await db.query(BEAMIO_CARDS_TABLE)
		const addr = cardAddress.toLowerCase()
		const { rows } = await db.query<{
			card_owner: string
			currency: string
			price_in_currency_e6: string
			uri: string | null
			tx_hash: string | null
		}>(
			`SELECT card_owner, currency, price_in_currency_e6, uri, tx_hash FROM beamio_cards WHERE card_address = $1 LIMIT 1`,
			[addr]
		)
		if (rows.length === 0) return null
		const r = rows[0]
		return {
			cardOwner: r.card_owner as string,
			currency: r.currency as string,
			priceInCurrencyE6: String(r.price_in_currency_e6 ?? ''),
			uri: r.uri ?? null,
			txHash: r.tx_hash ?? null,
		}
	} catch (e: any) {
		logger(Colors.yellow(`[getBeamioCardRowForMetadataSync] failed: ${e?.message ?? e}`))
		return null
	} finally {
		await db.end().catch(() => {})
	}
}

/** 已登记发卡（beamio_cards）的去重 owner EOA 小写列表，供 Cluster 过滤「发卡方」身份。 */
export const getDistinctBeamioCardOwnerAddressesLower = async (): Promise<string[]> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await db.query(BEAMIO_CARDS_TABLE)
		const { rows } = await db.query<{ card_owner: string }>(
			`
			SELECT DISTINCT LOWER(TRIM(card_owner)) AS card_owner
			FROM beamio_cards
			WHERE card_owner IS NOT NULL AND TRIM(card_owner) <> ''
			`
		)
		return rows.map((r) => r.card_owner).filter((x) => typeof x === "string" && x.startsWith("0x"))
	} catch (e: any) {
		logger(Colors.yellow(`[getDistinctBeamioCardOwnerAddressesLower] failed: ${e?.message ?? e}`))
		return []
	} finally {
		await db.end().catch(() => {})
	}
}

/** 读取当前 DB 已登记的全部 BeamioUserCard 地址，用于 API 资产查询按用户过滤实际持有卡。 */
export const listRegisteredBeamioUserCardAddresses = async (limit = 5000): Promise<string[]> => {
	const cap = Math.min(Math.max(Math.trunc(limit), 1), 10000)
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await db.query(BEAMIO_CARDS_TABLE)
		const { rows } = await db.query<{ card_address: string }>(
			`
			SELECT card_address
			FROM beamio_cards
			WHERE card_address IS NOT NULL AND TRIM(card_address) <> ''
			ORDER BY created_at DESC
			LIMIT $1
			`,
			[cap]
		)
		const out: string[] = []
		const seen = new Set<string>()
		for (const r of rows) {
			try {
				const addr = ethers.getAddress(String(r.card_address || '').trim())
				const lower = addr.toLowerCase()
				if (seen.has(lower)) continue
				seen.add(lower)
				out.push(addr)
			} catch {
				/* ignore malformed DB row */
			}
		}
		return out
	} catch (e: any) {
		logger(Colors.yellow(`[listRegisteredBeamioUserCardAddresses] failed: ${e?.message ?? e}`))
		return []
	} finally {
		await db.end().catch(() => {})
	}
}

/** 按 card_address 查单张卡的 card_owner + metadata_json。供 Cluster GET /api/cardMetadata 用，前端 beamioApi 拉取。 */
export const getCardByAddress = async (cardAddress: string): Promise<{ cardOwner: string; metadata: Record<string, unknown> | null } | null> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		const addr = cardAddress.toLowerCase()
		logger(Colors.cyan(`[getCardByAddress] SELECT WHERE card_address = '${addr}'`))
		const { rows } = await db.query(
			`SELECT card_owner, metadata_json FROM beamio_cards WHERE card_address = $1 LIMIT 1`,
			[addr]
		)
		logger(Colors.cyan(`[getCardByAddress] rows=${rows.length}`))
		if (rows.length === 0) {
			// debug: 查表里是否有任意记录，以及 card_address 的格式
			const countResult = await db.query(`SELECT COUNT(*) as c FROM beamio_cards`)
			const sampleResult = await db.query(`SELECT card_address FROM beamio_cards LIMIT 3`)
			logger(Colors.yellow(`[getCardByAddress] beamio_cards total rows=${(countResult.rows[0] as any)?.c ?? '?'}, sample card_addresses: ${JSON.stringify((sampleResult.rows as any[])?.map((r: any) => r?.card_address) ?? [])}`))
			return null
		}
		return {
			cardOwner: rows[0].card_owner as string,
			metadata: rows[0].metadata_json as Record<string, unknown> | null ?? null,
		}
	} catch (e: any) {
		logger(Colors.yellow(`[getCardByAddress] failed: ${e?.message ?? e}`))
		return null
	} finally {
		await db.end().catch(() => {})
	}
}

/** beamio_cards.created_at for Discover merchant visibility (Featured Brands / coupon APIs). */
export const getCardCreatedAtByAddress = async (cardAddress: string): Promise<string | null> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		const addr = cardAddress.toLowerCase()
		const { rows } = await db.query(
			`SELECT created_at FROM beamio_cards WHERE card_address = $1 LIMIT 1`,
			[addr]
		)
		if (rows.length === 0) return null
		const createdAt = rows[0].created_at
		return createdAt instanceof Date ? createdAt.toISOString() : createdAt != null ? String(createdAt) : null
	} catch {
		return null
	} finally {
		await db.end().catch(() => {})
	}
}

/** 写入或更新单张成员 NFT 的 tier metadata（card_owner + token_id 唯一）。由 mint/redeem 成功后 sync 调用。 */
export const upsertNftTierMetadata = async (params: {
	cardAddress: string
	cardOwner: string
	tokenId: number | bigint
	metadataJson: Record<string, unknown>
}): Promise<void> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await db.query(BEAMIO_NFT_TIER_METADATA_TABLE)
		const tokenIdNum = Number(params.tokenId)
		await db.query(
			`
			INSERT INTO beamio_nft_tier_metadata (card_owner, token_id, card_address, metadata_json)
			VALUES ($1, $2, $3, $4::jsonb)
			ON CONFLICT (card_owner, token_id) DO UPDATE SET
				card_address = EXCLUDED.card_address,
				metadata_json = EXCLUDED.metadata_json
			`,
			[params.cardOwner.toLowerCase(), tokenIdNum, params.cardAddress.toLowerCase(), JSON.stringify(params.metadataJson)]
		)
		logger(Colors.cyan(`[upsertNftTierMetadata] card_owner=${params.cardOwner} token_id=${tokenIdNum}`))
		logger(Colors.gray(`[upsertNftTierMetadata] metadata_json: ${JSON.stringify(params.metadataJson, null, 2)}`))
	} catch (e: any) {
		logger(Colors.yellow(`[upsertNftTierMetadata] failed: ${e?.message ?? e}`))
	} finally {
		await db.end().catch(() => {})
	}
}

/** 按 0x{owner}{NFT#}.json 的 owner 与 tokenId 查询该 NFT 的 tier metadata。Cluster GET /metadata/0x{owner}{NFT#}.json 用。 */
export const getNftTierMetadataByOwnerAndToken = async (cardOwner: string, tokenId: number | bigint): Promise<Record<string, unknown> | null> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		const normalized = cardOwner.toLowerCase().startsWith('0x') ? cardOwner.toLowerCase() : '0x' + cardOwner.toLowerCase()
		const tokenIdNum = Number(tokenId)
		const { rows } = await db.query<{ metadata_json: unknown }>(
			`SELECT metadata_json FROM beamio_nft_tier_metadata WHERE card_owner = $1 AND token_id = $2 LIMIT 1`,
			[normalized, tokenIdNum]
		)
		if (rows.length === 0 || rows[0].metadata_json == null) return null
		return rows[0].metadata_json as Record<string, unknown>
	} catch (e: any) {
		logger(Colors.yellow(`[getNftTierMetadataByOwnerAndToken] failed: ${e?.message ?? e}`))
		return null
	} finally {
		await db.end().catch(() => {})
	}
}

/** 会员档 NFT tokenId 区间（与 BeamioERC1155Logic 一致）。 */
export const BEAMIO_MEMBERSHIP_NFT_START_ID = 100
export const BEAMIO_ISSUED_NFT_START_ID = 100_000_000_000

/** 已登记在 DB 的会员档 tokenId（供 Blockscout 批量 refetch）。 */
export const listMembershipNftTierTokenIdsByCard = async (cardAddress: string): Promise<number[]> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		const normalized = cardAddress.toLowerCase().startsWith('0x')
			? cardAddress.toLowerCase()
			: '0x' + cardAddress.toLowerCase()
		const { rows } = await db.query<{ token_id: number }>(
			`SELECT token_id FROM beamio_nft_tier_metadata
			 WHERE card_address = $1 AND token_id >= $2 AND token_id < $3
			 ORDER BY token_id ASC`,
			[normalized, BEAMIO_MEMBERSHIP_NFT_START_ID, BEAMIO_ISSUED_NFT_START_ID]
		)
		return rows.map((r) => Number(r.token_id)).filter((n) => Number.isFinite(n))
	} catch (e: unknown) {
		logger(
			Colors.yellow(
				`[listMembershipNftTierTokenIdsByCard] failed: ${e instanceof Error ? e.message : e}`
			)
		)
		return []
	} finally {
		await db.end().catch(() => {})
	}
}

/** 按 ERC-1155 合约地址 + tokenId 查询该 NFT 的 tier metadata。GET /metadata/0x{cardAddress}{tokenId}.json 用，符合 Base Explorer / EIP-1155 约定（40hex 为合约地址）。 */
export const getNftTierMetadataByCardAndToken = async (cardAddress: string, tokenId: number | bigint): Promise<Record<string, unknown> | null> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		const normalized = cardAddress.toLowerCase().startsWith('0x') ? cardAddress.toLowerCase() : '0x' + cardAddress.toLowerCase()
		const tokenIdNum = Number(tokenId)
		const { rows } = await db.query<{ metadata_json: unknown }>(
			`SELECT metadata_json FROM beamio_nft_tier_metadata WHERE card_address = $1 AND token_id = $2 LIMIT 1`,
			[normalized, tokenIdNum]
		)
		if (rows.length === 0 || rows[0].metadata_json == null) {
			logger(Colors.yellow(`[getNftTierMetadataByCardAndToken] card_address=${normalized} token_id=${tokenIdNum} rows=${rows.length} metadata_json=${rows[0]?.metadata_json == null ? 'null' : typeof rows[0]?.metadata_json}`))
			return null
		}
		const out = rows[0].metadata_json as Record<string, unknown>
		logger(Colors.cyan(`[getNftTierMetadataByCardAndToken] card_address=${normalized} token_id=${tokenIdNum} 查到 metadata 键: ${Object.keys(out || {}).join(',') || '(空对象)'}`))
		return out
	} catch (e: any) {
		logger(Colors.yellow(`[getNftTierMetadataByCardAndToken] failed: ${e?.message ?? e}`))
		return null
	} finally {
		await db.end().catch(() => {})
	}
}

/** 与 getLatestCards 单行结构一致，供分类聚合等接口复用 */
export type BeamioLatestCardItem = {
	cardAddress: string
	cardOwner: string
	currency: string
	priceInCurrencyE6: string
	uri: string | null
	metadata: Record<string, unknown> | null
	txHash: string | null
	/** DB / 索引维护的 points mint 累计（6 位精度），可能与链上不同步 */
	totalPointsMinted6: string
	holderCount: number
	createdAt: string
	/**
	 * 链上 ERC-1155 `totalSupply(0)`：token #0（points）当前总流通量（已 mint − 已 burn），6 位精度整数字符串。
	 * 由 Master latestCards enrichment 写入。
	 */
	token0TotalSupply6?: string
	/**
	 * 链上 `getGlobalStatsFull` 的 `cumulativeMint`：合约统计窗口内 token #0 累计 mint 量（6 位精度），见 BeamioUserCard readme。
	 * 与 `totalSupply` 不同：后者为当前存量，此为统计口径累计 mint。
	 */
	token0CumulativeMint6?: string
}

const mapBeamioCardSqlRow = (r: {
	card_address: string
	card_owner: string
	currency: string
	price_in_currency_e6: string
	uri: string | null
	metadata_json: unknown
	tx_hash: string | null
	total_points_minted_6: unknown
	holder_count: unknown
	created_at: Date | string
}): BeamioLatestCardItem => ({
	cardAddress: r.card_address,
	cardOwner: r.card_owner,
	currency: r.currency,
	priceInCurrencyE6: r.price_in_currency_e6,
	uri: r.uri,
	metadata: (r.metadata_json && typeof r.metadata_json === 'object') ? (r.metadata_json as Record<string, unknown>) : null,
	txHash: r.tx_hash,
	totalPointsMinted6: String(r.total_points_minted_6 ?? 0),
	holderCount: Number(r.holder_count ?? 0),
	createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
})

/** 最新发行的前 N 张卡明细 */
export const getLatestCards = async (limit = 20): Promise<BeamioLatestCardItem[]> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		const { rows } = await db.query(
			`
			SELECT card_address, card_owner, currency, price_in_currency_e6, uri, metadata_json, tx_hash, total_points_minted_6, holder_count, created_at
			FROM beamio_cards
			ORDER BY created_at DESC
			LIMIT $1
			`,
			[limit]
		)
		return (rows as any[]).map(mapBeamioCardSqlRow)
	} catch (e: any) {
		logger(Colors.yellow(`[getLatestCards] failed: ${e?.message ?? e}`))
		return []
	} finally {
		await db.end().catch(() => {})
	}
}

/**
 * 从 beamio_cards 拉取「含 shareTokenMetadata.categories 非空」的最近若干张卡（按 created_at 降序）。
 * createCard → registerCardToDb 已将 categories 写入 metadata_json，用于分类登记与聚合。
 */
export const getRecentCategorizedBeamioCards = async (limit = 800): Promise<BeamioLatestCardItem[]> => {
	const cap = Math.min(Math.max(limit, 1), 3000)
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await db.query(BEAMIO_CARDS_TABLE)
		const { rows } = await db.query(
			`
			SELECT card_address, card_owner, currency, price_in_currency_e6, uri, metadata_json, tx_hash, total_points_minted_6, holder_count, created_at
			FROM beamio_cards
			WHERE jsonb_typeof(COALESCE(metadata_json->'shareTokenMetadata'->'categories', '[]'::jsonb)) = 'array'
			  AND jsonb_array_length(COALESCE(metadata_json->'shareTokenMetadata'->'categories', '[]'::jsonb)) > 0
			ORDER BY created_at DESC
			LIMIT $1
			`,
			[cap]
		)
		return (rows as any[]).map(mapBeamioCardSqlRow)
	} catch (e: any) {
		logger(Colors.yellow(`[getRecentCategorizedBeamioCards] failed: ${e?.message ?? e}`))
		return []
	} finally {
		await db.end().catch(() => {})
	}
}

/**
 * 按 categoryId 聚合发卡：每张卡可出现在多个 category（metadata 中多个 id）。
 * `scanLimit`：最多扫描多少张「已带 categories」的最近发卡；`limitPerCategory`：每个 category 最多返回几张卡（仍按 created_at 全局顺序填充）。
 */
export const getLatestCardsGroupedByCategory = async (options?: {
	scanLimit?: number
	limitPerCategory?: number
}): Promise<Array<{ categoryId: string; items: BeamioLatestCardItem[] }>> => {
	const scanLimit = Math.min(Math.max(options?.scanLimit ?? 800, 1), 3000)
	const limitPerCategory = Math.min(Math.max(options?.limitPerCategory ?? 80, 1), 500)
	const flat = await getRecentCategorizedBeamioCards(scanLimit)
	const byCat = new Map<string, BeamioLatestCardItem[]>()
	const seenInCat = new Map<string, Set<string>>()
	for (const card of flat) {
		const meta = card.metadata
		const stm = meta && typeof meta.shareTokenMetadata === 'object' ? (meta.shareTokenMetadata as Record<string, unknown>) : null
		const raw = stm?.categories
		const cats =
			Array.isArray(raw) ?
				(raw as unknown[])
					.filter((c): c is string => typeof c === 'string' && c.trim() !== '')
					.map((c) => c.trim())
					.slice(0, 32)
			:	[]
		for (const cat of cats) {
			if (!byCat.has(cat)) {
				byCat.set(cat, [])
				seenInCat.set(cat, new Set())
			}
			const set = seenInCat.get(cat)!
			const lo = card.cardAddress.toLowerCase()
			if (set.has(lo)) continue
			set.add(lo)
			const arr = byCat.get(cat)!
			if (arr.length < limitPerCategory) {
				arr.push(card)
			}
		}
	}
	return Array.from(byCat.entries())
		.map(([categoryId, items]) => ({ categoryId, items }))
		.sort((a, b) => a.categoryId.localeCompare(b.categoryId))
}

/** 登记 issued NFT 系列到 DB（createIssuedNft 成功后由 API/daemon 调用）；metadataJson 为通用型 JSON，支持电影/演唱会/商品等场景；ipfsCid 可选，无 IPFS 时用 metadataJson 作为 shared metadata */
export const registerSeriesToDb = async (params: {
	cardAddress: string
	tokenId: string
	sharedMetadataHash: string
	ipfsCid?: string | null
	cardOwner: string
	metadataJson?: Record<string, unknown>
}): Promise<void> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await db.query(BEAMIO_NFT_SERIES_TABLE)
		const meta =
			params.metadataJson != null
				? JSON.stringify(
						seriesMetadataLooksLikeProduction(params.metadataJson)
							? normalizeProductionSeriesMetadataJson(params.metadataJson)
							: normalizeCouponSeriesMetadataJson(params.metadataJson)
					)
				: null
		const ipfsCidVal = (params.ipfsCid != null && String(params.ipfsCid).trim() !== '') ? String(params.ipfsCid).trim() : ''
		await db.query(
			`
			INSERT INTO beamio_nft_series (card_address, token_id, shared_metadata_hash, ipfs_cid, card_owner, metadata_json)
			VALUES ($1, $2, $3, $4, $5, $6::jsonb)
			ON CONFLICT (card_address, token_id) DO UPDATE SET
				shared_metadata_hash = EXCLUDED.shared_metadata_hash,
				ipfs_cid = EXCLUDED.ipfs_cid,
				card_owner = EXCLUDED.card_owner,
				metadata_json = COALESCE(EXCLUDED.metadata_json, beamio_nft_series.metadata_json)
			`,
			[
				params.cardAddress.toLowerCase(),
				params.tokenId,
				params.sharedMetadataHash,
				ipfsCidVal,
				params.cardOwner.toLowerCase(),
				meta,
			]
		)
		logger(Colors.green(`[registerSeriesToDb] registered series card=${params.cardAddress} tokenId=${params.tokenId}`))
	} catch (e: any) {
		logger(Colors.yellow(`[registerSeriesToDb] failed: ${e?.message ?? e}`))
	} finally {
		await db.end().catch(() => {})
	}
}

/** 更新已登记 issued NFT 系列 metadata_json（保留 shared_metadata_hash / ipfs_cid / card_owner）。 */
export const updateSeriesMetadataByCardAndToken = async (params: {
	cardAddress: string
	tokenId: string
	metadataJson: Record<string, unknown>
}): Promise<boolean> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await db.query(BEAMIO_NFT_SERIES_TABLE)
		const meta = JSON.stringify(
			seriesMetadataLooksLikeProduction(params.metadataJson)
				? normalizeProductionSeriesMetadataJson(params.metadataJson)
				: normalizeCouponSeriesMetadataJson(params.metadataJson)
		)
		const { rowCount } = await db.query(
			`
			UPDATE beamio_nft_series
			SET metadata_json = $3::jsonb
			WHERE card_address = $1 AND token_id = $2
			`,
			[params.cardAddress.toLowerCase(), params.tokenId, meta]
		)
		return (rowCount ?? 0) > 0
	} catch (e: any) {
		logger(Colors.yellow(`[updateSeriesMetadataByCardAndToken] failed: ${e?.message ?? e}`))
		return false
	} finally {
		await db.end().catch(() => {})
	}
}

/** 登记单笔 mint 的通用型 metadata（购买/铸造时调用；metadataJson 任意结构，如 { seat: "A12" }、{ serialNo: "SN-001" }） */
export const registerMintMetadataToDb = async (params: {
	cardAddress: string
	tokenId: string
	ownerAddress: string
	txHash?: string
	metadataJson: Record<string, unknown>
}): Promise<void> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await db.query(BEAMIO_NFT_MINT_METADATA_TABLE)
		const meta = JSON.stringify(params.metadataJson)
		await db.query(
			`
			INSERT INTO beamio_nft_mint_metadata (card_address, token_id, owner_address, tx_hash, metadata_json)
			VALUES ($1, $2, $3, $4, $5::jsonb)
			`,
			[
				params.cardAddress.toLowerCase(),
				params.tokenId,
				params.ownerAddress.toLowerCase(),
				params.txHash ?? null,
				meta,
			]
		)
		logger(Colors.green(`[registerMintMetadataToDb] card=${params.cardAddress} tokenId=${params.tokenId} owner=${params.ownerAddress}`))
	} catch (e: any) {
		logger(Colors.yellow(`[registerMintMetadataToDb] failed: ${e?.message ?? e}`))
	} finally {
		await db.end().catch(() => {})
	}
}

/** owner 钱包所有的 NFT 系列列表 */
export const getOwnerNftSeries = async (owner: string, limit = 100): Promise<Array<{
	cardAddress: string
	tokenId: string
	sharedMetadataHash: string
	ipfsCid: string
	cardOwner: string
	metadata: Record<string, unknown> | null
	createdAt: string
}>> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await db.query(BEAMIO_NFT_SERIES_TABLE)
		const { rows } = await db.query(
			`
			SELECT card_address, token_id, shared_metadata_hash, ipfs_cid, card_owner, metadata_json, created_at
			FROM beamio_nft_series
			WHERE card_owner = $1
			ORDER BY created_at DESC
			LIMIT $2
			`,
			[owner.toLowerCase(), limit]
		)
		return rows.map((r: any) => ({
			cardAddress: r.card_address,
			tokenId: r.token_id,
			sharedMetadataHash: r.shared_metadata_hash,
			ipfsCid: r.ipfs_cid,
			cardOwner: r.card_owner,
			metadata: r.metadata_json,
			createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
		}))
	} catch (e: any) {
		logger(Colors.yellow(`[getOwnerNftSeries] failed: ${e?.message ?? e}`))
		return []
	} finally {
		await db.end().catch(() => {})
	}
}

const ISSUED_NFT_START_ID_SERIES_FILTER = '100000000000'

/** SQL predicate: beamio_nft_series row is a Program coupon issued series (category Coupon + legacy markers). */
const COUPON_ISSUED_SERIES_METADATA_WHERE = `
(
	(metadata_json->>'category') = 'Coupon'
	OR (
		metadata_json ? 'properties'
		AND (metadata_json->'properties'->>'category') = 'Coupon'
	)
	OR (
		(
			NOT (metadata_json ? 'category')
			OR BTRIM(COALESCE(metadata_json->>'category', '')) = ''
		)
		AND (
			NOT (metadata_json ? 'properties')
			OR NOT ((metadata_json->'properties') ? 'category')
			OR BTRIM(COALESCE(metadata_json->'properties'->>'category', '')) = ''
		)
		AND (
			(metadata_json ? 'couponId')
			OR (
				metadata_json ? 'properties'
				AND ((metadata_json->'properties') ? 'beamioCoupon')
			)
		)
	)
)
AND (
	NOT (metadata_json ? 'category')
	OR (metadata_json->>'category') = 'Coupon'
)
AND (
	NOT (metadata_json ? 'properties')
	OR NOT ((metadata_json->'properties') ? 'category')
	OR (metadata_json->'properties'->>'category') = 'Coupon'
)
`

/** 全站最近登记的 Program 优惠券 issued-NFT 系列：metadata 含 category=Coupon、根级 couponId 或 properties.beamioCoupon；按 created_at 倒序（与 registerSeriesToDb 入库时间一致）。 */
export const listRecentBeamioIssuedCouponSeries = async (
	limit = 20
): Promise<Array<{
	cardAddress: string
	tokenId: string
	sharedMetadataHash: string
	ipfsCid: string
	cardOwner: string
	metadata: Record<string, unknown> | null
	createdAt: string
}>> => {
	const lim = Number.isFinite(limit) ? Math.floor(Number(limit)) : 20
	const cap = Math.min(Math.max(lim, 1), 100)
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await db.query(BEAMIO_NFT_SERIES_TABLE)
		const { rows } = await db.query(
			`
			SELECT card_address, token_id, shared_metadata_hash, ipfs_cid, card_owner, metadata_json, created_at
			FROM beamio_nft_series
			WHERE metadata_json IS NOT NULL
			AND ${COUPON_ISSUED_SERIES_METADATA_WHERE}
			AND token_id ~ '^[0-9]+$'
			AND LENGTH(token_id) <= 40
			AND (token_id::bigint >= $2::bigint)
			ORDER BY created_at DESC NULLS LAST
			LIMIT $1
			`,
			[cap, ISSUED_NFT_START_ID_SERIES_FILTER]
		)
		return filterClientCouponSeriesRows(
			rows.map((r: any) => ({
				cardAddress: r.card_address,
				tokenId: r.token_id,
				sharedMetadataHash: r.shared_metadata_hash,
				ipfsCid: r.ipfs_cid,
				cardOwner: r.card_owner,
				metadata: r.metadata_json,
				createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
			}))
		)
	} catch (e: any) {
		logger(Colors.yellow(`[listRecentBeamioIssuedCouponSeries] failed: ${e?.message ?? e}`))
		return []
	} finally {
		await db.end().catch(() => {})
	}
}

/** 指定卡下登记的 Program 优惠券 issued 系列（与 listRecentBeamioIssuedCouponSeries 同 coupon 语义），按 created_at 倒序；供链上 `isIssuedNftValid` 过滤前取候选集。 */
export const listCouponIssuedNftSeriesForCardDescending = async (
	cardAddress: string,
	scanLimit = 200
): Promise<Array<{
	cardAddress: string
	tokenId: string
	sharedMetadataHash: string
	ipfsCid: string
	cardOwner: string
	metadata: Record<string, unknown> | null
	createdAt: string
}>> => {
	const lim = Number.isFinite(scanLimit) ? Math.floor(Number(scanLimit)) : 200
	const cap = Math.min(Math.max(lim, 1), 500)
	const cardLower = cardAddress.toLowerCase()
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await db.query(BEAMIO_NFT_SERIES_TABLE)
		const { rows } = await db.query(
			`
			SELECT card_address, token_id, shared_metadata_hash, ipfs_cid, card_owner, metadata_json, created_at
			FROM beamio_nft_series
			WHERE card_address = $1
			AND metadata_json IS NOT NULL
			AND ${COUPON_ISSUED_SERIES_METADATA_WHERE}
			AND token_id ~ '^[0-9]+$'
			AND LENGTH(token_id) <= 40
			AND (token_id::bigint >= $3::bigint)
			ORDER BY created_at DESC NULLS LAST
			LIMIT $2
			`,
			[cardLower, cap, ISSUED_NFT_START_ID_SERIES_FILTER]
		)
		return filterClientCouponSeriesRows(
			rows.map((r: any) => ({
				cardAddress: r.card_address,
				tokenId: r.token_id,
				sharedMetadataHash: r.shared_metadata_hash,
				ipfsCid: r.ipfs_cid,
				cardOwner: r.card_owner,
				metadata: r.metadata_json,
				createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
			}))
		)
	} catch (e: any) {
		logger(Colors.yellow(`[listCouponIssuedNftSeriesForCardDescending] failed: ${e?.message ?? e}`))
		return []
	} finally {
		await db.end().catch(() => {})
	}
}

/** SQL predicate: beamio_nft_series row is a Program productions / service catalog issued series. */
const PRODUCTION_ISSUED_SERIES_METADATA_WHERE = `
(
	(metadata_json->>'category') IN ('Product', 'Service', 'Menu', 'ShareLink', 'SalesManagement', 'productions')
	OR (
		metadata_json ? 'properties'
		AND (
			(metadata_json->'properties'->>'category') IN ('Product', 'Service', 'Menu', 'ShareLink', 'SalesManagement', 'productions')
			OR (metadata_json->'properties') ? 'beamioProduction'
		)
	)
	OR (metadata_json ? 'productionId')
)
AND (
	NOT (metadata_json ? 'category')
	OR (metadata_json->>'category') IN ('Product', 'Service', 'Menu', 'ShareLink', 'SalesManagement', 'productions')
)
AND (
	NOT (metadata_json ? 'properties')
	OR NOT ((metadata_json->'properties') ? 'category')
	OR (metadata_json->'properties'->>'category') IN ('Product', 'Service', 'Menu', 'ShareLink', 'SalesManagement', 'productions')
)
`

/** 指定卡下登记的 Program productions issued 系列，按 created_at 倒序。 */
export const listProductionIssuedNftSeriesForCardDescending = async (
	cardAddress: string,
	scanLimit = 200
): Promise<Array<{
	cardAddress: string
	tokenId: string
	sharedMetadataHash: string
	ipfsCid: string
	cardOwner: string
	metadata: Record<string, unknown> | null
	createdAt: string
}>> => {
	const lim = Number.isFinite(scanLimit) ? Math.floor(Number(scanLimit)) : 200
	const cap = Math.min(Math.max(lim, 1), 500)
	const cardLower = cardAddress.toLowerCase()
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await db.query(BEAMIO_NFT_SERIES_TABLE)
		const { rows } = await db.query(
			`
			SELECT card_address, token_id, shared_metadata_hash, ipfs_cid, card_owner, metadata_json, created_at
			FROM beamio_nft_series
			WHERE card_address = $1
			AND metadata_json IS NOT NULL
			AND ${PRODUCTION_ISSUED_SERIES_METADATA_WHERE}
			AND token_id ~ '^[0-9]+$'
			AND LENGTH(token_id) <= 40
			AND (token_id::bigint >= $3::bigint)
			ORDER BY created_at DESC NULLS LAST
			LIMIT $2
			`,
			[cardLower, cap, ISSUED_NFT_START_ID_SERIES_FILTER]
		)
		return filterClientProductionSeriesRows(
			rows.map((r: any) => ({
				cardAddress: r.card_address,
				tokenId: r.token_id,
				sharedMetadataHash: r.shared_metadata_hash,
				ipfsCid: r.ipfs_cid,
				cardOwner: r.card_owner,
				metadata: r.metadata_json,
				createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
			}))
		)
	} catch (e: any) {
		logger(Colors.yellow(`[listProductionIssuedNftSeriesForCardDescending] failed: ${e?.message ?? e}`))
		return []
	} finally {
		await db.end().catch(() => {})
	}
}

/** 某 NFT 系列的 sharedSeriesMetadata 记录（含 ipfsCid、metadata_json 通用型 JSON） */
export const getSeriesByCardAndTokenId = async (cardAddress: string, tokenId: string): Promise<{
	cardAddress: string
	tokenId: string
	sharedMetadataHash: string
	ipfsCid: string
	cardOwner: string
	metadata: Record<string, unknown> | null
	createdAt: string
} | null> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await db.query(BEAMIO_NFT_SERIES_TABLE)
		const { rows } = await db.query(
			`
			SELECT card_address, token_id, shared_metadata_hash, ipfs_cid, card_owner, metadata_json, created_at
			FROM beamio_nft_series
			WHERE card_address = $1 AND token_id = $2
			`,
			[cardAddress.toLowerCase(), tokenId]
		)
		if (rows.length === 0) return null
		const r = rows[0]
		return {
			cardAddress: r.card_address,
			tokenId: r.token_id,
			sharedMetadataHash: r.shared_metadata_hash,
			ipfsCid: r.ipfs_cid,
			cardOwner: r.card_owner,
			metadata: r.metadata_json,
			createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
		}
	} catch (e: any) {
		logger(Colors.yellow(`[getSeriesByCardAndTokenId] failed: ${e?.message ?? e}`))
		return null
	} finally {
		await db.end().catch(() => {})
	}
}

/** owner 在某系列下拥有的各笔 mint 的 metadata_json 列表（按创建顺序，用于电影票座位、商品序列号等） */
export const getMintMetadataForOwner = async (
	cardAddress: string,
	tokenId: string,
	ownerAddress: string,
	limit = 100
): Promise<Array<{ txHash: string | null; metadata: Record<string, unknown>; createdAt: string }>> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await db.query(BEAMIO_NFT_MINT_METADATA_TABLE)
		const { rows } = await db.query(
			`
			SELECT tx_hash, metadata_json, created_at
			FROM beamio_nft_mint_metadata
			WHERE card_address = $1 AND token_id = $2 AND owner_address = $3
			ORDER BY created_at ASC
			LIMIT $4
			`,
			[cardAddress.toLowerCase(), tokenId, ownerAddress.toLowerCase(), limit]
		)
		return rows.map((r: any) => ({
			txHash: r.tx_hash,
			metadata: r.metadata_json ?? {},
			createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
		}))
	} catch (e: any) {
		logger(Colors.yellow(`[getMintMetadataForOwner] failed: ${e?.message ?? e}`))
		return []
	} finally {
		await db.end().catch(() => {})
	}
}

/** Base 上：EOA 返回自身小写；合约则必须能解析出非零 owner()，否则 null（search 返回空）。getCode 失败时按 EOA 处理以免 RPC 抖动误杀。 */
export const resolveSearchAddressToEOALower = async (address: string): Promise<string | null> => {
	if (!ethers.isAddress(address)) return null
	const addr = ethers.getAddress(address)
	let code: string
	try {
		code = await providerBase.getCode(addr)
	} catch (e) {
		logger(`resolveSearchAddressToEOALower getCode(${addr}) failed: ${(e as Error)?.message ?? e}`)
		return addr.toLowerCase()
	}
	const isContract = Boolean(code && code !== "0x" && code.length > 2)
	if (!isContract) {
		return addr.toLowerCase()
	}
	try {
		const aa = new ethers.Contract(addr, ["function owner() view returns (address)"], providerBase)
		const owner = await aa.owner()
		if (!owner || owner === ethers.ZeroAddress) return null
		return ethers.getAddress(owner).toLowerCase()
	} catch {
		// 非 Ownable 合约（常见于 ERC-4337 AA、`owner()` 无或 eth_call 空返回）：无法用 owner 转成 EOA，仍可按该地址精确查 `accounts.address`
		return addr.toLowerCase()
	}
}

const SEARCH_EXACT_PAGE_SIZE = 10

/** 仅按 accounts.address 等值匹配（无模糊）。addressLower 为小写 0x 地址。 */
export const _searchExactByAddress = async (addressLower: string) => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		const offset = 0
		const { rows: r } = await db.query(
			`
        SELECT
          a.address,
          a.username,
          a.created_at,
          a.image,
          a.first_name,
          a.last_name,
          COALESCE((SELECT COUNT(*) FROM follows f WHERE f.follower = a.address), 0) AS follow_count,
          COALESCE((SELECT COUNT(*) FROM follows f2 WHERE f2.followee = a.address), 0) AS follower_count
        FROM accounts a
        WHERE LOWER(a.address) = LOWER($1)
        ORDER BY a.created_at DESC
        LIMIT $2 OFFSET $3
        `,
			[addressLower, SEARCH_EXACT_PAGE_SIZE, offset]
		)
		return { results: r }
	} catch (err) {
		console.error("searchUsers error:", err)
		return { error: "internal_error" }
	} finally {
		await db.end()
	}
}

/** 关键词模糊搜索（非地址检索须走 searchUsers 里对地址的分支，勿把地址传入本函数）。 */
export const _search = async (keyward: string) => {
  const _keywork = String(keyward || "")
    .trim()
    .replace(/^@+/, "")          // ✅ 去掉开头的 @@@
    .replace(/\s+/g, " ")        // ✅ 压缩空格

  const _page = 1
  const _pageSize = 10

  if (!_keywork) {
    return { results: [] }
  }

  // ethers.isAddress 声明为 `value is string`，对 string 入参在 false 分支会被 TS 误收窄为 never
  if ((ethers.isAddress as (v: string) => boolean)(_keywork)) {
    return { results: [] }
  }

  // ✅ 极短关键词直接返回，避免 %p% 这种扫库
  if (_keywork.length < 2) {
    return { results: [] }
  }

  const raw = _keywork
  const containsPat = `%${raw}%`
  const prefixPat = `${raw}%`

  const db = new Client({ connectionString: DB_URL })

  try {
    await db.connect()

    const offset = (_page - 1) * _pageSize
    logger(`_search with keyword`)

      const { rows: r } = await db.query(
        `
        WITH q AS (
          SELECT
            $1::text AS raw,
            $2::text AS contains_pat,
            $3::text AS prefix_pat
        )
        SELECT
          a.address,
          a.username,
          a.created_at,
          a.image,
          a.first_name,
          a.last_name,
          COALESCE((SELECT COUNT(*) FROM follows f WHERE f.follower = a.address), 0) AS follow_count,
          COALESCE((SELECT COUNT(*) FROM follows f2 WHERE f2.followee = a.address), 0) AS follower_count,
          CASE
            WHEN a.username ILIKE q.contains_pat THEN 'username'
            WHEN (COALESCE(a.first_name, '') || ' ' || COALESCE(a.last_name, '')) ILIKE q.contains_pat THEN 'name'
            WHEN COALESCE(a.first_name, '') ILIKE q.contains_pat THEN 'first_name'
            WHEN COALESCE(a.last_name, '') ILIKE q.contains_pat THEN 'last_name'
            ELSE 'unknown'
          END AS hit_field
        FROM accounts a
        CROSS JOIN q
        WHERE
          a.username ILIKE q.contains_pat
          OR COALESCE(a.first_name, '') ILIKE q.contains_pat
          OR COALESCE(a.last_name, '') ILIKE q.contains_pat
          OR (COALESCE(a.first_name, '') || ' ' || COALESCE(a.last_name, '')) ILIKE q.contains_pat
        ORDER BY
          CASE
            WHEN a.username ILIKE q.prefix_pat THEN 0
            WHEN COALESCE(a.first_name, '') ILIKE q.prefix_pat THEN 1
            WHEN COALESCE(a.last_name, '') ILIKE q.prefix_pat THEN 2
            WHEN (COALESCE(a.first_name, '') || ' ' || COALESCE(a.last_name, '')) ILIKE q.prefix_pat THEN 3
            ELSE 9
          END,
          GREATEST(
            similarity(a.username, q.raw) * 2.0,
            similarity(COALESCE(a.first_name, ''), q.raw) * 1.0,
            similarity(COALESCE(a.last_name, ''), q.raw) * 1.0,
            similarity((COALESCE(a.first_name, '') || ' ' || COALESCE(a.last_name, '')), q.raw) * 1.2
          ) DESC,
          a.created_at DESC
        LIMIT $4 OFFSET $5;
        `,
        [raw, containsPat, prefixPat, _pageSize, offset]
      )

    return { results: r }
  } catch (err) {
    console.error("searchUsers error:", err)
    return { error: "internal_error" }
  } finally {
    await db.end()
  }
}

/** 与 searchUsers 相同检索逻辑，供 Cluster 在二次过滤前拿到原始 results（无 HTTP）。 */
export const searchUsersResultsForKeyward = async (
	keywardRaw: string
): Promise<{ results: any[] } | { error: string }> => {
	let _keywork = String(keywardRaw || "").trim().replace(/^@+/, "")
	if (!_keywork) {
		return { results: [] }
	}
	if (ethers.isAddress(_keywork)) {
		const normalized = ethers.getAddress(_keywork)
		const eoaLower = await resolveSearchAddressToEOALower(normalized)
		if (eoaLower === null) {
			return { results: [] }
		}
		const ret = await _searchExactByAddress(eoaLower)
		if ("error" in ret && ret.error) {
			return { error: String(ret.error) }
		}
		return { results: ret.results ?? [] }
	}
	const ret = await _search(_keywork)
	if ("error" in ret && ret.error) {
		return { error: String(ret.error) }
	}
	return { results: (ret as { results: any[] }).results ?? [] }
}

export const searchUsers = async (req: Request, res: Response) => {
	const { keyward } = req.query as {
		keyward?: string
	}

	let _keywork = String(keyward || "").trim().replace(/^@+/, "")

	if (!_keywork) {
		return res.status(404).end()
	}

	if (ethers.isAddress(_keywork)) {
		const normalized = ethers.getAddress(_keywork)
		const eoaLower = await resolveSearchAddressToEOALower(normalized)
		if (eoaLower === null) {
			return res.status(200).json({ results: [] }).end()
		}
		const ret = await _searchExactByAddress(eoaLower)
		return res.status(200).json(ret).end()
	}

	const ret = await _search(_keywork)
	return res.status(200).json(ret).end()
}

const updateUserFollowDB = async (
		accountAddress: string,   // follower
		followAddress: string     // followee
	) => {
	const follower = accountAddress.toLowerCase()
	const followee = followAddress.toLowerCase()
	const nowSec = Math.floor(Date.now() / 1000)
	const db = new Client({ connectionString: DB_URL })
	await db.connect()


	try {
		await db.query("BEGIN")

		// 1) 插入关注关系（如果已经存在则忽略）
		const insertResult = await db.query(
			`
				INSERT INTO follows (follower, followee, followed_at)
				VALUES ($1, $2, $3)
				ON CONFLICT (follower, followee) DO NOTHING
			`,
			[follower, followee, nowSec]
		)

		// 2) 只有在真正插入成功时（不是重复关注），才更新计数
		if (insertResult.rowCount !== null && insertResult.rowCount > 0) {
			await db.query(
				`
				UPDATE accounts
				SET follow_count = follow_count + 1
				WHERE address = $1
				`,
				[follower]
			)

			await db.query(
				`
				UPDATE accounts
				SET follower_count = follower_count + 1
				WHERE address = $1
				`,
				[followee]
			)
		}

		await db.query("COMMIT")
	} catch (err) {
		await db.query("ROLLBACK")
		throw err
	} finally {
		await db.end()
	}
}

const updateUserFollowRemoveDB = async (
	accountAddress: string,   // follower
	followAddress: string     // followee
	) => {
	const follower = accountAddress.toLowerCase()
	const followee = followAddress.toLowerCase()
		const db = new Client({ connectionString: DB_URL })
	await db.connect()

	try {
		await db.query("BEGIN")

		// 1) 删除关注关系
		const deleteResult = await db.query(
			`
				DELETE FROM follows
				WHERE follower = $1 AND followee = $2
			`,
			[follower, followee]
		)

			// 如果本来就没有这条关系，就不用改计数，直接提交事务
			if (deleteResult.rowCount === 0) {
				await db.query("COMMIT")
			return
		}

		// 2) 更新双方计数（做防御：确保不会 < 0）
		await db.query(
		`
		UPDATE accounts
		SET follow_count = GREATEST(follow_count - 1, 0)
		WHERE address = $1
		`,
		[follower]
		)

		await db.query(
		`
		UPDATE accounts
		SET follower_count = GREATEST(follower_count - 1, 0)
		WHERE address = $1
		`,
		[followee]
		)

		await db.query("COMMIT")
	} catch (err) {
		await db.query("ROLLBACK")
		throw err
	} finally {
		await db.end()
	}
}

export const removeFollow = ( req: Request, res: Response) => {
	const { wallet, followAddress } = req.body as {
		wallet: string
		followAddress: string
	}
	addFollowPool.push({
		wallet,
		followAddress,
		remove: true
	})
	res.status(200).json({ok: true}).end()
	addFollowPoolProcess()
	
}


export const addFollow = ( req: Request, res: Response) => {
	const { wallet, followAddress } = req.body as {
		wallet: string
		followAddress: string
	}
	addFollowPool.push({
		wallet,
		followAddress,
		remove: false
	})
	res.status(200).json({ok: true}).end()
	addFollowPoolProcess()
	
}

type FollowRecord = {
	address: string      // 对方地址：following 里是 followee，followers 里是 follower
	followedAt: number   // 秒级时间戳
	status?: any
}

type FollowPage = {
	items: FollowRecord[]
	page: number
	pageSize: number
	total: number        // 总条数，用于前端算总页数
}


//		我关注了谁」列表，按时间倒序（最新 follow 在前）
const getFollowingPaginated = async (
		address: string,
		page: number,
		pageSize: number
	): Promise<FollowPage> => {

	const db = new Client({ connectionString: DB_URL })
	await db.connect()
	const addr = address.toLowerCase()

	const safePage = page > 0 ? page : 1
	const safePageSize = pageSize > 0 ? pageSize : 20
	const offset = (safePage - 1) * safePageSize

	// 1) 查总数
	const { rows: countRows } = await db.query(
		`
		SELECT COUNT(*)::BIGINT AS total
		FROM follows
		WHERE follower = $1
		`,
		[addr]
	)

	const total = Number(countRows[0]?.total ?? 0)
	if (total === 0) {
		return {
		items: [],
		page: safePage,
		pageSize: safePageSize,
		total: 0
		}
	}

	// 2) 查当前页数据（按 followed_at DESC）
	const { rows } = await db.query(
		`
		SELECT followee, followed_at
		FROM follows
		WHERE follower = $1
		ORDER BY followed_at DESC
		LIMIT $2 OFFSET $3
		`,
		[addr, safePageSize, offset]
	)

	const items: FollowRecord[] = rows.map((r: any) => ({
		address: String(r.followee),
		followedAt: Number(r.followed_at)
	}))

	return {
		items,
		page: safePage,
		pageSize: safePageSize,
		total
	}
}


//		谁关注了我」列表，按时间倒序（最新 follow 在前）
const getFollowersPaginated = async (
	address: string,
	page: number,
	pageSize: number
	): Promise<FollowPage> => {
	const addr = address.toLowerCase()

	const safePage = page > 0 ? page : 1
	const safePageSize = pageSize > 0 ? pageSize : 20
	const offset = (safePage - 1) * safePageSize
	const db = new Client({ connectionString: DB_URL })
	await db.connect()
	// 1) 查总数
	const { rows: countRows } = await db.query(
		`
		SELECT COUNT(*)::BIGINT AS total
		FROM follows
		WHERE followee = $1
		`,
		[addr]
	)

	const total = Number(countRows[0]?.total ?? 0)
	if (total === 0) {
		return {
		items: [],
		page: safePage,
		pageSize: safePageSize,
		total: 0
		}
	}

	// 2) 查当前页数据（按 followed_at DESC）
	const { rows } = await db.query(
		`
		SELECT follower, followed_at
		FROM follows
		WHERE followee = $1
		ORDER BY followed_at DESC
		LIMIT $2 OFFSET $3
		`,
		[addr, safePageSize, offset]
	)

	const items: FollowRecord[] = rows.map((r: any) => ({
		address: String(r.follower),
		followedAt: Number(r.followed_at)
	}))

	return {
		items,
		page: safePage,
		pageSize: safePageSize,
		total
	}
}


const deleteAccountFromDB = async (address: string) => {
	const addr = address.toLowerCase()
	const db = new Client({ connectionString: DB_URL })
	
	await db.connect()

	try {
		await db.query("BEGIN")

		// 删关注关系
		await db.query(
		`
		DELETE FROM follows
		WHERE follower = $1 OR followee = $1
		`,
		[addr]
		)

		// 删账号
		await db.query(
		`
		DELETE FROM accounts
		WHERE address = $1
		`,
		[addr]
		)

		await db.query("COMMIT")
	} catch (err) {
		await db.query("ROLLBACK")
		throw err
	} finally {
		logger(`deleteAccountFromDB success: ${addr}`)
		await db.end()
	}
}


export const FollowerStatus = async (
	myAddress: string,
	followerAddress: string, db = new Client({ connectionString: DB_URL })
): Promise<{
	isFollowing: boolean          // 我是否关注它
	isFollowedBy: boolean         // 它是否关注我
	following: FollowRecord[]     // 它关注了谁 (20 条)
	followers: FollowRecord[]     // 谁关注了它 (20 条)
	followingCount: number        // 它总共 follow 了多少人
	followerCount: number         // 总共有多少人 follow 它
}> => {
	const me = myAddress.toLowerCase()
	const target = followerAddress.toLowerCase()

	await db.connect()

	try {
		// 并行查询
		const [
		isFollowingResult,
		isFollowedByResult,
		followingResult,
		followersResult,
		countsResult
		] = await Promise.all([
		// 1) 我是否关注它？
		db.query(
			`
			SELECT 1
			FROM follows
			WHERE follower = $1 AND followee = $2
			LIMIT 1
			`,
			[me, target]
		),

		// 2) 它是否关注我？
		db.query(
			`
			SELECT 1
			FROM follows
			WHERE follower = $1 AND followee = $2
			LIMIT 1
			`,
			[target, me]
		),

		// 3) 它的最新 following 列表（最新 20）
		db.query(
			`
			SELECT followee, followed_at
			FROM follows
			WHERE follower = $1
			ORDER BY followed_at DESC
			LIMIT 20
			`,
			[target]
		),

		// 4) 它的最新 followers 列表（最新 20）
		db.query(
			`
			SELECT follower, followed_at
			FROM follows
			WHERE followee = $1
			ORDER BY followed_at DESC
			LIMIT 20
			`,
			[target]
		),

		// 5) 它的总 follow_count / follower_count
		// 如果你 accounts 表里没这两列，可以改成 COUNT(*) FROM follows ...
		db.query(
			`
			SELECT
			COALESCE(follow_count, 0)   AS follow_count,
			COALESCE(follower_count, 0) AS follower_count
			FROM accounts
			WHERE address = $1
			`,
			[target]
		)
		])

		const isFollowing = isFollowingResult.rowCount && isFollowingResult.rowCount > 0 ? true : false
		const isFollowedBy = isFollowedByResult.rowCount && isFollowedByResult.rowCount > 0 ? true : false

		const following: FollowRecord[] = followingResult.rows.map((r: any) => ({
			address: String(r.followee),
			followedAt: Number(r.followed_at)
		}))

		const followers: FollowRecord[] = followersResult.rows.map((r: any) => ({
		address: String(r.follower),
		followedAt: Number(r.followed_at)
		}))

		const countsRow = countsResult.rows[0] || { follow_count: 0, follower_count: 0 }
		const followingCount = Number(countsRow.follow_count ?? 0)
		const followerCount = Number(countsRow.follower_count ?? 0)

		return {
			isFollowing,
			isFollowedBy,
			following,
			followers,
			followingCount,
			followerCount
		}
	} finally {
		await db.end()
	}
}

export const getMyFollowStatus = async (
  	myAddress: string
): Promise<{
  following: FollowUserItem[]      // 我关注了谁（最新 20）
  followers: FollowUserItem[]      // 谁关注了我（最新 20）
  followingCount: number           // 我总共 follow 了多少人
  followerCount: number            // 总共有多少人 follow 我
}> => {
  const addr = myAddress.toLowerCase()

  const db = new Client({ connectionString: DB_URL })
  await db.connect()

  try {
    const [
      followingResult,
      followersResult,
      myCountsResult
    ] = await Promise.all([
      // 1) 我关注了谁（最新 20）+ 对方的 profile + 对方的计数
      db.query(
        `
        SELECT 
          f.followee AS address,
          f.followed_at,
          a.username,
          a.created_at,
          a.image,
          a.first_name,
          a.last_name,
          COALESCE(a.follow_count, 0)   AS following_count,
          COALESCE(a.follower_count, 0) AS follower_count
        FROM follows f
        LEFT JOIN accounts a
          ON a.address = f.followee
        WHERE f.follower = $1
        ORDER BY f.followed_at DESC
        LIMIT 20
        `,
        [addr]
      ),

      // 2) 谁关注了我（最新 20）+ 对方的 profile + 对方的计数
      db.query(
        `
        SELECT 
          f.follower AS address,
          f.followed_at,
          a.username,
          a.created_at,
          a.image,
          a.first_name,
          a.last_name,
          COALESCE(a.follow_count, 0)   AS following_count,
          COALESCE(a.follower_count, 0) AS follower_count
        FROM follows f
        LEFT JOIN accounts a
          ON a.address = f.follower
        WHERE f.followee = $1
        ORDER BY f.followed_at DESC
        LIMIT 20
        `,
        [addr]
      ),

      // 3) 我自己的 follow_count / follower_count
      db.query(
        `
        SELECT
          COALESCE(follow_count, 0)   AS following_count,
          COALESCE(follower_count, 0) AS follower_count
        FROM accounts
        WHERE address = $1
        `,
        [addr]
      )
    ])

    const following: FollowUserItem[] = followingResult.rows.map((r: any) => ({
      address: String(r.address),
      followedAt: Number(r.followed_at),
      username: r.username ?? null,
      createdAt: r.created_at ? Number(r.created_at) : null,
      image: r.image ?? null,
      firstName: r.first_name ?? null,
      lastName: r.last_name ?? null,
      followingCount: Number(r.following_count ?? 0),
      followerCount: Number(r.follower_count ?? 0)
    }))

    const followers: FollowUserItem[] = followersResult.rows.map((r: any) => ({
      address: String(r.address),
      followedAt: Number(r.followed_at),
      username: r.username ?? null,
      createdAt: r.created_at ? Number(r.created_at) : null,
      image: r.image ?? null,
      firstName: r.first_name ?? null,
      lastName: r.last_name ?? null,
      followingCount: Number(r.following_count ?? 0),
      followerCount: Number(r.follower_count ?? 0)
    }))

    const myCountsRow = myCountsResult.rows[0] || {
      following_count: 0,
      follower_count: 0
    }

    const followingCount = Number(myCountsRow.following_count ?? 0)
    const followerCount = Number(myCountsRow.follower_count ?? 0)

    return {
      following,
      followers,
      followingCount,
      followerCount
    }
  } finally {
    await db.end()
  }
}

export const ipfsDataPool: {
	wallet: string,
	imageLength: number
	hash: string
}[] = []

export const ipfsAccessPool: {
	hash: string
}[] = []

export const ipfsAccessProcess = async () => {
	const obj = ipfsAccessPool.shift()
	if (!obj) {
		return
	}
	const SC = beamio_ContractPool.shift()
	if (!SC) {
		ipfsAccessPool.unshift(obj)
		return setTimeout(() => {
			ipfsAccessProcess()
		}, 3000)
	}

	try {

		const tx = await SC.constIPFS.updateAccess(
			obj.hash
		)

		await tx.wait ()
		logger(`ipfsAccessProcess SUCCESS! ${tx.hash}`)
	} catch(ex: any) {
		logger(`ipfsAccessProcess Error ${ex.message}`)
	}

	beamio_ContractPool.push(SC)
	return setTimeout(() => {
		ipfsAccessProcess()
	}, 3000)

}



export const ipfsDataProcess = async () => {
	const obj = ipfsDataPool.shift()
	if (!obj) {
		return
	}

	const SC = beamio_ContractPool.shift()
	if (!SC) {
		ipfsDataPool.unshift(obj)
		return setTimeout(() => {
			ipfsDataProcess()
		}, 3000)
	}

	try {

		const tx = await SC.constIPFS.storeAdmin(
			obj.hash, obj.imageLength, obj.wallet
		)
		await tx.wait ()
		logger(`ipfsDataProcess SUCCESS! ${tx.hash}`)
	} catch(ex: any) {
		logger(`ipfsDataProcess Error ${ex.message}`)
	}

	beamio_ContractPool.push(SC)
	return setTimeout(() => {
		ipfsDataProcess()
	}, 3000)
}


export type FollowUserItem = {
	address: string
	followedAt: number
	username: string | null
	createdAt: number | null
	image: string | null
	firstName: string | null
	lastName: string | null
	followingCount: number
	followerCount: number
}


//		0xEaBF0A98aC208647247eAA25fDD4eB0e67793d61			@Beamio

// const test = async () => {
// 	const result = await _search(`Beamio`)
// 	logger(`result = `, inspect(result))
// }

// test()

const admin = ['0xEaBF0A98aC208647247eAA25fDD4eB0e67793d61']
const img = `https://beamio.app/favicon.ico`

// const addUserAdmin = async () => {
	
// 		const wallet =  admin[0]
// 		const obj: beamioAccount = {
// 			accountName: `Beamio`,
// 			address: wallet,
// 			image: img,
// 			isUSDCFaucet: false,
// 			darkTheme: false,
// 			isETHFaucet: false,
// 			firstName: 'Official',
// 			lastName: 'Beamio',
// 			initialLoading: true
// 		}
// 		addUserPool.push({
// 			wallet,
// 			account: obj,
// 			recover: []
// 		})
// 		addUserPoolProcess()

// 		addFollowPool.push({
// 			wallet,
// 			followAddress: BeamioOfficial,
// 			remove: false
// 		})
// 		addFollowPoolProcess()
	

	
// }

// addUserAdmin()