/**
 * Harness of the tick-loop e2e (test-only): one world = fake chain + beacon + signer + a state directory; runs of childMain.test.ts (the real reporter of a given checkout) against it; the child's
 * observation events (E2E_EV, see childMain.test.ts) are parsed into ticks and waits. Modelled on the P2 branch's labE2e/harness.test.ts, trimmed to what this patch needs (no WAL).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ethers } from 'ethers'
import { readSegmentedState } from '../labClPayoutStateStore'
import { FakeBeacon, FakeChain, FakeSigner, KEY_ARRAY, POOL, REDEEM, SIGNER_ADDRESS, type SentTx } from './fakeServers.test'

export const PATCHED_ROOT = path.resolve(__dirname, '../../..')
export const BASELINE_ROOT = process.env.E2E_BASELINE_ROOT ?? path.resolve(__dirname, '../../../../lab-baseline-df78e6b')
export const DEPLOY_BLOCK = 100
export const TICK_MS = 15_000
const ANSI = /\u001b\[[0-9;]*m/g
export const strip = (l: string): string => l.replace(ANSI, '').replace(/^\[(?:master|worker-[^ ]+) INFO \d+:\d+:\d+:\d+\]\s*/, '').replace(/\s+$/g, '')

export const eventKeyOf = (block: number, index: number): string => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [BigInt(block), BigInt(index)]))

export type Ev = { kind: string; t: number; attrs: Record<string, string> }
export function parseEvents(lines: string[]): Ev[] {
	const out: Ev[] = []
	for (const raw of lines) {
		const l = strip(raw)
		const m = /^E2E_EV (\S+)(.*) t=([\d.]+)$/.exec(l)
		if (!m) continue
		const attrs: Record<string, string> = {}
		for (const kv of m[2]!.trim().split(/\s+/).filter(Boolean)) {
			const i = kv.indexOf('=')
			if (i > 0) attrs[kv.slice(0, i)] = kv.slice(i + 1)
			else attrs[kv] = '1'
		}
		out.push({ kind: m[1]!, t: Number(m[3]), attrs })
	}
	return out
}

export type TickRec = { n: number; start: number; end: number; outcome: string; waitAfterRequested: number | null; waitAfterUsed: number | null; gapToNextStart: number | null }
/** Ticks of the patched code (tick-start / tick-end events) joined with the waits that follow them. */
export function ticksOf(evs: Ev[]): TickRec[] {
	const ticks: TickRec[] = []
	let cur: TickRec | undefined
	let lastWait: { requested: number; used: number } | undefined
	for (const e of evs) {
		if (e.kind === 'tick-start') {
			if (cur) cur.gapToNextStart = e.t - cur.end
			cur = { n: Number(e.attrs.n), start: e.t, end: NaN, outcome: '', waitAfterRequested: null, waitAfterUsed: null, gapToNextStart: null }
			ticks.push(cur)
			lastWait = undefined
		} else if (e.kind === 'tick-end' && cur) {
			cur.end = e.t
			cur.outcome = e.attrs.outcome ?? ''
		} else if (e.kind === 'wait-set' && cur) {
			lastWait = { requested: Number(e.attrs.requested), used: Number(e.attrs.used) }
			cur.waitAfterRequested = lastWait.requested
			cur.waitAfterUsed = lastWait.used
		}
	}
	return ticks
}

/** Ticks of the df78e6b code: it has no loop to observe, so a tick runs from the previous wait-fired (or start) to the next wait-set. */
export function ticksOfBaseline(evs: Ev[]): TickRec[] {
	const ticks: TickRec[] = []
	let startT: number | null = null
	let n = 0
	for (const e of evs) {
		if (e.kind === 'start' || e.kind === 'wait-fired') startT = e.t
		else if (e.kind === 'wait-set' && startT != null) {
			ticks.push({ n: ++n, start: startT, end: e.t, outcome: 'n/a', waitAfterRequested: Number(e.attrs.requested), waitAfterUsed: Number(e.attrs.used), gapToNextStart: null })
			startT = null
		}
	}
	return ticks
}

export function quantiles(xs: number[]): { n: number; min: number; p50: number; p90: number; p99: number; max: number; mean: number } {
	const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y)
	if (!a.length) return { n: 0, min: NaN, p50: NaN, p90: NaN, p99: NaN, max: NaN, mean: NaN }
	const q = (p: number): number => a[Math.min(a.length - 1, Math.floor(p * a.length))]!
	return { n: a.length, min: a[0]!, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: a[a.length - 1]!, mean: a.reduce((s, x) => s + x, 0) / a.length }
}

export type RunOpts = {
	env?: Record<string, string>
	/** SIGKILL the child as soon as this returns true for a signer request / child line (checked live). */
	killWhen?: (ev: { kind: 'log'; line: string } | { kind: 'signer'; method: string; params: Record<string, unknown> | undefined }) => boolean
	/** SIGTERM (graceful stop) as soon as this returns true (polled every 20 ms against the world). */
	stopWhen?: (ctx: World) => boolean
	timeoutMs?: number
}
export type RunResult = { code: number | null; signal: string | null; lines: string[]; killed: boolean; events: Ev[]; startedAtMs: number; endedAtMs: number }

export type World = {
	root: string
	dir: string
	stateFile: string
	stateDir: string
	chain: FakeChain
	beacon: FakeBeacon
	signer: FakeSigner
	labPubkeys: string[]
	runs: RunResult[]
	child?: ChildProcess
	run(o?: RunOpts): Promise<RunResult>
}

/** validator i (0..5) is a Lab validator, 6 is not. */
export function seedValidators(w: World): void {
	w.labPubkeys.forEach((pk, i) => w.beacon.validators.set(i, { pubkey: pk, status: 'active_ongoing' }))
	w.beacon.validators.set(6, { pubkey: ethers.hexlify(ethers.randomBytes(48)).toLowerCase(), status: 'active_ongoing' })
}

/** Deterministic load: every `every`-th block carries one withdrawal of a Lab validator (block % 6), amount 1_000_000 gwei + (block % 97) * 1000 gwei. */
export function synthetic(w: World, every: number): { gwei: (block: number) => bigint | null; expectedKeys: (fromBlock: number, toBlock: number) => Map<string, bigint> } {
	const gwei = (b: number): bigint | null => (b >= DEPLOY_BLOCK && b % every === 0 ? 1_000_000n + BigInt(b % 97) * 1000n : null)
	w.chain.withdrawalGen = (b) => {
		const g = gwei(b)
		return g == null ? [] : [{ index: 0, validatorIndex: b % 6, address: REDEEM, amountGwei: g }]
	}
	return {
		gwei,
		expectedKeys: (from, to) => {
			const m = new Map<string, bigint>()
			for (let b = from; b <= to; b++) {
				const g = gwei(b)
				if (g != null) m.set(eventKeyOf(b, 0).toLowerCase(), g * 1_000_000_000n)
			}
			return m
		},
	}
}

export async function withWorld<T>(name: string, root: string, baseEnv: Record<string, string>, body: (w: World) => Promise<T>): Promise<T> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `labtick-${name.replace(/[^a-z0-9]+/gi, '_').slice(0, 20)}-`))
	const chain = new FakeChain()
	const beacon = new FakeBeacon()
	const signer = new FakeSigner(chain)
	const labPubkeys: string[] = []
	for (let i = 0; i < 6; i++) labPubkeys.push(ethers.hexlify(ethers.concat([ethers.keccak256(ethers.toUtf8Bytes(`lab-pubkey-${i}`)), ethers.dataSlice(ethers.keccak256(ethers.toUtf8Bytes(`lab-pubkey-b-${i}`)), 0, 16)])).toLowerCase())
	try {
		await chain.start()
		await beacon.start()
		await signer.start(dir)
		fs.writeFileSync(path.join(dir, 'pubkeys.json'), JSON.stringify({ miningPool: POOL, pubkeys: labPubkeys }))
		fs.writeFileSync(path.join(dir, 'deny.json'), JSON.stringify({ addresses: [], sockets: [], keyArrays: [] }))
		const stateFile = path.join(dir, 'state.json')
		const stateDir = path.join(dir, 'state.v2')
		const runs: RunResult[] = []
		signer.eventKeysOf = (idem) => {
			for (let attempt = 0; attempt < 5; attempt++) {
				try {
					const rec = (readSegmentedState(stateDir) as { inFlightWithdraw?: { idempotencyKey?: string; eventKeys?: string[] } }).inFlightWithdraw
					if (rec && rec.idempotencyKey === idem && Array.isArray(rec.eventKeys)) return [...rec.eventKeys].sort()
				} catch {
					/* a generation was being replaced: read again */
				}
			}
			return []
		}
		const w: World = {
			root,
			dir,
			stateFile,
			stateDir,
			chain,
			beacon,
			signer,
			labPubkeys,
			runs,
			run: async (o = {}) => {
				const loader = process.execArgv.some((a) => a.includes('tsx')) ? process.execArgv.filter((x) => !x.startsWith('--max-old-space-size')) : ['--import', pathToFileURL(join(dirname(require.resolve('tsx/package.json')), 'dist', 'loader.mjs')).href]
				const env: NodeJS.ProcessEnv = {
					PATH: process.env.PATH ?? '',
					HOME: dir,
					NODE_ENV: 'test',
					CONET_LAB_MINING_POOL_CL_PAYOUT: '1',
					CONET_LAB_MINING_POOL_PUBKEYS_FILE: path.join(dir, 'pubkeys.json'),
					CONET_LAB_MINING_POOL_CL_PAYOUT_STATE_FILE: stateFile,
					CONET_VALIDATOR_DEPOSIT_RPC_URL: chain.url,
					CONET_VALIDATOR_BEACON_REST_URL: beacon.url,
					CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_SOCKET: signer.socketPath,
					CONET_LAB_MINING_POOL_CL_PAYOUT_KEY_ARRAY: KEY_ARRAY,
					CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_ADDRESS: SIGNER_ADDRESS,
					CONET_LAB_DENY_LIST_FILE: path.join(dir, 'deny.json'),
					CONET_LAB_MINING_POOL_CL_PAYOUT_TICK_MS: String(TICK_MS),
					CONET_LAB_MINING_POOL_CL_PAYOUT_DEPLOY_BLOCK: String(DEPLOY_BLOCK),
					CONET_LAB_MINING_POOL_CL_PAYOUT_CHUNK_BLOCKS: '32',
					CONET_LAB_MINING_POOL_CL_PAYOUT_CHUNKS_PER_TICK: '1',
					CONET_LAB_MINING_POOL_CL_PAYOUT_MAX_GAS_PRICE_WEI: '30000000',
					E2E_REPORTER_ROOT: root,
					...baseEnv,
					...(o.env ?? {}),
				}
				const child = spawn(process.execPath, [...loader, path.join(__dirname, 'childMain.test.ts')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
				w.child = child
				const lines: string[] = []
				let killed = false
				const kill = (sig: NodeJS.Signals): void => {
					if (!killed) {
						killed = true
						child.kill(sig)
					}
				}
				const onData = (d: Buffer): void => {
					for (const l of d.toString('utf8').split('\n')) {
						if (!l) continue
						lines.push(l)
						if (o.killWhen?.({ kind: 'log', line: strip(l) })) kill('SIGKILL')
					}
				}
				child.stdout.on('data', onData)
				child.stderr.on('data', onData)
				let timedOut = false
				const timer = setTimeout(() => {
					timedOut = true
					kill('SIGKILL')
				}, o.timeoutMs ?? 120_000)
				const signerCount0 = signer.requests.length
				const startedAtMs = Date.now()
				let stopSent = false
				const poll = setInterval(() => {
					if (o.killWhen) for (let i = signerCount0; i < signer.requests.length; i++) if (o.killWhen({ kind: 'signer', method: signer.requests[i]!.method, params: signer.requests[i]!.params })) kill('SIGKILL')
					if (o.stopWhen && !stopSent && o.stopWhen(w)) {
						stopSent = true
						child.kill('SIGTERM')
					}
				}, 20)
				const res = await new Promise<RunResult>((resolve) => {
					child.on('exit', (code, sig) => resolve({ code, signal: sig, lines, killed, events: [], startedAtMs, endedAtMs: Date.now() }))
				})
				clearTimeout(timer)
				clearInterval(poll)
				res.events = parseEvents(lines)
				runs.push(res)
				if (timedOut) throw new Error(`child did not finish within ${o.timeoutMs ?? 120_000} ms`)
				return res
			},
		}
		return await body(w)
	} finally {
		await signer.stop()
		await beacon.stop()
		await chain.stop()
		if (!process.env.E2E_KEEP) fs.rmSync(dir, { recursive: true, force: true })
		else process.stderr.write(`E2E_KEEP ${dir}\n`)
	}
}

/** Paid-at-most-once per event key and amounts to the wei: throws on any violation; returns the paid keys. */
export function checkPayments(sent: Iterable<SentTx>, expected: Map<string, bigint>): { paidKeys: Set<string>; txs: number } {
	const paid = new Map<string, number>()
	let txs = 0
	for (const t of sent) {
		txs++
		if (t.eventKeys.length === 0) throw new Error(`tx ${t.idempotencyKey} has no event keys (in-flight record unreadable at send time)`)
		let sum = 0n
		for (const k of t.eventKeys) {
			const kk = k.toLowerCase()
			paid.set(kk, (paid.get(kk) ?? 0) + 1)
			const want = expected.get(kk)
			if (want == null) throw new Error(`tx ${t.idempotencyKey} pays unknown event key ${k}`)
			sum += want
		}
		if (sum !== t.amountWei) throw new Error(`tx ${t.idempotencyKey}: amount ${t.amountWei} wei != sum of its keys ${sum} wei`)
	}
	for (const [k, n] of paid) if (n > 1) throw new Error(`event key ${k} paid ${n} times`)
	return { paidKeys: new Set(paid.keys()), txs }
}

export { REDEEM, POOL, FakeChain, FakeBeacon, FakeSigner }
