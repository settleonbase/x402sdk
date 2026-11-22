/**
 * P3 global RPC budget: never above the total, guaranteed share per source, round-robin beyond it, FIFO within a source, the real provider class takes a slot per HTTP request (server-side in-flight count),
 * and a source ratchet: the daemon creates exactly one provider, of the budgeted class.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { test } from 'node:test'
import { ethers } from 'ethers'
import { BudgetedJsonRpcProvider, RpcBudget, rpcSource } from './labRpcBudget'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

test('R1: never more than `total` in flight, for any workload (random sources and durations)', async () => {
	const b = new RpcBudget(5, 1)
	let live = 0
	let maxLive = 0
	let seed = 12345
	const rnd = (m: number): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % m)
	await Promise.all(
		Array.from({ length: 400 }, async (_, i) => {
			await sleep(rnd(20))
			const rel = await b.acquire(['scan', 'pay-rt', 'pay-hist', 'other'][i % 4]!)
			live++
			maxLive = Math.max(maxLive, live)
			await sleep(1 + rnd(6))
			live--
			rel()
		})
	)
	assert.ok(maxLive <= 5, `max in flight ${maxLive}`)
	assert.equal(b.stats().maxInFlight <= 5, true)
	assert.equal(b.stats().inFlight, 0)
	assert.equal(b.stats().granted, 400)
})

test('R2: a source below its guaranteed share is served before a flooding source (no starvation)', async () => {
	const b = new RpcBudget(4, 1)
	const order: string[] = []
	const holders: (() => void)[] = []
	// the flooder takes all 4 slots and queues 50 more
	for (let i = 0; i < 4; i++) holders.push(await b.acquire('flood'))
	const queued = Array.from({ length: 50 }, () => b.acquire('flood').then((r) => (order.push('flood'), r)))
	// a different source asks once: it must be next, ahead of all 50 queued flood requests as soon as a slot frees up
	const victim = b.acquire('victim').then((r) => (order.push('victim'), r))
	holders[0]!() // one slot frees up
	await sleep(5)
	assert.equal(order[0], 'victim', `first grant after the release went to ${order[0]}`)
	;(await victim)()
	for (const h of holders.slice(1)) h()
	for (const q of queued) (await q)()
	assert.equal(b.stats().inFlight, 0)
})

test('R3: beyond the guaranteed share the sources are served round-robin (three flooders get an equal share), FIFO inside a source', async () => {
	const b = new RpcBudget(3, 0)
	const held = await Promise.all([b.acquire('a'), b.acquire('a'), b.acquire('a')])
	const grants: string[] = []
	const per: Record<string, number[]> = { a: [], b: [], c: [] }
	const pend: Promise<() => void>[] = []
	for (let i = 0; i < 30; i++)
		for (const s of ['a', 'b', 'c'] as const) {
			const idx = i
			pend.push(b.acquire(s).then((r) => (grants.push(s), per[s]!.push(idx), r)))
		}
	for (const h of held) h()
	// release each grant as it comes until all are served
	let served = 0
	while (served < 90) {
		await sleep(1)
		for (const p of pend.splice(0)) p.then((r) => (served++, setTimeout(r, 0)))
		if (served >= 90) break
	}
	await sleep(20)
	const counts = { a: grants.filter((g) => g === 'a').length, b: grants.filter((g) => g === 'b').length, c: grants.filter((g) => g === 'c').length }
	assert.deepEqual(counts, { a: 30, b: 30, c: 30 })
	// within a source: FIFO
	for (const s of ['a', 'b', 'c']) assert.deepEqual(per[s], [...per[s]!].sort((x, y) => x - y), `FIFO within ${s}`)
	// the first 15 grants alternate between the sources (round-robin), not 15 of one
	const first = grants.slice(0, 15)
	for (const s of ['a', 'b', 'c']) assert.ok(first.filter((g) => g === s).length >= 4 && first.filter((g) => g === s).length <= 6, `first 15 grants: ${s} ${first.filter((g) => g === s).length}`)
})

test('R4: release is idempotent and a double release does not free a second slot', async () => {
	const b = new RpcBudget(1, 0)
	const r = await b.acquire('x')
	r()
	r()
	const second = await b.acquire('x')
	let third = false
	void b.acquire('x').then(() => (third = true))
	await sleep(5)
	assert.equal(third, false, 'only one slot exists')
	second()
	await sleep(5)
	assert.equal(third, true)
})

test('R5: the budgeted provider holds a slot for every HTTP request - server-side in-flight count never above the total, per-source counts recorded', async () => {
	let inflight = 0
	let maxInflight = 0
	const server = http.createServer((req, res) => {
		inflight++
		maxInflight = Math.max(maxInflight, inflight)
		const chunks: Buffer[] = []
		req.on('data', (c: Buffer) => chunks.push(c))
		req.on('end', () => {
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number; method: string }
			setTimeout(() => {
				res.setHeader('content-type', 'application/json')
				res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'eth_chainId' ? '0x1' : '0x10' }))
				inflight--
			}, 15)
		})
	})
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
	const url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`
	try {
		const budget = new RpcBudget(3, 1)
		const mk = (): BudgetedJsonRpcProvider => new BudgetedJsonRpcProvider(new ethers.FetchRequest(url), undefined, { staticNetwork: ethers.Network.from(1), batchMaxCount: 1 }, budget)
		const providers = [mk(), mk(), mk()]
		const jobs: Promise<unknown>[] = []
		for (const [i, name] of ['scan', 'pay-rt', 'pay-hist'].entries()) {
			for (let k = 0; k < 20; k++) jobs.push(rpcSource.run(name, () => providers[i]!.send('eth_blockNumber', []).then(() => undefined)))
		}
		await Promise.all(jobs)
		assert.ok(maxInflight <= 3, `server saw ${maxInflight} concurrent requests`)
		assert.ok(maxInflight >= 2, `the test really made requests overlap (${maxInflight})`)
		const st = budget.stats()
		assert.equal(st.granted, 60)
		for (const n of ['scan', 'pay-rt', 'pay-hist']) assert.equal(st.perSource[n]!.granted, 20, `${n} granted`)
		// no budget: unlimited (the unconfigured path is unchanged)
		const free = new BudgetedJsonRpcProvider(new ethers.FetchRequest(url), undefined, { staticNetwork: ethers.Network.from(1), batchMaxCount: 1 }, undefined)
		maxInflight = 0
		await Promise.all(Array.from({ length: 10 }, () => free.send('eth_blockNumber', [])))
		assert.ok(maxInflight >= 5, `without a budget the requests are not throttled (${maxInflight})`)
	} finally {
		server.close()
	}
})

test('R6: source ratchet - the daemon creates exactly ONE provider (the budgeted class); no other JSON-RPC client, WebSocket or direct fetch to the chain; the only fetch is the beacon REST read', () => {
	const dir = __dirname
	const reporter = fs.readFileSync(path.join(dir, 'validatorLabMiningPoolClPayoutReporter.ts'), 'utf8')
	const creations = reporter.match(/new\s+(?:ethers\.)?(?:Budgeted)?JsonRpcProvider\s*\(|new\s+ethers\.JsonRpcProvider|new\s+BudgetedJsonRpcProvider/g) ?? []
	assert.deepEqual(creations.map((c) => c.replace(/\s*\($/, '')), ['new BudgetedJsonRpcProvider'], 'one provider, budgeted')
	assert.ok(!/new\s+ethers\.JsonRpcProvider/.test(reporter), 'no plain ethers.JsonRpcProvider in the reporter')
	assert.ok(!/WebSocketProvider|new\s+WebSocket|wss?:\/\//.test(reporter.replace(/\/\/.*$/gm, '').replace(/'ws:\/\/'|'wss:\/\/'/g, '')), 'no WebSocket')
	const fetches = [...reporter.matchAll(/\bfetch\(([^,)]*)/g)].map((m) => m[1]!.trim())
	assert.deepEqual(fetches, ['url'], 'the only fetch() is the beacon REST validator read')
	// the daemon-side lab modules never build a provider either (the offline resolver tool does, and is not part of the daemon)
	for (const f of fs.readdirSync(dir).filter((x) => /^lab.*\.ts$/.test(x) && !x.endsWith('.test.ts') && x !== 'labRpcBudget.ts' && x !== 'labWalResolveInFlight.ts')) {
		assert.ok(!/JsonRpcProvider\s*\(/.test(fs.readFileSync(path.join(dir, f), 'utf8')), `${f} creates a provider`)
	}
})
