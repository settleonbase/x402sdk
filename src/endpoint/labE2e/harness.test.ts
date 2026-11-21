/**
 * P2c-0 fixture: runs scenarios against a reporter checkout (E2E_REPORTER_ROOT, default = this checkout), collects what is observable from outside and reduces it to a normalized,
 * comparable "result". Test-only (excluded from the production build).
 *
 * Normalization (every rule is listed here; nothing else is relaxed): ANSI colour codes and the logger's wall-clock prefix are removed from log lines; ISO timestamps become <ts>; the
 * state's wall-clock scalars (updatedAt, createdAt, gasWaitStartedAt) become <ts>; generation directory names and the manifest's writtenAt/generation ids are dropped (the content files
 * are digested by their bytes); durations such as "12s/300s", "force in 20s" and "gas wait 600s ≥ 60s" become <dur> (they derive from Date.now minus a seeded start). Numbers, hashes, keys, amounts, order and counts are NOT normalized.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ethers } from 'ethers'
import { canonicalJson, readManifest, readSegmentedState, writeSegmentedState } from '../labClPayoutStateStore'
import { recoverPayoutState } from '../labPayoutRecovery'
import { WalWriter } from '../labWal'
import { FakeBeacon, FakeChain, FakeSigner, KEY_ARRAY, POOL, REDEEM, SIGNER_ADDRESS, type SentTx } from './fakeServers.test'

export const DEFAULT_ROOT = path.resolve(__dirname, '../../..')

export type RunOpts = {
	ticks: number
	/** Extra environment for this run (overrides the scenario defaults). */
	env?: Record<string, string>
	/** Kill the child with SIGKILL when this returns true for a log line / signer request (checked live). */
	killWhen?: (ev: { kind: 'log'; line: string } | { kind: 'signer'; method: string; params: Record<string, unknown> | undefined }) => boolean
	/** Give up after this long (ms). */
	timeoutMs?: number
}

export type RunResult = { code: number | null; signal: string | null; lines: string[]; killed: boolean }

export type Ctx = {
	root: string
	dir: string
	stateFile: string
	stateDir: string
	chain: FakeChain
	beacon: FakeBeacon
	signer: FakeSigner
	labPubkeys: string[]
	runs: RunResult[]
	/** The child that is running right now (fault hooks use it to kill it at an exact point). */
	currentChild?: ChildProcess
	run(o: RunOpts): Promise<RunResult>
	/** Write an initial v2 state (a state the daemon found on disk, e.g. after a rollback or an earlier run). */
	seedState(state: Record<string, unknown>): void
	/** Change scalars of the state BETWEEN runs, whichever layout it has: a whole-state rewrite for a version 2 state, one appended log event for a WAL state. */
	patchScalars(patch: Record<string, unknown>): Promise<void>
}

const ANSI = /\u001b\[[0-9;]*m/g
export function normalizeLine(raw: string): string {
	return raw
		.replace(ANSI, '')
		.replace(/^\[(?:master|worker-[^ ]+) INFO \d+:\d+:\d+:\d+\]\s*/, '')
		.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<ts>')
		.replace(/\b\d+s\/\d+s\b/g, '<dur>')
		.replace(/force in \d+s/g, 'force in <dur>')
		.replace(/gas wait \d+s ≥ \d+s/g, 'gas wait <dur> ≥ <dur>')
		.replace(/\s+$/g, '')
}

/** Lines that carry meaning for the comparison (everything the reporter logs under its own prefix, plus the child's own markers). */
export function keyLines(lines: string[]): string[] {
	return lines.map(normalizeLine).filter((l) => l.startsWith('[labMiningPoolClPayout]') || l.startsWith('[labMiningPoolClPayoutDaemon]') || l.startsWith('[e2e-child]'))
}

export function sha256(b: Buffer | string): string {
	return createHash('sha256').update(b).digest('hex')
}

const TS_SCALARS = new Set(['updatedAt', 'gasWaitStartedAt', 'frozenAt'])
function normalizeScalars(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(normalizeScalars)
	if (v && typeof v === 'object') {
		const o: Record<string, unknown> = {}
		for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = TS_SCALARS.has(k) || k === 'createdAt' ? '<ts>' : normalizeScalars(x)
		return o
	}
	return v
}

export type StateDigest = { files: Record<string, string>; manifest: unknown; scalars: unknown; pending: unknown[]; consumed: string[]; exited: string[] }
export function digestState(stateDir: string): StateDigest | null {
	if (!fs.existsSync(path.join(stateDir, 'manifest.json'))) return null
	const m = readManifest(stateDir)
	const st = readSegmentedState(stateDir) as Record<string, unknown>
	const { pending, consumedEventKeys, exitedPubkeys, ...scalars } = st as { pending: unknown[]; consumedEventKeys: Record<string, true>; exitedPubkeys: Record<string, true> } & Record<string, unknown>
	const files: Record<string, string> = {}
	for (const seg of m.pending.segments) files[`pending/${seg.file}`] = sha256(fs.readFileSync(path.join(stateDir, m.generation, seg.file)))
	files['consumed.jsonl'] = sha256(fs.readFileSync(path.join(stateDir, m.generation, 'consumed.jsonl')))
	files['exited.jsonl'] = sha256(fs.readFileSync(path.join(stateDir, m.generation, 'exited.jsonl')))
	const { writtenAt: _w, generation: _g, previousGeneration: _p, scalarsSha256: _s, ...manifestRest } = m as unknown as Record<string, unknown>
	void _w
	void _g
	void _p
	void _s
	const normScalars = normalizeScalars(scalars)
	return {
		files,
		manifest: { ...manifestRest, scalars: normScalars },
		scalars: normScalars,
		pending: (pending as { eventKey: string }[]).slice().sort((a, b) => (a.eventKey < b.eventKey ? -1 : 1)),
		consumed: Object.keys(consumedEventKeys),
		exited: Object.keys(exitedPubkeys),
	}
}

/** The logical state, whichever layout it is on disk (version 2 snapshot or WAL): what the daemon would recover. Wall-clock scalars are placeholders as everywhere. */
export function digestLogical(stateDir: string): { scalars: unknown; pending: unknown[]; consumed: string[]; exited: string[] } | null {
	if (!fs.existsSync(path.join(stateDir, 'manifest.json'))) return null
	const rec = recoverPayoutState(stateDir, { readOnly: true })
	const c = rec.core
	const scalars = c.scalarsCopy() as Record<string, unknown>
	const inflight = c.getInFlight()
	if (inflight) scalars.inFlightWithdraw = JSON.parse(JSON.stringify(inflight))
	return {
		scalars: normalizeScalars(scalars),
		pending: [...c.pendingEntries()].map((e) => ({ ...e })).sort((a, b) => (a.eventKey < b.eventKey ? -1 : 1)),
		consumed: [...c.consumedKeys()],
		exited: [...c.exited.keys()],
	}
}

export function digestLayout(stateDir: string): { manifestVersion: number | null; walSegments: number } {
	let manifestVersion: number | null = null
	try {
		manifestVersion = (JSON.parse(fs.readFileSync(path.join(stateDir, 'manifest.json'), 'utf8')) as { version: number }).version
	} catch {
		manifestVersion = null
	}
	let walSegments = 0
	try {
		walSegments = fs.readdirSync(path.join(stateDir, 'wal')).length
	} catch {
		walSegments = 0
	}
	return { manifestVersion, walSegments }
}

export type ScenarioResult = {
	state: StateDigest | null
	/** Only set in WAL runs (the file-level digest does not apply to a log). */
	logical?: ReturnType<typeof digestLogical>
	/** WAL runs: what is on disk at the end (a graceful stop leaves a version 2 manifest and an empty wal/). */
	layout?: { manifestVersion: number | null; walSegments: number }
	signerRequests: unknown[]
	/** Number of distinct transactions (idempotency keys) per EVENT key, from the daemon's persisted in-flight record at the moment the signer received each send. */
	paymentsPerEventKey: Record<string, number>
	/** Output lines that are not the reporter's own prefixed lines (stack traces, unhandled rejections, library warnings): must be empty. */
	strayOutput: string[]
	logs: string[][]
	exits: { code: number | null; signal: string | null; killed: boolean }[]
	chainSent: { amountWei: string; idempotencyKey: string; to: string; value: string; keyArray: string; mined: boolean }[]
	unknownRpcMethods: string[]
	/** Not part of the compared result (stripped by the caller): the RPC method sequence, for diagnosing a mismatch. */
	rpcLog?: string[]
}

export type Scenario = {
	name: string
	env?: Record<string, string>
	/** Builds the world (blocks, withdrawals, validators) and runs the child process(es). */
	body: (ctx: Ctx) => Promise<void>
}

function childEnv(ctx: Pick<Ctx, 'root' | 'dir' | 'stateFile' | 'stateDir' | 'chain' | 'beacon' | 'signer' | 'labPubkeys'>, base: Record<string, string>, o: RunOpts): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH ?? '',
		HOME: ctx.dir,
		NODE_ENV: 'test',
		CONET_LAB_MINING_POOL_CL_PAYOUT: '1',
		CONET_LAB_MINING_POOL_PUBKEYS_FILE: path.join(ctx.dir, 'pubkeys.json'),
		CONET_LAB_MINING_POOL_CL_PAYOUT_STATE_FILE: ctx.stateFile,
		CONET_VALIDATOR_DEPOSIT_RPC_URL: ctx.chain.url,
		CONET_VALIDATOR_BEACON_REST_URL: ctx.beacon.url,
		CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_SOCKET: ctx.signer.socketPath,
		CONET_LAB_MINING_POOL_CL_PAYOUT_KEY_ARRAY: KEY_ARRAY,
		CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_ADDRESS: SIGNER_ADDRESS,
		CONET_LAB_DENY_LIST_FILE: path.join(ctx.dir, 'deny.json'),
		CONET_LAB_MINING_POOL_CL_PAYOUT_TICK_MS: '15000',
		CONET_LAB_MINING_POOL_CL_PAYOUT_DEPLOY_BLOCK: '100',
		CONET_LAB_MINING_POOL_CL_PAYOUT_CHUNK_BLOCKS: '10',
		CONET_LAB_MINING_POOL_CL_PAYOUT_CHUNKS_PER_TICK: '4',
		CONET_LAB_MINING_POOL_CL_PAYOUT_MAX_GAS_PRICE_WEI: '30000000',
		E2E_REPORTER_ROOT: ctx.root,
		E2E_TICKS: String(o.ticks),
		...base,
		...(o.env ?? {}),
	}
}

export async function runScenario(s: Scenario, root = process.env.E2E_REPORTER_ROOT ?? DEFAULT_ROOT, opts: { walMode?: boolean } = {}): Promise<ScenarioResult> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `labe2e-${s.name.replace(/[^a-z0-9]+/gi, '_').slice(0, 24)}-`))
	const chain = new FakeChain()
	const beacon = new FakeBeacon()
	const signer = new FakeSigner(chain)
	const labPubkeys: string[] = []
	const baseEnv: Record<string, string> = { ...(s.env ?? {}), ...(opts.walMode ? { CONET_LAB_MINING_POOL_CL_PAYOUT_WAL: '1' } : {}) }
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
					const rec = readInFlightRecord(stateDir)
					if (rec && rec.idempotencyKey === idem && Array.isArray(rec.eventKeys)) return [...rec.eventKeys].sort()
				} catch {
					/* a generation was being replaced or a log frame was being written: read again */
				}
			}
			return []
		}
		const ctx: Ctx = {
			root,
			dir,
			stateFile,
			stateDir,
			chain,
			beacon,
			signer,
			labPubkeys,
			runs,
			seedState: (state) => void writeSegmentedState(stateDir, state),
			patchScalars: async (patch) => {
				const walPresent = (() => {
					try {
						return fs.readdirSync(path.join(stateDir, 'wal')).length > 0 || (JSON.parse(fs.readFileSync(path.join(stateDir, 'manifest.json'), 'utf8')) as { version?: number }).version === 3
					} catch {
						return false
					}
				})()
				if (!walPresent) {
					const st = readSegmentedState(stateDir) as Record<string, unknown>
					writeSegmentedState(stateDir, { ...st, ...patch })
					return
				}
				const rec = recoverPayoutState(stateDir, { readOnly: true })
				const w = new WalWriter({ stateDir, lastSeq: rec.writerLastSeq })
				await w.append('test-patch', [{ op: 'scalarsSet', patch }]).durable
				await w.close()
			},
			run: async (o) => {
				const loader = process.execArgv.some((a) => a.includes('tsx')) ? [...process.execArgv] : ['--import', pathToFileURL(join(dirname(require.resolve('tsx/package.json')), 'dist', 'loader.mjs')).href]
				const env = childEnv({ root, dir, stateFile, stateDir, chain, beacon, signer, labPubkeys }, baseEnv, o)
				const child = spawn(process.execPath, [...loader, path.join(__dirname, 'childMain.test.ts')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
				ctx.currentChild = child
				const lines: string[] = []
				let killed = false
				const kill = (): void => {
					if (!killed) {
						killed = true
						child.kill('SIGKILL')
					}
				}
				const onData = (d: Buffer): void => {
					for (const l of d.toString('utf8').split('\n')) {
						if (!l) continue
						lines.push(l)
						if (o.killWhen?.({ kind: 'log', line: normalizeLine(l) })) kill()
					}
				}
				child.stdout.on('data', onData)
				child.stderr.on('data', onData)
				const prevHook = { before: signer.beforeRecord, after: signer.afterRecord }
				void prevHook
				let timedOut = false
				const timer = setTimeout(() => {
					timedOut = true
					kill()
				}, o.timeoutMs ?? 120_000)
				const signerCount0 = signer.requests.length
				const poll = setInterval(() => {
					if (!o.killWhen) return
					for (let i = signerCount0; i < signer.requests.length; i++) {
						const r = signer.requests[i]!
						if (o.killWhen({ kind: 'signer', method: r.method, params: r.params })) kill()
					}
				}, 5)
				const res = await new Promise<RunResult>((resolve) => {
					child.on('exit', (code, sig) => resolve({ code, signal: sig, lines, killed }))
				})
				clearTimeout(timer)
				clearInterval(poll)
				runs.push(res)
				// G3: a run that never finished (timer compression not recognised, or a hang) is an error, not a quiet result
				if (timedOut) throw new Error(`the child did not finish within ${o.timeoutMs ?? 120_000} ms: the tick timer was probably not compressed (renamed scheduler?) or the reporter hung`)
				const done = lines.some((l) => normalizeLine(l).startsWith('[e2e-child] E2E_DONE'))
				const compressed = lines.map((l) => /\[e2e-child\] compressed=(\d+) requested=(\d+)/.exec(normalizeLine(l))).find((m) => m)
				if (done && o.ticks > 1 && (!compressed || Number(compressed[1]) < 1)) throw new Error('the run finished but no tick timer was compressed: the scheduler detection no longer matches the reporter')
				return res
			},
		}
		await s.body(ctx)
		const paymentsPerEventKey = paymentsPerEventKeyOf(chain.sent.values())
		assertPaidAtMostOnce(chain.sent.values())
		const strayOutput: string[] = []
		for (const r of runs) for (const l of r.lines) {
			const n = normalizeLine(l)
			if (n && !/^\[(labMiningPoolClPayout|labMiningPoolClPayoutDaemon|e2e-child)\]/.test(n)) strayOutput.push(n)
		}
		return {
			state: opts.walMode ? null : digestState(stateDir),
			...(opts.walMode ? { logical: digestLogical(stateDir), layout: digestLayout(stateDir) } : {}),
			signerRequests: signer.requests.filter((r) => r.method === 'signer_sendTransaction').map((r) => {
				const p = r.params as Record<string, unknown>
				return { keyArray: p.keyArray, chainId: p.chainId, to: p.to, data: p.data, value: p.value, gasLimit: p.gasLimit, idempotencyKey: p.idempotencyKey, requestFingerprint: p.requestFingerprint }
			}),
			paymentsPerEventKey,
			strayOutput,
			logs: runs.map((r) => keyLines(r.lines)),
			exits: runs.map((r) => ({ code: r.code, signal: r.signal, killed: r.killed })),
			chainSent: [...chain.sent.values()].map((t) => ({ amountWei: t.amountWei.toString(), idempotencyKey: t.idempotencyKey, to: t.to, value: t.value, keyArray: t.keyArray, mined: t.mined })),
			unknownRpcMethods: [...new Set(chain.unknownMethods)],
			rpcLog: chain.rpcLog,
		}
	} finally {
		await signer.stop()
		await beacon.stop()
		await chain.stop()
		if (!process.env.E2E_KEEP) fs.rmSync(dir, { recursive: true, force: true })
		else process.stderr.write(`E2E_KEEP ${dir}\n`)
	}
}

/**
 * The in-flight withdrawal record as the daemon has persisted it (review G2): from a version 2 state through the plain reader, and - when a WAL exists (wal/ not empty) or the manifest is
 * version 3 - through the WAL-aware read-only recovery, because the plain reader refuses a version 3 manifest and the intent event is in the log, not in a snapshot.
 */
export function readInFlightRecord(stateDir: string): { idempotencyKey?: string; eventKeys?: string[] } | null {
	const walDir = path.join(stateDir, 'wal')
	let walPresent = false
	try {
		walPresent = fs.readdirSync(walDir).length > 0
	} catch {
		walPresent = false
	}
	let v3 = false
	try {
		v3 = (JSON.parse(fs.readFileSync(path.join(stateDir, 'manifest.json'), 'utf8')) as { version?: number }).version === 3
	} catch {
		v3 = false
	}
	if (walPresent || v3) return recoverPayoutState(stateDir, { readOnly: true }).core.getInFlight() as { idempotencyKey?: string; eventKeys?: string[] } | null
	return (readSegmentedState(stateDir) as { inFlightWithdraw?: { idempotencyKey?: string; eventKeys?: string[] } }).inFlightWithdraw ?? null
}

/** Number of distinct transactions per EVENT key. */
export function paymentsPerEventKeyOf(sent: Iterable<Pick<SentTx, 'eventKeys'>>): Record<string, number> {
	const out: Record<string, number> = {}
	for (const t of sent) for (const k of t.eventKeys) out[k] = (out[k] ?? 0) + 1
	return out
}

/**
 * The "paid at most once" check, and the guard against it being blind (review G1): every sent transaction must have a NON-EMPTY event-key list (an empty list would mean the state could not
 * be read at send time, which would hide a double payment), and no event key may appear in two transactions. Throws on any violation.
 */
export function assertPaidAtMostOnce(sent: Iterable<Pick<SentTx, 'eventKeys' | 'idempotencyKey'>>): void {
	const list = [...sent]
	for (const t of list) if (t.eventKeys.length === 0) throw new Error(`transaction ${t.idempotencyKey} has no event keys: the persisted in-flight record could not be read at send time, so a double payment would go unnoticed`)
	for (const [k, n] of Object.entries(paymentsPerEventKeyOf(list))) if (n > 1) throw new Error(`event key ${k} was paid by ${n} transactions (at most once is required)`)
}

export const FIXTURE_DIR = path.join(__dirname, 'fixtures')
export function canonicalResult(r: ScenarioResult): string {
	return canonicalJson(r)
}
export { REDEEM, POOL }
