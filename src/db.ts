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


export const addUser = async (req: Request, res: Response) => {
	const { keyward, page, pageSize } = req.query as {
		keyward?: string
		page?: string
		pageSize?: string
	}

	try {

		const { account, input } = req.body as {
			account?: string
			input?: Partial<beamioAccount>
		}

		if (!account || !ethers.isAddress(account)) {
			return res.status(400).json({ error: "Invalid account address" })
		}

		if (!input || typeof input?.accountName !== "string") {
			return res.status(400).json({ error: "Missing input.accountName" })
		}

		// 2. 填默认值，保证所有 field 都存在
		
		const fullInput: beamioAccount = {
			accountName: input.accountName,
			image: input.image ?? "",
			darkTheme: Boolean(input.darkTheme),
			isUSDCFaucet: Boolean(input.isUSDCFaucet),
			isETHFaucet: Boolean(input.isETHFaucet),
			initialLoading: Boolean(input.initialLoading),
			firstName: input.firstName ?? "",
			lastName: input.lastName ?? ""
		}

		// // 3. 组装 calldata：ethers v6 struct 传参可以直接用对象
		// console.log("[setAccountByAdmin] sending tx for", account, fullInput)

		// const tx = await accountRegistry.setAccountByAdmin(account, fullInput)
		// console.log("[setAccountByAdmin] tx sent:", tx.hash)

		// // 等待链上确认（可根据需要调整确认数）
		// const receipt = await tx.wait()
		// console.log("[setAccountByAdmin] confirmed in block", receipt.blockNumber)

		// // 可选：回读 summary 做 sanity check
		// const summary = await accountRegistry.getUserSummary(account)
		// // summary: [username, createdAt, followCount, followerCount]

		// return res.json({
		// 	ok: true,
		// 	txHash: tx.hash,
		// 	blockNumber: receipt.blockNumber,
		// 	account,
		// 	usernameOnChain: summary[0],
		// 	createdAt: summary[1].toString(),
		// 	followCount: summary[2].toString(),
		// 	followerCount: summary[3].toString()
		// })
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