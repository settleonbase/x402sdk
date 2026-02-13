import { ethers } from "ethers"
import { Client } from "pg"
import AccountRegistryAbi from "./ABI/beamio-AccountRegistry.json"
import { logger } from "./logger"
import { inspect } from "util"
import { Request, Response} from 'express'
import {masterSetup, BeamioETHFaucetTry} from './util'
import beamioConetABI from './ABI/beamio-conet.abi.json'
import conetAirdropABI from './ABI/conet_airdrop.abi.json'
import AccountRegistryABI from './ABI/beamio-AccountRegistry.json'
import IPFSAbi from './ABI/Ipfs.abi.json'

/**
 * 
 * 
 * 
 */


const RPC_URL = "https://mainnet-rpc1.conet.network"
const BASE_RPC_URL = "https://1rpc.io/base"

const providerConet = new ethers.JsonRpcProvider(RPC_URL)
const providerBase = new ethers.JsonRpcProvider(BASE_RPC_URL)

const beamioConet = '0xCE8e2Cda88FfE2c99bc88D9471A3CBD08F519FEd'
const airdropRecord = '0x070BcBd163a3a280Ab6106bA62A079f228139379'
const beamioConetAccountRegistry = '0x3E15607BCf98B01e6C7dF834a2CEc7B8B6aFb1BC'
const IpfsStorageRegistryGlobalDedup = '0x121c4dDCa92f07dc53Fd6Db9bc5A07c2918F9591'

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
	}
})

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

const getUserData = async (userName: string) => {

	const SC = beamio_ContractPool[0].constAccountRegistry
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
		logger(`getUserData Start save to DB!`)
		const db = new Client({ connectionString: DB_URL })
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
		await db.end()
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


const addUserPool: IAddUserPool [] = []
const addFollowPool: {
	wallet: string
	followAddress: string
	remove: boolean
}[] = []


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
		image: obj.account.image,
		darkTheme: obj.account.darkTheme,
		isUSDCFaucet:  obj.account.isUSDCFaucet,
		isETHFaucet: obj.account.isETHFaucet,
		initialLoading: obj.account.initialLoading,
		firstName: obj.account.firstName,
		lastName: obj.account.lastName
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

				// 1. 发送交易（等待发出去）
				const tr = await SC.constAccountRegistry.setBase64NameByAdmin(
					n.hash,
					n.encrypto,
					account.accountName,
					obj.wallet
				)

				// 2. 等待这笔交易上链
				const receipt = await tr.wait()
				logger('addUserPoolProcess setBase64NameByAdmin', tr.hash)
			}
		}

		await updateUserDB(obj.account)

	} catch (ex: any) {
		logger(`addUserPoolProcess Error: ${ex.message}`)
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
		logger(`addFollowPoolProcess Error: ${ex.message}`)
	}

	beamio_ContractPool.unshift(SC)
	setTimeout(() => {
		addFollowPoolProcess()
	}, 2000)

}


const BeamioOfficial = '0xeabf0a98ac208647247eaa25fdd4eb0e67793d61'

export const addUser = async (req: Request, res: Response) => {
	const { accountName, wallet, recover, image, isUSDCFaucet, darkTheme, isETHFaucet, firstName, lastName } = req.body as {
		accountName: string
		wallet: string
		recover: IAccountRecover[]
		image: string
		isUSDCFaucet: boolean
		darkTheme: boolean
		isETHFaucet: boolean
		firstName: string
		lastName: string
	}

	try {

		const getExistsUserData = await getUserData(accountName)
		
		// 2. 填默认值，保证所有 field 都存在

		const fullInput: beamioAccount = {
			accountName: accountName,
			image,
			darkTheme,
			isUSDCFaucet,
			isETHFaucet,
			initialLoading: true,
			firstName,
			lastName,
			address: wallet,
			createdAt: getExistsUserData?.createdAt
		}
		

		addUserPool.push({
			wallet,
			account: fullInput,
			recover: recover
		})

		addUserPoolProcess()
		BeamioETHFaucetTry(wallet)

		addFollowPool.push({
			wallet,
			followAddress: BeamioOfficial,
			remove: false
		})
		addFollowPoolProcess()

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

const DB_URL = "postgres://postgres:your_password@127.0.0.1:5432/postgres"
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

  // ✅ 极短关键词直接返回，避免 %p% 这种扫库
  if (_keywork.length < 2 && !ethers.isAddress(_keywork)) {
    return { results: [] }
  }

  const raw = _keywork
  const containsPat = `%${raw}%`
  const prefixPat = `${raw}%`

  const isAddress = ethers.isAddress(_keywork)
  const db = new Client({ connectionString: DB_URL })

  try {
    await db.connect()

    const offset = (_page - 1) * _pageSize
    let rows: any[] = []

    if (isAddress) {
      const address = _keywork.toLowerCase()
      logger(`_search with address`)

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
        [address, _pageSize, offset]
      )

      rows = r
    } else {
      logger(`_search with keyword`)

      // ✅ 可选：降低相似度阈值，让短词排序更稳定（你每次都 connect/end，所以放这里也行）
      // await db.query(`SELECT set_limit(0.12)`)

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

      rows = r
    }

    return { results: rows }
  } catch (err) {
    console.error("searchUsers error:", err)
    return { error: "internal_error" }
  } finally {
    await db.end()
  }
}

/** If the given address is an AA (has contract code on Base), return its owner (EOA); otherwise return the input. */
const resolveAAToEOA = async (address: string): Promise<string> => {
	if (!ethers.isAddress(address)) return address
	try {
		const code = await providerBase.getCode(address)
		if (!code || code === "0x" || code.length <= 2) return address
		const aa = new ethers.Contract(address, ["function owner() view returns (address)"], providerBase)
		const owner = await aa.owner()
		if (owner && owner !== ethers.ZeroAddress) return ethers.getAddress(owner)
	} catch (e) {
		logger(`resolveAAToEOA(${address}) failed: ${(e as Error)?.message ?? e}`)
	}
	return address
}

export const searchUsers = async (req: Request, res: Response) => {
	const { keyward } = req.query as {
		keyward?: string
	}

	let _keywork = String(keyward || "").trim().replace(/^@+/, "")

	if (!_keywork) {
		return res.status(404).end()
	}

	// If the search key is a wallet address and it is an AA on Base, resolve to EOA before searching (accounts table stores EOA).
	if (ethers.isAddress(_keywork)) {
		_keywork = await resolveAAToEOA(_keywork)
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