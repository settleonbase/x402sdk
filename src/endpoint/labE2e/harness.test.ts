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
import { FakeBeacon, FakeChain, FakeSigner, KEY_ARRAY, POOL, REDEEM, SIGNER_ADDRESS } from './fakeServers.test'

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

export type ScenarioResult = {
	state: StateDigest | null
	signerRequests: unknown[]
	/** Number of distinct transactions (idempotency keys) per EVENT key, from the daemon's persisted in-flight record at the moment the signer received each send. */
	paymentsPerEventKey: Record<string, number>
	/** Output lines that are not the reporter's own prefixed lines (stack traces, unhandled rejections, library warnings): must be empty. */
	strayOutput: string[]
	logs: string[][]
	exits: { code: number | null; signal: string | null; killed: boolean }[]
	chainSent: { amountWei: string; idempotencyKey: string; to: string; value: string; keyArray: string; mined: boolean }[]
	unknownRpcMethods: string[]
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

export async function runScenario(s: Scenario, root = process.env.E2E_REPORTER_ROOT ?? DEFAULT_ROOT): Promise<ScenarioResult> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `labe2e-${s.name.replace(/[^a-z0-9]+/gi, '_').slice(0, 24)}-`))
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
					const st = readSegmentedState(stateDir) as { inFlightWithdraw?: { idempotencyKey?: string; eventKeys?: string[] } }
					const rec = st.inFlightWithdraw
					if (rec && rec.idempotencyKey === idem && Array.isArray(rec.eventKeys)) return [...rec.eventKeys].sort()
				} catch {
					/* a generation was being replaced: read again */
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
			run: async (o) => {
				const loader = process.execArgv.some((a) => a.includes('tsx')) ? [...process.execArgv] : ['--import', pathToFileURL(join(dirname(require.resolve('tsx/package.json')), 'dist', 'loader.mjs')).href]
				const env = childEnv({ root, dir, stateFile, stateDir, chain, beacon, signer, labPubkeys }, s.env ?? {}, o)
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
				const timer = setTimeout(kill, o.timeoutMs ?? 120_000)
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
				return res
			},
		}
		await s.body(ctx)
		const paymentsPerEventKey: Record<string, number> = {}
		for (const t of chain.sent.values()) for (const k of t.eventKeys) paymentsPerEventKey[k] = (paymentsPerEventKey[k] ?? 0) + 1
		const strayOutput: string[] = []
		for (const r of runs) for (const l of r.lines) {
			const n = normalizeLine(l)
			if (n && !/^\[(labMiningPoolClPayout|labMiningPoolClPayoutDaemon|e2e-child)\]/.test(n)) strayOutput.push(n)
		}
		return {
			state: digestState(stateDir),
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
		}
	} finally {
		await signer.stop()
		await beacon.stop()
		await chain.stop()
		if (!process.env.E2E_KEEP) fs.rmSync(dir, { recursive: true, force: true })
		else process.stderr.write(`E2E_KEEP ${dir}\n`)
	}
}

export const FIXTURE_DIR = path.join(__dirname, 'fixtures')
export function canonicalResult(r: ScenarioResult): string {
	return canonicalJson(r)
}
export { REDEEM, POOL }
