import { ethers } from "ethers"
import { Client } from "pg"
import AccountRegistryAbi from "./ABI/beamio-AccountRegistry.json"
import { logger } from "./logger"
import { inspect } from "util"
import { Request, Response} from 'express'
import {Settle_ContractPool} from './util'


const DB_URL = "postgres://account:accountpass@localhost:7434/accountdb"
const RPC_URL = "https://mainnet-rpc.conet.network"
const CONTRACT_ADDRESS = "0xF60473CB3209bd7892418A388901531A1b155B7A"
let initProcess = false

const db = new Client({ connectionString: DB_URL })
	

const initDB = async () => {

	if (initProcess) {
		return
	}
	initProcess = true


	const provider = new ethers.JsonRpcProvider(RPC_URL)
	const contract = new ethers.Contract(CONTRACT_ADDRESS, AccountRegistryAbi, provider)

	// 1) 全量同步用户（用合约的 getAccountsPaginated，倒序也没关系）
	let cursor = 0n
	const pageSize = 500n

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

const updateUserDB = async (account: beamioAccount) => {
	const now = new Date()

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

}


const getUserData = async (userName: string) => {

	const SC = Settle_ContractPool[0].constAccountRegistry
	try {
		// 1. 先通过 username 找到链上的 owner 地址
		const owner: string = await SC.getOwnerByAccountName(userName)

		if (!owner || owner === ethers.ZeroAddress) {
			// 链上没有这个用户名，DB 也不用更新
			logger(`[getUserData] username not found on-chain: ${userName}`)
			return null
		}

		// 2. 调用 getAccount(owner) 拿到链上结构
		const onchain = await SC.getAccount(owner)

		// onchain 是一个 struct，ethers v6 会给你 array + named props：
		// onchain.accountName, onchain.image, onchain.darkTheme, ...
		const accountName: string = onchain.accountName
		const image: string = onchain.image
		const darkTheme: boolean = onchain.darkTheme
		const isUSDCFaucet: boolean = onchain.isUSDCFaucet
		const isETHFaucet: boolean = onchain.isETHFaucet
		const initialLoading: boolean = onchain.initialLoading
		const firstName: string = onchain.firstName
		const lastName: string = onchain.lastName
		const createdAt: bigint = onchain.createdAt * BigInt(1000)  // solidity uint256 → bigint
		const exists: boolean = onchain.exists

		if (!exists) {
			// 理论上不会出现，因为 getAccount 不存在会 revert，保险起见
			logger(
				`[getUserData] account.exists = false on-chain for ${owner} (${userName})`
			)
			return null
		}
		await db.connect()
		// 3. 写入本地 DB（accounts 表）
		//    注意：created_at 是 BIGINT，用 string 传给 pg 最安全
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
				createdAt.toString(), // BIGINT
				now
			]
		)

		logger(
			`[getUserData] synced user ${userName} (${owner}) from chain to DB`
		)

		// 4. 返回一个整理好的对象给上层用（可选）
		return {
			address: owner.toLowerCase(),
			username: accountName,
			image,
			darkTheme,
			isUSDCFaucet,
			isETHFaucet,
			initialLoading,
			firstName,
			lastName,
			createdAt: createdAt // 前端用的话可以转 number（注意安全范围）
		}
	} catch (ex: any) {
		logger(
			`[getUserData] failed for username=${userName}:`,
			ex?.shortMessage || ex?.message || ex
		)
	}
}


type IAccountRecover = {
	hash: string
	encrypto: string
}
type IAddUserPool = {
	account: beamioAccount
	recover?: IAccountRecover
}
const addUserPool: IAddUserPool [] = []

const addUserPoolProcess = async () => {
	const obj = addUserPool.shift()
	if (!obj) {
		return
	}

	const SC = Settle_ContractPool.shift()
	if (!SC) {
		addUserPool.unshift(obj)
		setTimeout(() => {
			addUserPoolProcess()
		}, 2000)
		return
	}
	const account = {
		accountName: obj.account.accountName,
		image: obj.account.image,
		darkTheme: obj.account.darkTheme,
		isUSDCFaucet:  obj.account.isUSDCFaucet,
		isETHFaucet: obj.account.isETHFaucet,
		initialLoading: obj.account.initialLoading,
		firstName: obj.account.firstName,
		lastName: obj.account.lastName
	}
	try {
		const tx = await SC.constAccountRegistry.setAccountByAdmin(account)
		
		if (obj.recover) {
			const tr = await SC.constAccountRegistry.setBase64ByNameHash(obj.recover.hash, obj.recover.encrypto)
			await Promise.all([
				tr.wait(),
				tx.wait()
			])
			logger(`addUserPoolProcess success ! setAccountByAdmin ${tx.hash} recover ${tr.hash}`)
		} else {
			await tx.wait()
			logger(`addUserPoolProcess success ! setAccountByAdmin ${tx.hash} `)
		}
		updateUserDB(obj.account)

	} catch (ex: any) {
		logger(`addUserPoolProcess Error: ${ex.message}`)
	}

	Settle_ContractPool.unshift(SC)
	setTimeout(() => {
		addUserPoolProcess()
	}, 2000)

}

export const addUser = async (req: Request, res: Response) => {
	const { accountName, wallet, recover, image, isUSDCFaucet, darkTheme, isETHFaucet, firstName, lastName } = req.query as {
		accountName?: string
		wallet?: string
		recover?: IAccountRecover
		image?: string
		isUSDCFaucet?: boolean
		darkTheme?: boolean
		isETHFaucet?: boolean
		firstName?: string
		lastName?: string
	}

	try {

		if (!accountName || !ethers.isAddress(wallet) || wallet === ethers.ZeroAddress) {
			return res.status(400).json({ error: "Invalid data format" })
		}
		const getExistsUserData = await getUserData(accountName)
		

		// 2. 填默认值，保证所有 field 都存在

		const fullInput: beamioAccount = {
			accountName: accountName,
			image: image||getExistsUserData?.image||'',
			darkTheme: typeof (darkTheme) === 'boolean' ? darkTheme : typeof (getExistsUserData?.darkTheme) === 'boolean' ? getExistsUserData.darkTheme: false,
			isUSDCFaucet: typeof isUSDCFaucet === 'boolean' ? isUSDCFaucet: typeof (getExistsUserData?.isUSDCFaucet) === 'boolean' ? getExistsUserData.isUSDCFaucet: false,
			isETHFaucet: typeof isETHFaucet === 'boolean' ? isETHFaucet: typeof (getExistsUserData?.isETHFaucet) === 'boolean' ? getExistsUserData.isETHFaucet: false,
			initialLoading: true,
			firstName: firstName||getExistsUserData?.firstName||'',
			lastName: lastName||getExistsUserData?.lastName||'',
			address: wallet,
			createdAt: getExistsUserData?.createdAt
		}
		

		addUserPool.push({
			account: fullInput,
			recover: recover

		})

		addUserPoolProcess()


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

export const searchUsers = async (req: Request, res: Response) => {
	const { keyward, page, pageSize } = req.query as {
		keyward?: string
		page?: string
		pageSize?: string
	}

	const _keywork = String(keyward || "").trim()
	const _page = Number(page || 1)
	const _pageSize = Math.min(Number(pageSize || 20), 100)

	if (!_keywork) {
		return res.status(404).end()
	}
	await db.connect()
	const offset = (_page - 1) * _pageSize

	const { rows } = await db.query(
		`
		SELECT address, username, created_at
		FROM accounts
		WHERE username ILIKE $1
		ORDER BY created_at DESC
		LIMIT $2 OFFSET $3
		`,
		[`%${_keywork}%`, pageSize, offset]
  	)

	res.json({
		page: _page,
		pageSize: _pageSize,
		results: rows
	})

}

initDB()