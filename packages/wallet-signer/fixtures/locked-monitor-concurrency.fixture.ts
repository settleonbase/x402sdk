/**
 * Local isolation fixture for locked receipt/balance reads, low-gas skip, and
 * two-key nonce locks. Stub JSON-RPC on 127.0.0.1 only.
 * Does not read master.json, print mnemonics or private keys, dial a
 * production RPC, broadcast to a live chain, or start a Gas Keeper timer.
 */
import { createServer, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Transaction, Wallet, getAddress } from 'ethers'
import { AuditLog } from '../src/audit'
import { GasKeeper } from '../src/gasKeeper'
import type { Keyring } from '../src/keyring'
import { TxManager, type TxRecord } from '../src/txManager'
import { handleSetChatIndexPointerHttp } from '../../../src/walletSigner/chatPointerRelayGate'

const EVIDENCE = join(tmpdir(), 'wallet-signer-low-gas-skip-evidence.log')
const CHAIN_ID = 224422

type SendSeen = { from: string; nonce: number; hash: string }

type StubState = {
	methods: string[]
	sends: SendSeen[]
	balances: Map<string, bigint>
	pendingNonce: Map<string, number>
	latestNonce: Map<string, number>
	receipts: Map<string, boolean>
	gasPrice: bigint
	holdNonceMs: number
	holdSendMs: number
}

function main(): Promise<void> {
	return run()
}

async function run(): Promise<void> {
	const lines: string[] = []
	const note = (line: string) => {
		lines.push(line)
	}
	note(`time ${new Date().toISOString()}`)
	note('followUp low-gas preflight retest')
	note('priorEvidence left unchanged')
	note('productionTouched false')
	note('ssh false')
	note('productionRpc false')
	note('gasKeeperStarted false')
	note('registryWrite false')
	note('broadcastTarget 127.0.0.1 stub only')
	note('secretsRead false')

	const dir = mkdtempSync(join(tmpdir(), 'ws-isolate-'))
	const state = emptyState()
	const server = createServer((req, res) => {
		const chunks: Buffer[] = []
		req.on('data', (c) => chunks.push(c as Buffer))
		req.on('end', () => {
			void handleRpc(state, Buffer.concat(chunks).toString('utf8'), res)
		})
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const port = (server.address() as { port: number }).port
	note(`stubRpc http://127.0.0.1:${port}`)

	const results: Record<string, '完成' | '阻塞'> = {
		lockedMonitor: '阻塞',
		lowGasSkip: '阻塞',
		concurrency: '阻塞',
	}
	try {
		results.lockedMonitor = await proveLockedMonitor(dir, port, state, note)
		results.lowGasSkip = await proveLowGasSkip(dir, port, state, note)
		results.concurrency = await proveConcurrency(dir, port, state, note)
	} finally {
		server.close()
		rmSync(dir, { recursive: true, force: true })
	}

	note('---')
	note(`item1_locked_monitor ${results.lockedMonitor}`)
	note(`item2_low_gas_skip ${results.lowGasSkip}`)
	note(`item3_concurrency ${results.concurrency}`)
	note('productionTouched false')
	writeFileSync(EVIDENCE, `${lines.join('\n')}\n`)
	process.stdout.write(`${lines.join('\n')}\n`)
}

function emptyState(): StubState {
	return {
		methods: [],
		sends: [],
		balances: new Map(),
		pendingNonce: new Map(),
		latestNonce: new Map(),
		receipts: new Map(),
		gasPrice: 1n,
		holdNonceMs: 0,
		holdSendMs: 0,
	}
}

async function proveLockedMonitor(dir: string, port: number, state: StubState, note: (line: string) => void): Promise<'完成' | '阻塞'> {
	reset(state)
	note('## item1 locked monitor')
	const wallet = Wallet.createRandom()
	const raw = wallet.signingKey.sign(Transaction.from({
		type: 0,
		chainId: CHAIN_ID,
		nonce: 1,
		to: wallet.address,
		value: 0,
		gasLimit: 21_000,
		gasPrice: 1,
		data: '0x',
	}).unsignedHash)
	const tx = Transaction.from({
		type: 0,
		chainId: CHAIN_ID,
		nonce: 1,
		to: wallet.address,
		value: 0,
		gasLimit: 21_000,
		gasPrice: 1,
		data: '0x',
		signature: raw,
	})
	const hash = tx.hash!
	const rec: TxRecord = {
		id: 'locked-monitor',
		client: 'conet-beamio-api',
		array: 'chat_index_pointer',
		chainId: CHAIN_ID,
		from: wallet.address,
		to: wallet.address,
		data: '0x',
		value: '0',
		nonce: 1,
		gasLimit: '21000',
		type: 0,
		gasPrice: '1',
		hash,
		hashes: [hash],
		raw: tx.serialized,
		status: 'sent',
		resends: 0,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		lastSentAt: Date.now(),
	}
	const journal = join(dir, 'locked-journal.jsonl')
	writeFileSync(journal, `${JSON.stringify(rec)}\n`)
	state.balances.set(wallet.address.toLowerCase(), 42_000n)
	const pm = Wallet.createRandom()
	state.balances.set(pm.address.toLowerCase(), 7n)
	const gate = { unlocked: false }
	const alerts: string[] = []
	const txm = new TxManager(
		{ '224422': { rpcUrls: [`http://127.0.0.1:${port}`], resendAfterMs: 15, maxResends: 100, receiptPollMs: 10 } },
		gate as unknown as Keyring,
		new AuditLog(join(dir, 'locked-audit.jsonl')),
		{ send(_level: string, _key: string, message: string) { alerts.push(message) } },
		journal,
		1,
	)
	const gk = new GasKeeper(
		{
			'224422': {
				minWei: '1',
				targetWei: '2',
				perAddressDailyWei: '10',
				globalDailyWei: '10',
				pmWarnWei: '1',
				pmCriticalWei: '1',
			},
		},
		60_000,
		txm,
		gate as unknown as Keyring,
		() => ({
			version: 1,
			pm: pm.address,
			attestor: wallet.address,
			arrays: [{
				name: 'chat_index_pointer',
				account: 10,
				count: 1,
				chains: [CHAIN_ID],
				status: 'active',
				addresses: [wallet.address],
				createdAt: new Date().toISOString(),
			}],
			updatedAt: new Date().toISOString(),
		}),
		() => new Set<string>(),
		{ send() {} },
		new AuditLog(join(dir, 'locked-gas-audit.jsonl')),
		join(dir, 'gas.json'),
	)
	try {
		txm.start()
		await waitFor(() => state.methods.includes('eth_getTransactionReceipt') && state.methods.includes('eth_getTransactionCount'), 1500)
		await delay(60)
		const sendsWhileAbsent = state.sends.length
		const balance = await txm.provider(CHAIN_ID).getBalance(wallet.address)
		const status = await gk.status()
		const beforeRun = state.sends.length
		await gk.runOnce()
		const afterRun = state.sends.length
		state.receipts.set(hash.toLowerCase(), true)
		await waitFor(() => readFileSync(journal, 'utf8').includes('"status":"mined"'), 1500)
		txm.stop()
		const sendCount = state.methods.filter((m) => m === 'eth_sendRawTransaction').length
		const receiptCount = state.methods.filter((m) => m === 'eth_getTransactionReceipt').length
		const balanceCount = state.methods.filter((m) => m === 'eth_getBalance').length
		const chainStatus = status['224422'] as Record<string, string>
		note(`address ${wallet.address}`)
		note(`pmAddress ${pm.address}`)
		note(`balanceRead ${balance.toString()}`)
		note(`gasKeeperStatus ${JSON.stringify(chainStatus)}`)
		note(`receiptCalls ${receiptCount}`)
		note(`balanceCalls ${balanceCount}`)
		note(`rpcMethods ${histogram(state.methods)}`)
		note(`sendRawCalls ${sendCount}`)
		note(`sendsWhileReceiptAbsent ${sendsWhileAbsent}`)
		note(`gasKeeperRunOnceSends ${afterRun - beforeRun}`)
		note(`minedWithoutRebroadcast true`)
		note(`alerts ${alerts.length}`)
		const ok = sendCount === 0
			&& sendsWhileAbsent === 0
			&& afterRun === beforeRun
			&& receiptCount > 0
			&& balanceCount >= 2
			&& balance === 42_000n
			&& chainStatus.PM === '0.000000000000000007'
			&& gate.unlocked === false
		note(ok ? 'result 完成' : 'result 阻塞')
		return ok ? '完成' : '阻塞'
	} finally {
		txm.stop()
	}
}

async function proveLowGasSkip(dir: string, port: number, state: StubState, note: (line: string) => void): Promise<'完成' | '阻塞'> {
	reset(state)
	note('## item2 low gas skip')
	const wallet = Wallet.createRandom()
	const gasLimit = 21_000n
	const gasPrice = 1_000n
	const value = 0n
	const balance = 1_000n
	const worst = gasLimit * gasPrice + value
	state.gasPrice = gasPrice
	state.balances.set(wallet.address.toLowerCase(), balance)
	state.pendingNonce.set(wallet.address.toLowerCase(), 0)
	state.latestNonce.set(wallet.address.toLowerCase(), 0)
	const gate = {
		unlocked: true,
		signTransaction(address: string, tx: Transaction): string {
			if (getAddress(address) !== wallet.address) throw new Error('unknown or locked key')
			const clone = tx.clone()
			clone.signature = wallet.signingKey.sign(clone.unsignedHash)
			return clone.serialized
		},
	}
	const auditPath = join(dir, 'lowgas-audit.jsonl')
	const alerts: string[] = []
	const txm = new TxManager(
		{ '224422': { rpcUrls: [`http://127.0.0.1:${port}`], resendAfterMs: 60_000, maxResends: 0, receiptPollMs: 60_000 } },
		gate as unknown as Keyring,
		new AuditLog(auditPath),
		{ send(_level: string, key: string, message: string) { alerts.push(`${key} ${message}`) } },
		join(dir, 'lowgas-journal.jsonl'),
		1,
	)
	let error = ''
	try {
		await txm.send({
			client: 'conet-beamio-api',
			array: 'chat_index_pointer',
			chainId: CHAIN_ID,
			candidates: [wallet.address],
			from: wallet.address,
			to: wallet.address,
			data: '0x',
			value,
			gasLimit,
			maxInflightPerKey: 1,
			skipSimulation: true,
		})
	} catch (e) {
		error = e instanceof Error ? e.message : String(e)
	}
	const audit = readFileSync(auditPath, 'utf8')
	const sendCount = state.sends.length
	const recordedSkip = /tx\.skip|below worst-case gas/i.test(audit) && alerts.some((a) => /below worst-case gas/i.test(a))
	note(`balanceWei ${balance.toString()}`)
	note(`worstCaseWei ${worst.toString()}`)
	note(`worstCaseFormula gasLimit*gasPrice+value`)
	note(`productSendRaw ${sendCount}`)
	note(`productNonce ${state.sends.map((row) => row.nonce).join(',') || 'none'}`)
	note(`productError ${error || 'none'}`)
	note(`skipReasonRecorded ${recordedSkip}`)
	note(`rpcMethods ${histogram(state.methods)}`)
	const fundedWallet = Wallet.createRandom()
	state.balances.set(fundedWallet.address.toLowerCase(), worst)
	state.pendingNonce.set(fundedWallet.address.toLowerCase(), 0)
	const fundedGate = gate as { signTransaction: (address: string, tx: Transaction) => string }
	const previousSign = fundedGate.signTransaction
	fundedGate.signTransaction = (address: string, tx: Transaction) => {
		if (getAddress(address) === fundedWallet.address) {
			const clone = tx.clone()
			clone.signature = fundedWallet.signingKey.sign(clone.unsignedHash)
			return clone.serialized
		}
		return previousSign(address, tx)
	}
	const funded = await txm.send({
		client: 'conet-beamio-api',
		array: 'chat_index_pointer',
		chainId: CHAIN_ID,
		candidates: [fundedWallet.address],
		from: fundedWallet.address,
		to: fundedWallet.address,
		data: '0x',
		value,
		gasLimit,
		maxInflightPerKey: 1,
		skipSimulation: true,
		idempotencyKey: 'funded-boundary',
	})
	const fundedSends = state.sends.length - sendCount
	note(`fundedBalanceWei ${worst.toString()}`)
	note(`fundedSendRaw ${fundedSends}`)
	note(`fundedNonce ${funded.nonce}`)
	const skipped = sendCount === 0 && recordedSkip && /below worst-case gas/.test(error)
	const boundaryOk = fundedSends === 1 && funded.nonce === 0
	note(skipped && boundaryOk
		? 'result 完成'
		: 'result 阻塞 balance preflight did not both refuse the short balance and allow the exact worst-case balance')
	return skipped && boundaryOk ? '完成' : '阻塞'
}

async function proveConcurrency(dir: string, port: number, state: StubState, note: (line: string) => void): Promise<'完成' | '阻塞'> {
	reset(state)
	note('## item3 concurrency')
	const a = Wallet.createRandom()
	const b = Wallet.createRandom()
	const wallets = new Map<string, Wallet>([[a.address.toLowerCase(), a], [b.address.toLowerCase(), b]])
	state.gasPrice = 1n
	for (const w of [a, b]) {
		state.balances.set(w.address.toLowerCase(), 10n ** 18n)
		state.pendingNonce.set(w.address.toLowerCase(), 0)
		state.latestNonce.set(w.address.toLowerCase(), 0)
	}
	state.holdNonceMs = 40
	state.holdSendMs = 40
	const gate = {
		unlocked: true,
		signTransaction(address: string, tx: Transaction): string {
			const w = wallets.get(address.toLowerCase())
			if (!w) throw new Error('unknown or locked key')
			const clone = tx.clone()
			clone.signature = w.signingKey.sign(clone.unsignedHash)
			return clone.serialized
		},
	}
	const txm = new TxManager(
		{ '224422': { rpcUrls: [`http://127.0.0.1:${port}`], resendAfterMs: 60_000, maxResends: 0, receiptPollMs: 60_000 } },
		gate as unknown as Keyring,
		new AuditLog(join(dir, 'concurrency-audit.jsonl')),
		{ send() {} },
		join(dir, 'concurrency-journal.jsonl'),
		50,
	)
	const contract = '0x1511Caa71081C84d8a591490D1b83879088EED72'
	const [firstA, firstB] = await Promise.all([
		txm.send(sendReq(a.address, contract, 'a-1')),
		txm.send(sendReq(b.address, contract, 'b-1')),
	])
	const [secondA, secondB] = await Promise.all([
		txm.send(sendReq(a.address, contract, 'a-2')),
		txm.send(sendReq(b.address, contract, 'b-2')),
	])
	const byFrom = new Map<string, number[]>()
	for (const row of state.sends) {
		const list = byFrom.get(row.from.toLowerCase()) ?? []
		list.push(row.nonce)
		byFrom.set(row.from.toLowerCase(), list)
	}
	const noncesA = byFrom.get(a.address.toLowerCase()) ?? []
	const noncesB = byFrom.get(b.address.toLowerCase()) ?? []
	note(`addressA ${a.address} nonces ${noncesA.join(',')}`)
	note(`addressB ${b.address} nonces ${noncesB.join(',')}`)
	note(`resultNonces ${firstA.nonce},${secondA.nonce} and ${firstB.nonce},${secondB.nonce}`)
	const independent = noncesA.join(',') === '0,1' && noncesB.join(',') === '0,1'
		&& firstA.from.toLowerCase() === a.address.toLowerCase()
		&& firstB.from.toLowerCase() === b.address.toLowerCase()

	reset(state)
	let emptyError = ''
	let emptySends = 0
	try {
		await txm.send({ ...sendReq(a.address, contract, 'empty'), candidates: [] })
	} catch (e) {
		emptyError = e instanceof Error ? e.message : String(e)
	}
	emptySends = state.sends.length
	note(`txManagerEmptyPool error ${emptyError || 'none'}`)
	note(`txManagerEmptyPool sendRaw ${emptySends}`)

	let legacyReads = 0
	let sendCalls = 0
	const http = await handleSetChatIndexPointerHttp(
		{
			owner: a.address,
			indexHash: `0x${'11'.repeat(32)}`,
			ts: '1',
			seq: '1',
			nonce: '0',
			signature: `0x${'ab'.repeat(65)}`,
		},
		{
			isolationActive: true,
			env: {
				WALLET_SIGNER_CHAT_POINTER_ARRAY: 'chat_index_pointer',
				WALLET_SIGNER_CHAT_POINTER_CONTRACT: contract,
			},
			lookup: {
				async accounts() {
					return []
				},
			},
			readLegacyKeys: () => {
				legacyReads += 1
				return ['legacy-key-must-not-be-read']
			},
			send: async () => {
				sendCalls += 1
				return { txHash: `0x${'00'.repeat(32)}` }
			},
		},
	)
	const body = http.deferred ? null : http.json
	note(`emptyRoster deferred ${http.deferred}`)
	note(`emptyRoster status ${http.deferred ? 'n/a' : http.status}`)
	note(`emptyRoster error ${body?.error ?? 'none'}`)
	note(`legacyKeyReads ${legacyReads}`)
	note(`isolatedSendCalls ${sendCalls}`)
	const emptyOk = !http.deferred
		&& http.status === 503
		&& body?.error === 'signer_unavailable'
		&& legacyReads === 0
		&& sendCalls === 0
		&& emptySends === 0
	const ok = independent && emptyOk
	note(ok ? 'result 完成' : 'result 阻塞')
	return ok ? '完成' : '阻塞'
}

function sendReq(from: string, to: string, key: string) {
	return {
		client: 'conet-beamio-api',
		array: 'chat_index_pointer',
		chainId: CHAIN_ID,
		candidates: [from],
		from,
		to,
		data: '0x1234',
		value: 0n,
		gasLimit: 21_000n,
		maxInflightPerKey: 4,
		skipSimulation: true,
		idempotencyKey: key,
	}
}

function reset(state: StubState): void {
	state.methods.length = 0
	state.sends.length = 0
	state.balances.clear()
	state.pendingNonce.clear()
	state.latestNonce.clear()
	state.receipts.clear()
	state.gasPrice = 1n
	state.holdNonceMs = 0
	state.holdSendMs = 0
}

async function handleRpc(state: StubState, raw: string, res: ServerResponse): Promise<void> {
	let msg: { id?: unknown; method?: string; params?: unknown[] }
	try {
		msg = JSON.parse(raw) as { id?: unknown; method?: string; params?: unknown[] }
	} catch {
		reply(res, null, null)
		return
	}
	const method = msg.method ?? ''
	state.methods.push(method)
	const block = {
		hash: `0x${'11'.repeat(32)}`,
		parentHash: `0x${'22'.repeat(32)}`,
		number: '0x1',
		timestamp: '0x1',
		nonce: '0x0000000000000000',
		difficulty: '0x0',
		gasLimit: '0x1c9c380',
		gasUsed: '0x0',
		miner: '0x0000000000000000000000000000000000000000',
		extraData: '0x',
		baseFeePerGas: null,
		transactions: [],
	}
	try {
		if (method === 'eth_chainId') return reply(res, msg.id, '0x36ca6')
		if (method === 'eth_blockNumber') return reply(res, msg.id, '0x1')
		if (method === 'eth_getBlockByNumber') return reply(res, msg.id, block)
		if (method === 'eth_gasPrice') return reply(res, msg.id, `0x${state.gasPrice.toString(16)}`)
		if (method === 'eth_maxPriorityFeePerGas') return reply(res, msg.id, '0x1')
		if (method === 'eth_call') return reply(res, msg.id, '0x')
		if (method === 'eth_estimateGas') return reply(res, msg.id, '0x5208')
		if (method === 'eth_getBalance') {
			const addr = String(msg.params?.[0] ?? '').toLowerCase()
			const bal = state.balances.get(addr) ?? 0n
			return reply(res, msg.id, `0x${bal.toString(16)}`)
		}
		if (method === 'eth_getTransactionCount') {
			if (state.holdNonceMs > 0) await delay(state.holdNonceMs)
			const addr = String(msg.params?.[0] ?? '').toLowerCase()
			const tag = String(msg.params?.[1] ?? 'latest')
			const n = tag === 'pending' ? (state.pendingNonce.get(addr) ?? 0) : (state.latestNonce.get(addr) ?? 0)
			return reply(res, msg.id, `0x${n.toString(16)}`)
		}
		if (method === 'eth_getTransactionReceipt') {
			const hash = String(msg.params?.[0] ?? '').toLowerCase()
			if (!state.receipts.get(hash)) return reply(res, msg.id, null)
			return reply(res, msg.id, {
				transactionHash: hash,
				transactionIndex: '0x0',
				blockHash: `0x${'11'.repeat(32)}`,
				blockNumber: '0x1',
				from: '0x0000000000000000000000000000000000000001',
				to: '0x0000000000000000000000000000000000000001',
				cumulativeGasUsed: '0x1',
				gasUsed: '0x1',
				effectiveGasPrice: '0x1',
				gasPrice: '0x1',
				logs: [],
				logsBloom: `0x${'00'.repeat(256)}`,
				status: '0x1',
				type: '0x0',
			})
		}
		if (method === 'eth_getTransactionByHash') return reply(res, msg.id, null)
		if (method === 'eth_sendRawTransaction') {
			if (state.holdSendMs > 0) await delay(state.holdSendMs)
			const serialized = String(msg.params?.[0] ?? '')
			const parsed = Transaction.from(serialized)
			const from = (parsed.from ?? '').toLowerCase()
			state.sends.push({ from, nonce: parsed.nonce, hash: parsed.hash ?? '' })
			const next = parsed.nonce + 1
			state.pendingNonce.set(from, Math.max(state.pendingNonce.get(from) ?? 0, next))
			return reply(res, msg.id, parsed.hash)
		}
		return reply(res, msg.id, '0x0')
	} catch (e) {
		const message = e instanceof Error ? e.message : 'stub error'
		res.setHeader('content-type', 'application/json')
		res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message } }))
	}
}

function reply(res: ServerResponse, id: unknown, result: unknown): void {
	res.setHeader('content-type', 'application/json')
	res.end(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }))
}

function histogram(methods: string[]): string {
	const counts = new Map<string, number>()
	for (const method of methods) counts.set(method, (counts.get(method) ?? 0) + 1)
	return [...counts.entries()].map(([method, count]) => `${method}=${count}`).join(' ')
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
	const start = Date.now()
	while (!pred()) {
		if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for stub rpc')
		await delay(10)
	}
}

void main().catch((e: unknown) => {
	const message = e instanceof Error ? e.message : String(e)
	const text = `time ${new Date().toISOString()}\nproductionTouched false\nfixtureCrashed ${message}\n`
	writeFileSync(EVIDENCE, text)
	process.stderr.write(text)
	process.exitCode = 1
})
