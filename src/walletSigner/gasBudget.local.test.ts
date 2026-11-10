/**
 * Local HTTP checks for the daily gas budget and stuck-tx fee bumps.
 * The chain is a mock on 127.0.0.1. Keys exist only in a temporary test vault.
 */
import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Interface, Transaction } from 'ethers'
import type { Config } from '../../packages/wallet-signer/src/config'
import { mnemonicToEntropyBytes, newMnemonic } from '../../packages/wallet-signer/src/hd'
import { startRpcServers } from '../../packages/wallet-signer/src/rpcServer'
import { SignerService } from '../../packages/wallet-signer/src/service'
import { createVaultJson } from '../../packages/wallet-signer/src/vault'
import { CHAT_POINTER_CONTRACT_PLACEHOLDER, CHAT_POINTER_METHOD } from './chatPointerRelayGate'

const EXAMPLE = join(process.cwd(), 'packages/wallet-signer/deploy/policy.example.json')
const CLIENT = 'conet-beamio-api'
const REGISTRY = CHAT_POINTER_CONTRACT_PLACEHOLDER
const pointerData = new Interface([`function ${CHAT_POINTER_METHOD}`]).encodeFunctionData('setPointerWithSig', [
	'0x0000000000000000000000000000000000000001',
	`0x${'11'.repeat(32)}`,
	1n,
	1n,
	0n,
	`0x${'ab'.repeat(65)}`,
])

type Rpc = { result?: { hash?: string; duplicate?: boolean; nonce?: number; status?: string; resends?: number; hashes?: string[]; id?: string }; error?: { code?: number; message?: string } }

test('daily gas budget is reserved before broadcast and survives restart', async () => {
	const gasPrice = '0x1'
	const raws: string[] = []
	const harness = await boot({ budget: '100', capGwei: 100, maxResends: 1, resendAfterMs: 60_000, gasPrice, raws })
	try {
		const address = await harness.address()
		await harness.replaceJournal(yesterdaySpend(address))
		const restarted = await harness.reopen()
		const first = await restarted.send('boundary', '100')
		assert.equal(first.error, undefined)
		assert.equal(raws.length, 1)
		const over = await restarted.send('over-by-one', '100')
		assert.equal(over.error?.code, -32004)
		assert.match(over.error?.message ?? '', /daily gas budget/)
		assert.equal(raws.length, 1)
		restarted.reloadBudget('200')
		const raced = await Promise.all([restarted.send('race-a', '100'), restarted.send('race-b', '100')])
		assert.equal(raced.filter((row) => row.error?.code === -32004).length, 1)
		assert.equal(raced.filter((row) => row.result?.hash).length, 1)
		assert.equal(raws.length, 2)
		const again = await restarted.reopen()
		const blocked = await again.send('after-restart', '100')
		assert.equal(blocked.error?.code, -32004)
		assert.equal(raws.length, 2)
	} finally {
		await harness.close()
	}
})

test('a stuck transaction bumps the same nonce once, then stops at maxResends', async () => {
	const raws: string[] = []
	const mined = new Set<string>()
	const harness = await boot({ budget: '100000', capGwei: 100, maxResends: 1, resendAfterMs: 40, gasPrice: '0x1', raws, mined })
	try {
		const sent = await harness.send('bump-once', '100')
		assert.equal(sent.error, undefined)
		harness.svc.txm.start()
		await wait(160)
		const txs = unique(raws).map((raw) => Transaction.from(raw))
		assert.equal(txs.length, 2)
		assert.equal(txs[0]!.nonce, txs[1]!.nonce)
		assert.equal(txs[1]!.gasPrice, 2n)
		assert.ok((txs[1]!.gasPrice ?? 0n) <= 100n * 1_000_000_000n)
		await wait(160)
		assert.equal(unique(raws).length, 2)
		mined.add(txs[1]!.hash!)
		await wait(400)
		const looked = await harness.lookup('bump-once')
		assert.equal(looked.result?.status, 'mined')
		assert.equal(looked.result?.resends, 1)
		assert.equal(looked.result?.nonce, Number(txs[0]!.nonce))
		const replay = await harness.send('bump-once', '100')
		assert.equal(replay.result?.duplicate, true)
		assert.equal(replay.result?.hash, looked.result?.hash)
		const reopened = await harness.reopen()
		const after = await reopened.send('bump-once', '100')
		assert.equal(after.result?.duplicate, true)
		assert.equal(after.result?.hash, looked.result?.hash)
		assert.equal(unique(raws).length, 2)
	} finally {
		await harness.close()
	}
})

test('a price bump that would exceed the daily budget is not broadcast', async () => {
	const raws: string[] = []
	const harness = await boot({ budget: '100', capGwei: 100, maxResends: 5, resendAfterMs: 40, gasPrice: '0x1', raws })
	try {
		const sent = await harness.send('bump-blocked', '100')
		assert.equal(sent.error, undefined)
		harness.svc.txm.start()
		await wait(180)
		assert.equal(unique(raws).length, 1)
		assert.ok(audit(harness.dir).includes('tx.resend.budget'))
		const looked = await harness.lookup('bump-blocked')
		assert.equal(looked.result?.status, 'sent')
		assert.equal(looked.result?.resends, 0)
	} finally {
		await harness.close()
	}
})

test('an old pending journal without budgetWei is reserved, reconciled, and not double-sent', async () => {
	const raws: string[] = []
	const mined = new Set<string>()
	const harness = await boot({ budget: '150', capGwei: 100, maxResends: 1, resendAfterMs: 60_000, gasPrice: '0x1', raws, mined })
	try {
		const from = await harness.address()
		const legacyHash = `0x${'ab'.repeat(32)}`
		await harness.replaceJournal(legacyPending(from, { hash: legacyHash, nonce: 0, gasLimit: '100', gasPrice: '1', idempotencyKey: 'legacy-open' }))
		const raced = await Promise.all([harness.send('fresh-a', '100'), harness.send('fresh-b', '100')])
		assert.equal(raced.filter((row) => row.error?.code === -32004).length, 2)
		assert.equal(raws.length, 0)
		const replay = await harness.send('legacy-open', '100')
		assert.equal(replay.result?.duplicate, true)
		assert.equal(replay.result?.hash, legacyHash)
		assert.equal(replay.result?.nonce, 0)
		mined.add(legacyHash)
		harness.svc.txm.start()
		await wait(120)
		const looked = await harness.lookup('legacy-open')
		assert.equal(looked.result?.status, 'mined')
		const next = await harness.send('after-receipt', '100')
		assert.equal(next.error, undefined)
		assert.equal(Transaction.from(raws[0]!).nonce, 1)
		assert.equal(raws.length, 1)
	} finally {
		await harness.close()
	}
})

test('a pending row from the previous UTC day does not consume today, and an unpriced row blocks the key', async () => {
	const raws: string[] = []
	const harness = await boot({ budget: '100', capGwei: 100, maxResends: 1, resendAfterMs: 60_000, gasPrice: '0x1', raws })
	try {
		const from = await harness.address()
		const yesterday = new Date(Date.now() - 86_400_000).toISOString()
		await harness.replaceJournal(legacyPending(from, { hash: `0x${'12'.repeat(32)}`, nonce: 4, gasLimit: '999999', gasPrice: '9', updatedAt: yesterday, createdAt: yesterday }))
		const allowed = await harness.send('today', '100')
		assert.equal(allowed.error, undefined)
		assert.equal(Transaction.from(raws[0]!).nonce, 5)
		await harness.replaceJournal(legacyPending(from, { hash: `0x${'13'.repeat(32)}`, nonce: 0, gasLimit: '100' }))
		const blocked = await harness.send('needs-price', '1')
		assert.equal(blocked.error?.code, -32004)
		assert.match(blocked.error?.message ?? '', /cannot be reconstructed/)
		assert.equal(raws.length, 1)
	} finally {
		await harness.close()
	}
})

test('json-rpc errors keep the task unless the hash is absent and the refusal is definite', async () => {
	const raws: string[] = []
	const view = { pending: 0, latest: 0, hashes: new Set<string>() }
	const plan = {
		steps: ['already-known', 'drop', 'already-known', 'nonce-low-visible', 'nonce-low-gap', 'nonce-low-gap', 'gateway', 'gateway', 'insufficient', 'insufficient', 'ok'],
	}
	const harness = await boot({
		budget: '100000',
		capGwei: 100,
		maxResends: 1,
		resendAfterMs: 60_000,
		gasPrice: '0x1',
		raws,
		view,
		plan,
	})
	try {
		const known = await harness.send('already-in-pool', '100')
		assert.equal(known.error, undefined)
		assert.equal(known.result?.nonce, 0)
		const knownAgain = await harness.send('already-in-pool', '100')
		assert.equal(knownAgain.result?.duplicate, true)
		assert.equal(knownAgain.result?.hash, known.result?.hash)
		const dropped = await harness.send('lost-then-known', '100')
		assert.equal(dropped.error, undefined)
		assert.equal(dropped.result?.nonce, 1)
		assert.equal((await harness.send('lost-then-known', '100')).result?.duplicate, true)
		const visible = await harness.send('nonce-low-but-visible', '100')
		assert.equal(visible.error, undefined)
		assert.equal(visible.result?.nonce, 2)
		const gap = await harness.send('nonce-low-gap', '100')
		assert.equal(gap.error?.code, -32011)
		assert.match(gap.error?.message ?? '', /broadcast uncertain/)
		const gapAgain = await harness.send('nonce-low-gap', '100')
		assert.equal(gapAgain.result?.duplicate, true)
		assert.equal(gapAgain.result?.nonce, 3)
		const gateway = await harness.send('gateway', '100')
		assert.match(gateway.error?.message ?? '', /broadcast uncertain/)
		assert.equal((await harness.send('gateway', '100')).result?.nonce, 4)
		const refused = await harness.send('no-funds', '100')
		assert.match(refused.error?.message ?? '', /broadcast rejected/)
		const raced = await Promise.all([harness.send('race-a', '100'), harness.send('race-b', '100')])
		assert.equal(raced.filter((row) => row.error && /broadcast rejected/.test(row.error.message ?? '')).length, 1)
		const winner = raced.find((row) => row.result?.hash)
		assert.equal(winner?.result?.nonce, 5)
		assert.equal(unique(raws).map((raw) => Transaction.from(raw).nonce).join(','), '5')
		const restarted = await harness.reopen()
		const still = await restarted.send('nonce-low-gap', '100')
		assert.equal(still.result?.duplicate, true)
		assert.equal(still.result?.hash, gapAgain.result?.hash)
		const next = await restarted.send('after-restart', '100')
		assert.equal(next.result?.nonce, 6)
	} finally {
		await harness.close()
	}
})

test('an uncertain broadcast stays reserved until the nonce occupant is identified', async () => {
	const raws: string[] = []
	const view = { pending: 0, latest: 0, hashes: new Set<string>(), failGet: 0, block: 1 }
	const plan = { steps: ['drop', 'insufficient', 'ok'] }
	const mined = new Set<string>()
	const harness = await boot({
		budget: '100000',
		capGwei: 100,
		maxResends: 1,
		resendAfterMs: 30,
		gasPrice: '0x1',
		raws,
		mined,
		view,
		plan,
	})
	try {
		const uncertain = await harness.send('uncertain', '100')
		assert.equal(uncertain.error?.code, -32011)
		assert.match(uncertain.error?.message ?? '', /broadcast uncertain/)
		const again = await harness.send('uncertain', '100')
		assert.equal(again.result?.duplicate, true)
		const open = await harness.lookup('uncertain')
		const openRow = open.result as { status?: string; hash?: string; hashes?: string[]; budgetWei?: string; nonce?: number }
		assert.equal(openRow.status, 'sent')
		assert.notEqual(openRow.budgetWei, '0')
		assert.equal(openRow.nonce, 0)
		await wait(300)
		view.hashes.add((openRow.hash ?? '').toLowerCase())
		view.latest = 1
		view.block = 2
		harness.svc.txm.start()
		await wait(120)
		const visible = await harness.lookup('uncertain')
		assert.equal((visible.result as { status?: string }).status, 'sent')
		view.failGet = 4
		view.block = 3
		await wait(400)
		assert.equal((await harness.lookup('uncertain') as { result?: { status?: string } }).result?.status, 'sent')
		view.failGet = 0
		view.hashes.clear()
		view.block = 4
		await wait(400)
		const stuck = (await harness.lookup('uncertain')).result as { status?: string; budgetWei?: string; hash?: string }
		assert.equal(stuck.status, 'stuck')
		assert.equal(stuck.budgetWei, openRow.budgetWei)
		const restarted = await harness.reopen()
		const still = await restarted.send('uncertain', '100')
		assert.equal(still.result?.duplicate, true)
		assert.equal(still.result?.hash, stuck.hash)
		const followed = await restarted.send('after-stuck', '100')
		assert.equal(followed.result?.nonce, 1)
	} finally {
		await harness.close()
	}
})

test('a known replacement receipt closes the task and an unknown occupant does not', async () => {
	const raws: string[] = []
	const view = { pending: 0, latest: 0, hashes: new Set<string>(), failGet: 0, block: 1 }
	const plan = { steps: ['ok'] }
	const mined = new Set<string>()
	const harness = await boot({
		budget: '100000',
		capGwei: 100,
		maxResends: 1,
		resendAfterMs: 30,
		gasPrice: '0x1',
		raws,
		mined,
		view,
		plan,
	})
	try {
		const sent = await harness.send('replace-me', '100')
		assert.equal(sent.error, undefined)
		await wait(300)
		harness.svc.txm.start()
		await wait(120)
		const bumped = (await harness.lookup('replace-me')).result as { status?: string; hashes?: string[]; budgetWei?: string }
		assert.equal(bumped.hashes?.length, 2)
		const replacement = bumped.hashes?.[1] ?? ''
		view.hashes.add(replacement.toLowerCase())
		view.latest = 1
		view.block = 2
		await wait(400)
		const waiting = (await harness.lookup('replace-me')).result as { status?: string; budgetWei?: string }
		assert.equal(waiting.status, 'sent')
		assert.equal(waiting.budgetWei, bumped.budgetWei)
		mined.add(replacement)
		view.block = 3
		await wait(400)
		const closed = (await harness.lookup('replace-me')).result as { status?: string; hash?: string; budgetWei?: string }
		assert.equal(closed.status, 'mined')
		assert.equal(closed.hash, replacement)
		assert.notEqual(closed.budgetWei, bumped.budgetWei)
	} finally {
		await harness.close()
	}
})

test('an explicit RPC rejection frees the nonce and an uncertain broadcast is replayed', async () => {
	const raws: string[] = []
	const fail = { left: 1 }
	const drop = { left: 0 }
	const harness = await boot({ budget: '100000', capGwei: 100, maxResends: 1, resendAfterMs: 60_000, gasPrice: '0x1', raws, failBroadcasts: fail, dropBroadcasts: drop })
	try {
		const rejected = await harness.send('rejected-once', '100')
		assert.equal(rejected.error?.code, -32011)
		assert.match(rejected.error?.message ?? '', /broadcast rejected/)
		assert.equal(raws.length, 0)
		const again = await harness.send('rejected-once', '100')
		assert.equal(again.error, undefined)
		assert.equal(again.result?.nonce, 0)
		assert.equal(Transaction.from(raws[0]!).nonce, 0)
		drop.left = 1
		const uncertain = await harness.send('dropped-once', '100')
		assert.equal(uncertain.error, undefined)
		assert.equal(uncertain.result?.nonce, 1)
		const replay = await harness.send('dropped-once', '100')
		assert.equal(replay.result?.duplicate, true)
		assert.equal(replay.result?.hash, uncertain.result?.hash)
		const txs = unique(raws).map((raw) => Transaction.from(raw))
		assert.deepEqual(txs.map((tx) => tx.nonce), [0, 1])
		const third = await harness.send('after-gap', '100')
		assert.equal(third.result?.nonce, 2)
	} finally {
		await harness.close()
	}
})

test('a fee already at maxGasPriceGwei is not replaced with a higher bid', async () => {
	const raws: string[] = []
	const harness = await boot({ budget: '100000', capGwei: 2e-9, maxResends: 5, resendAfterMs: 40, gasPrice: '0x2', raws })
	try {
		const sent = await harness.send('at-cap', '100')
		assert.equal(sent.error, undefined)
		harness.svc.txm.start()
		await wait(180)
		const txs = unique(raws).map((raw) => Transaction.from(raw))
		assert.equal(txs.length, 1)
		assert.equal(txs[0]!.gasPrice, 2n)
		assert.equal(audit(harness.dir).includes('tx.resent'), false)
	} finally {
		await harness.close()
	}
})

function unique(raws: string[]): string[] {
	return [...new Set(raws)]
}

function pooledTx(hash: string) {
	return {
		hash,
		nonce: '0x0',
		blockHash: null,
		blockNumber: null,
		transactionIndex: null,
		from: '0x0000000000000000000000000000000000000001',
		to: REGISTRY,
		value: '0x0',
		gas: '0x64',
		gasPrice: '0x1',
		input: '0x',
		type: '0x0',
		chainId: '0x36ca6',
		v: '0x1b',
		r: `0x${'11'.repeat(32)}`,
		s: `0x${'22'.repeat(32)}`,
	}
}

function audit(dir: string): string {
	try {
		return readFileSync(join(dir, 'audit.jsonl'), 'utf8')
	} catch {
		return ''
	}
}

function yesterdaySpend(from: string) {
	const updatedAt = new Date(Date.now() - 86_400_000).toISOString()
	return {
		id: `224422:${from}:99`,
		client: CLIENT,
		array: 'chat_index_pointer',
		chainId: 224422,
		from,
		to: REGISTRY,
		data: '0x',
		value: '0',
		nonce: 99,
		gasLimit: '1',
		type: 0,
		hash: `0x${'cd'.repeat(32)}`,
		hashes: [`0x${'cd'.repeat(32)}`],
		raw: '0x',
		status: 'mined',
		resends: 0,
		createdAt: updatedAt,
		updatedAt,
		lastSentAt: Date.now() - 86_400_000,
		budgetWei: '999999',
	}
}

function legacyPending(from: string, patch: Record<string, unknown>) {
	const now = new Date().toISOString()
	const hash = String(patch.hash ?? `0x${'ab'.repeat(32)}`)
	const nonce = Number(patch.nonce ?? 0)
	const { hash: _hash, nonce: _nonce, hashes: _hashes, ...rest } = patch
	return {
		...rest,
		id: `224422:${from}:${nonce}`,
		client: CLIENT,
		array: 'chat_index_pointer',
		chainId: 224422,
		from,
		to: REGISTRY,
		data: pointerData,
		value: '0',
		nonce,
		gasLimit: String(rest.gasLimit ?? '100'),
		type: 0,
		hash,
		hashes: [hash],
		raw: '0x',
		status: 'sent',
		resends: 0,
		createdAt: String(rest.createdAt ?? now),
		updatedAt: String(rest.updatedAt ?? now),
		lastSentAt: Date.now(),
		idempotencyKey: String(rest.idempotencyKey ?? 'legacy-open'),
	}
}

async function boot(opts: {
	budget: string
	capGwei: number
	maxResends: number
	resendAfterMs: number
	gasPrice: string
	raws: string[]
	mined?: Set<string>
	failBroadcasts?: { left: number }
	dropBroadcasts?: { left: number }
	view?: { pending: number; latest: number; hashes: Set<string>; failGet?: number; block?: number }
	plan?: { steps: string[] }
}) {
	const dir = mkdtempSync(join(tmpdir(), 'p5-gas-'))
	const policyPath = join(dir, 'policy.json')
	const sock = join(dir, 'rpc.sock')
	const password = `local-test-${'g'.repeat(8)}`
	writePolicy(policyPath, opts.budget, opts.capGwei)
	writeFileSync(join(dir, 'compromised.json'), '{"addresses":[]}')
	let phrase = newMnemonic()
	const entropy = mnemonicToEntropyBytes(phrase)
	phrase = ''
	writeFileSync(join(dir, 'vault.json'), await createVaultJson(entropy, password, 2 ** 12), { mode: 0o600 })
	entropy.fill(0)
	const mock = await listen(opts.gasPrice, opts.raws, opts.mined ?? new Set(), opts.failBroadcasts, opts.dropBroadcasts, opts.view, opts.plan)
	const cfg: Config = {
		dataDir: dir,
		logDir: dir,
		adminSocket: join(dir, 'admin.sock'),
		policyFile: policyPath,
		compromisedFile: join(dir, 'compromised.json'),
		rpc: { unix: [{ path: sock, client: CLIENT }] },
		chains: { '224422': { rpcUrls: [`http://127.0.0.1:${mock.port}`], resendAfterMs: opts.resendAfterMs, maxResends: opts.maxResends, receiptPollMs: 20 } },
		gasKeeper: { enabled: false, intervalMs: 60_000, chains: {} },
		alerts: {},
		scryptN: 2 ** 12,
		keyWaitMs: 300,
	}
	let svc = new SignerService(cfg)
	let servers = startRpcServers(svc, cfg.rpc)
	await waitFor(sock)
	await svc.unlock(password)
	const added = svc.arrayAdd('chat_index_pointer', 1, [224422]) as { addresses: string[] }[]
	const keyAddress = added[0]!.addresses[0]!
	const api = {
		dir,
		svc,
		async address() {
			return keyAddress
		},
		reloadBudget(budget: string) {
			writePolicy(policyPath, budget, opts.capGwei)
			svc.reloadPolicy()
		},
		async replaceJournal(row: unknown) {
			svc.txm.stop()
			await Promise.all(servers.map((server) => close(server)))
			svc.stop()
			if (exists(sock)) unlinkSync(sock)
			writeFileSync(join(dir, 'txjournal.jsonl'), `${JSON.stringify(row)}\n`)
			svc = new SignerService(cfg)
			servers = startRpcServers(svc, cfg.rpc)
			api.svc = svc
			await waitFor(sock)
			await svc.unlock(password)
		},
		async reopen() {
			svc.txm.stop()
			await Promise.all(servers.map((server) => close(server)))
			svc.stop()
			if (exists(sock)) unlinkSync(sock)
			svc = new SignerService(cfg)
			servers = startRpcServers(svc, cfg.rpc)
			api.svc = svc
			await waitFor(sock)
			await svc.unlock(password)
			return api
		},
		send(key: string, gasLimit: string) {
			return post(sock, 'signer_sendTransaction', {
				keyArray: 'chat_index_pointer',
				chainId: 224422,
				to: REGISTRY,
				data: pointerData,
				value: '0',
				gasLimit,
				idempotencyKey: key,
			})
		},
		lookup(key: string) {
			return post(sock, 'signer_getTransaction', { idempotencyKey: key })
		},
		async close() {
			svc.txm.stop()
			for (const server of servers) server.close()
			svc.stop()
			await close(mock.server)
			rmSync(dir, { recursive: true, force: true })
		},
	}
	return api
}

function exists(path: string): boolean {
	return existsSync(path)
}

function writePolicy(path: string, budget: string, capGwei: number): void {
	const file = JSON.parse(readFileSync(EXAMPLE, 'utf8')) as {
		clients: Record<string, { arrays: Record<string, { dailyGasBudgetWei?: unknown; maxGasPriceGwei?: unknown; maxInflightPerKey?: number; rate?: unknown }> }>
	}
	const grant = file.clients[CLIENT]!.arrays.chat_index_pointer!
	grant.dailyGasBudgetWei = { '224422': budget }
	grant.maxGasPriceGwei = { '224422': capGwei }
	grant.maxInflightPerKey = 8
	grant.rate = { perMinute: 1000, perDay: 100000 }
	writeFileSync(path, JSON.stringify(file))
}

function post(socketPath: string, method: string, params: unknown): Promise<Rpc> {
	const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{ socketPath, path: '/rpc', method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
			(res) => {
				const chunks: Buffer[] = []
				res.on('data', (chunk) => chunks.push(chunk as Buffer))
				res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Rpc))
			},
		)
		req.on('error', reject)
		req.end(body)
	})
}

function listen(
	gasPrice: string,
	raws: string[],
	mined: Set<string>,
	fail?: { left: number },
	drop?: { left: number },
	view?: { pending: number; latest: number; hashes: Set<string>; failGet?: number; block?: number },
	plan?: { steps: string[] },
): Promise<{ server: Server; port: number }> {
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
	const server = createServer((req, res) => {
		const chunks: Buffer[] = []
		req.on('data', (chunk) => chunks.push(chunk as Buffer))
		req.on('end', () => {
			const msg = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: unknown; method?: string; params?: unknown[] }
			const method = msg.method ?? ''
			let result: unknown = '0x0'
			const blockNo = view?.block ?? 1
			if (method === 'eth_chainId') result = '0x36ca6'
			else if (method === 'eth_blockNumber') result = `0x${blockNo.toString(16)}`
			else if (method === 'eth_getBlockByNumber') result = { ...block, number: `0x${blockNo.toString(16)}` }
			else if (method === 'eth_gasPrice') result = gasPrice
			else if (method === 'eth_getBalance') result = '0xde0b6b3a7640000'
			else if (method === 'eth_maxPriorityFeePerGas') result = gasPrice
			else if (method === 'eth_call' || method === 'eth_estimateGas') result = method === 'eth_estimateGas' ? '0x64' : '0x'
			else if (method === 'eth_getTransactionByHash') {
				if (view?.failGet && view.failGet > 0) {
					view.failGet -= 1
					res.writeHead(200, { 'content-type': 'application/json' })
					res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: 'gateway timeout' } }))
					return
				}
				const hash = String(msg.params?.[0] ?? '').toLowerCase()
				result = view?.hashes.has(hash) ? pooledTx(hash) : null
			} else if (method === 'eth_getTransactionCount') {
				const tag = String(msg.params?.[1] ?? 'latest')
				const count = tag === 'pending' ? (view?.pending ?? 0) : (view?.latest ?? 0)
				result = `0x${count.toString(16)}`
			} else if (method === 'eth_sendRawTransaction' && plan && plan.steps.length > 0) {
				const step = plan.steps.shift()
				const raw = String(msg.params?.[0] ?? '')
				const parsed = Transaction.from(raw)
				const hash = (parsed.hash ?? '').toLowerCase()
				if (step === 'ok') {
					raws.push(raw)
					if (view) view.pending = Math.max(view.pending, parsed.nonce + 1)
					result = parsed.hash
				} else if (step === 'drop') {
					res.destroy()
					return
				} else if (step === 'already-known' || step === 'nonce-low-visible') {
					view?.hashes.add(hash)
					if (view) view.pending = Math.max(view.pending, parsed.nonce + 1)
					res.writeHead(200, { 'content-type': 'application/json' })
					res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32000, message: step === 'already-known' ? 'already known' : 'nonce too low' } }))
					return
				} else if (step === 'nonce-low-gap') {
					if (view) view.pending = Math.max(view.pending, parsed.nonce + 1)
					res.writeHead(200, { 'content-type': 'application/json' })
					res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32000, message: 'nonce too low' } }))
					return
				} else if (step === 'gateway') {
					res.writeHead(200, { 'content-type': 'application/json' })
					res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: 'gateway timeout' } }))
					return
				} else {
					res.writeHead(200, { 'content-type': 'application/json' })
					res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32000, message: 'insufficient funds' } }))
					return
				}
			} else if (method === 'eth_sendRawTransaction' && drop && drop.left > 0) {
				drop.left -= 1
				res.destroy()
				return
			} else if (method === 'eth_sendRawTransaction' && fail && fail.left > 0) {
				fail.left -= 1
				res.writeHead(200, { 'content-type': 'application/json' })
				res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32000, message: 'insufficient funds' } }))
				return
			} else if (method === 'eth_sendRawTransaction') {
				const raw = String(msg.params?.[0] ?? '')
				raws.push(raw)
				result = Transaction.from(raw).hash
			} else if (method === 'eth_getTransactionReceipt') {
				const hash = String(msg.params?.[0] ?? '')
				result = mined.has(hash)
					? {
							transactionHash: hash,
							transactionIndex: '0x0',
							blockHash: `0x${'11'.repeat(32)}`,
							blockNumber: '0x1',
							from: '0x0000000000000000000000000000000000000001',
							to: REGISTRY,
							cumulativeGasUsed: '0x1',
							gasUsed: '0x1',
							gasPrice: gasPrice,
							logs: [],
							logsBloom: `0x${'00'.repeat(256)}`,
							status: '0x1',
							type: '0x0',
						}
					: null
			}
			res.writeHead(200, { 'content-type': 'application/json' })
			res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, result }))
		})
	})
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address()
			if (addr == null || typeof addr === 'string') throw new Error('mock rpc did not bind')
			resolve({ server, port: addr.port })
		})
	})
}

function waitFor(path: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`socket missing: ${path}`)), 2000)
		const poll = () => {
			if (existsSync(path)) {
				clearTimeout(timer)
				resolve()
				return
			}
			setTimeout(poll, 20)
		}
		poll()
	})
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()))
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
