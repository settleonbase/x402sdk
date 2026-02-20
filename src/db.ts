import { ethers } from "ethers"
import { Client } from "pg"
import AccountRegistryAbi from "./ABI/beamio-AccountRegistry.json"
import { logger } from "./logger"
import { inspect } from "util"
import { Request, Response} from 'express'
import Colors from 'colors/safe'
import {masterSetup} from './util'
import beamioConetABI from './ABI/beamio-conet.abi.json'
import conetAirdropABI from './ABI/conet_airdrop.abi.json'
import AccountRegistryABI from './ABI/beamio-AccountRegistry.json'
import IPFSAbi from './ABI/Ipfs.abi.json'
import conetPGPABI from './ABI/conetPGP.json'

/**
 * 
 * 
 * 
 */


const RPC_URL = "https://mainnet-rpc1.conet.network"
const BASE_RPC_URL = masterSetup?.base_endpoint || 'https://mainnet.base.org'

const providerConet = new ethers.JsonRpcProvider(RPC_URL)
const providerBase = new ethers.JsonRpcProvider(BASE_RPC_URL)

const beamioConet = '0xCE8e2Cda88FfE2c99bc88D9471A3CBD08F519FEd'
const airdropRecord = '0x070BcBd163a3a280Ab6106bA62A079f228139379'
const beamioConetAccountRegistry = '0x3E15607BCf98B01e6C7dF834a2CEc7B8B6aFb1BC'
const IpfsStorageRegistryGlobalDedup = '0x121c4dDCa92f07dc53Fd6Db9bc5A07c2918F9591'
const addressPGP = '0x13A96Bcd6aB010619d1004A1Cb4f5FE149e0F4c4'

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
		
		// 在 setAccountByAdmin 成功后执行 follow BeamioOfficial。需确认 BeamioOfficial 有账户，否则 followByAdmin 会 AccountNotFound
		if (obj.wallet.toLowerCase() !== BeamioOfficial.toLowerCase() && obj.followBeamioOfficial) {
			try {
				await (SC.constAccountRegistry as any).getAccount(BeamioOfficial)
				const followTx = await SC.constAccountRegistry.followByAdmin(obj.wallet, BeamioOfficial)
				await followTx.wait()
				logger('addUserPoolProcess followByAdmin BeamioOfficial SUCCESS!', followTx.hash)
				await updateUserFollowDB(obj.wallet, BeamioOfficial)
			} catch (followEx: any) {
				const msg = followEx?.shortMessage || followEx?.message || ''
				if (/AccountNotFound|routePgpKeyID not in|route key not recorded/i.test(msg)) {
					logger(`addUserPoolProcess skip followBeamioOfficial: ${msg}`)
				} else {
					logger(`addUserPoolProcess followByAdmin Error: ${msg} | wallet=${obj.wallet}`)
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
	try {
		const tx = await SC.constPgpManager.addPublicPGPByAdmin(
			obj.wallet,
			obj.keyID,
			obj.publicKeyArmored,
			obj.encrypKeyArmored,
			obj.routeKeyID
		)
		await tx.wait()
		logger('regiestChatRouteProcess addPublicPGPByAdmin SUCCESS!', tx.hash)
		obj.res.json({ ok: true, txHash: tx.hash })
	} catch (err: any) {
		const msg = err?.shortMessage || err?.message || 'Unknown error'
		logger('regiestChatRouteProcess Error:', msg)
		obj.res.status(500).json({ ok: false, error: msg })
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

/** createCard 成功后登记到本地 DB */
export const registerCardToDb = async (params: {
	cardAddress: string
	cardOwner: string
	currency: string
	priceInCurrencyE6: string
	uri?: string
	shareTokenMetadata?: { name?: string; description?: string; image?: string }
	tiers?: Array<{ index: number; minUsdc6: string; attr: number; name?: string; description?: string }>
	txHash?: string
}): Promise<void> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await db.query(BEAMIO_CARDS_TABLE)
		const metadataJson = JSON.stringify({
			...(params.shareTokenMetadata && { shareTokenMetadata: params.shareTokenMetadata }),
			...(params.tiers && params.tiers.length > 0 && { tiers: params.tiers }),
		}) || null
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
				params.cardAddress.toLowerCase(),
				params.cardOwner.toLowerCase(),
				params.currency,
				params.priceInCurrencyE6,
				params.uri ?? null,
				metadataJson && metadataJson !== '{}' ? metadataJson : null,
				params.txHash ?? null,
			]
		)
		logger(Colors.green(`[registerCardToDb] registered card=${params.cardAddress}`))
	} catch (e: any) {
		logger(Colors.yellow(`[registerCardToDb] failed: ${e?.message ?? e}`))
	} finally {
		await db.end().catch(() => {})
	}
}

/** 最新发行的前 N 张卡明细 */
export const getLatestCards = async (limit = 20): Promise<Array<{
	cardAddress: string
	cardOwner: string
	currency: string
	priceInCurrencyE6: string
	uri: string | null
	metadata: Record<string, unknown> | null
	txHash: string | null
	totalPointsMinted6: string
	holderCount: number
	createdAt: string
}>> => {
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
		return rows.map((r: any) => ({
			cardAddress: r.card_address,
			cardOwner: r.card_owner,
			currency: r.currency,
			priceInCurrencyE6: r.price_in_currency_e6,
			uri: r.uri,
			metadata: r.metadata_json,
			txHash: r.tx_hash,
			totalPointsMinted6: String(r.total_points_minted_6 ?? 0),
			holderCount: Number(r.holder_count ?? 0),
			createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
		}))
	} catch (e: any) {
		logger(Colors.yellow(`[getLatestCards] failed: ${e?.message ?? e}`))
		return []
	} finally {
		await db.end().catch(() => {})
	}
}

/** 登记 issued NFT 系列到 DB（createIssuedNft 成功后由 API/daemon 调用）；metadataJson 为通用型 JSON，支持电影/演唱会/商品等场景 */
export const registerSeriesToDb = async (params: {
	cardAddress: string
	tokenId: string
	sharedMetadataHash: string
	ipfsCid: string
	cardOwner: string
	metadataJson?: Record<string, unknown>
}): Promise<void> => {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await db.query(BEAMIO_NFT_SERIES_TABLE)
		const meta = params.metadataJson != null ? JSON.stringify(params.metadataJson) : null
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
				params.ipfsCid,
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