/**
 * P4 B measurement: realtime payment throughput and the realtime pending-age slope of the REAL reporter in pool mode for W = 1 / 2 / 4 realtime wallets (history wallets fixed), on a fake chain / beacon /
 * per-wallet fake signers (isolated, no real RPC, no .77, no keystore).
 *
 *   tsx src/endpoint/labPoolsMeasure/curve.test.ts --out <dir> --mode cap|slope --w 1,2,4 [--runMs 60000] [--latencyMs 19] [--sendDelayMs 150] [--receiptEmpty 3] [--blockMs 60]
 *        [--arrival 16] [--seedPending 30000] [--waitMs 600] [--histWallets 1] [--fieldFactor 100] [--budget 16]
 *
 * mode cap   (capacity, F3): a seeded REALTIME backlog (--seedPending entries beyond the freeze height, nothing new arrives, no history work): the wallets always have work, so the entries paid per second show how
 *            the throughput scales with W.
 * mode slope (field shape): arrival --arrival entries per block on a head that grows one block per --blockMs, history backlog scanned beside it; reported per W: realtime entries paid per (field) hour, pending growth,
 *            the slope of the realtime pending age (= the field log's `rt tipGap`: tip minus the block of the OLDEST realtime pending entry) and of the scan lag (head minus realtimeCursor), pause events.
 * Time is scaled: 1 real second = --fieldFactor field seconds (default 100); the wait after a scan tick (60 s in the field) is --waitMs (default 600), the per-RPC latency --latencyMs stands for the field RPC
 * latency (x100), --sendDelayMs for signing/confirmation, --receiptEmpty for the number of empty receipt asks before the receipt shows (each ask costs one poll interval). The result states these, they are not the field.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path, { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ethers } from 'ethers'
import { recoverPayoutState } from '../labPayoutRecovery'
import { writeSegmentedState } from '../labClPayoutStateStore'
import { FakeBeacon, FakeChain, FakeSigner, KEY_ARRAY, POOL, REDEEM, SIGNER_ADDRESS } from '../labE2e/fakeServers.test'

const DEPLOY_BLOCK = 100
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const ANSI = /\u001b\[[0-9;]*m/g
const strip = (l: string): string => l.replace(ANSI, '').replace(/\s+$/g, '')

export type Opts = {
	mode: 'cap' | 'slope'
	rt: number
	hist: number
	runMs: number
	latencyMs: number
	sendDelayMs: number
	receiptEmpty: number
	blockMs: number
	arrival: number
	seedPending: number
	waitMs: number
	fieldFactor: number
	budget: number
	root: string
	outDir?: string
}
type Ev = { kind: string; t: number; attrs: Record<string, string> }
function parseEvents(lines: string[]): Ev[] {
	const out: Ev[] = []
	for (const raw of lines) {
		const m = /^E2E_EV (\S+)(.*) t=([\d.]+)$/.exec(strip(raw))
		if (!m) continue
		const attrs: Record<string, string> = {}
		for (const kv of m[2]!.trim().split(/\s+/).filter(Boolean)) {
			const i = kv.indexOf('=')
			if (i > 0) attrs[kv.slice(0, i)] = kv.slice(i + 1)
		}
		out.push({ kind: m[1]!, t: Number(m[3]), attrs })
	}
	return out
}
function slope(pts: [number, number][]): number | null {
	if (pts.length < 3) return null
	const n = pts.length
	const mx = pts.reduce((s, p) => s + p[0], 0) / n
	const my = pts.reduce((s, p) => s + p[1], 0) / n
	let num = 0
	let den = 0
	for (const [x, y] of pts) {
		num += (x - mx) * (y - my)
		den += (x - mx) ** 2
	}
	return den > 0 ? num / den : null
}

export type CurveResult = {
	mode: string
	rt: number
	hist: number
	params: Record<string, unknown>
	/** realtime entries paid per real second over the steady window (second half of the run) and per field hour */
	rtPaidPerSec: number
	rtPaidPerFieldHour: number
	histPaidPerFieldHour: number
	perWallet: Record<string, { sends: number; entries: number; maxConcurrentSends: number; batchSeconds: { p50: number; p90: number } | null }>
	totalPaidEntries: number
	arrivalPerFieldHour: number | null
	pendingStart: number | null
	pendingEnd: number | null
	pendingGrowthPerFieldHour: number | null
	pendingAgeSlopePerFieldHour: number | null
	pendingAgeFirstLast: [number, number] | null
	scanLagSlopePerFieldHour: number | null
	pausedMarks: { rt: number; hist: number; firstPausedAtRealS: number | null }
	maxConcurrentRpc: number
	slotsAtEnd: number
	duplicatePaid: number
	cpuMs: number | null
	exit: number | null
	/** Scan ticks seen (progress lines), scan waits (TICK_MS timers armed) and wallet passes (admins reads on the chain side). */
	counts: { scanTicks: number; scanWaits: number; walletPasses: number }
	/** Machine 1-minute load average sampled every 5 s during the run (min / mean / max): other work on the machine stretches the timings. */
	load: { samples: number; min: number; mean: number; max: number }
}

export async function runCurve(o: Opts): Promise<CurveResult> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `labpm-${o.mode}-${o.rt}-`))
	const chain = new FakeChain()
	const beacon = new FakeBeacon()
	const poolSigners = new Map<string, FakeSigner>()
	const labPubkeys: string[] = []
	for (let i = 0; i < 6; i++) labPubkeys.push(ethers.hexlify(ethers.concat([ethers.keccak256(ethers.toUtf8Bytes(`lab-pubkey-${i}`)), ethers.dataSlice(ethers.keccak256(ethers.toUtf8Bytes(`lab-pubkey-b-${i}`)), 0, 16)])).toLowerCase())
	try {
		await chain.start()
		await beacon.start()
		labPubkeys.forEach((pk, i) => beacon.validators.set(i, { pubkey: pk, status: 'active_ongoing' }))
		fs.writeFileSync(path.join(dir, 'pubkeys.json'), JSON.stringify({ miningPool: POOL, pubkeys: labPubkeys }))
		fs.writeFileSync(path.join(dir, 'deny.json'), JSON.stringify({ addresses: [], sockets: [], keyArrays: [] }))
		const mk = (line: 'realtime' | 'history', n: number, base: number): Record<string, string>[] =>
			Array.from({ length: n }, (_, i) => ({ id: `${line === 'realtime' ? 'rt' : 'hi'}${i + 1}`, socket: '', keyArray: `lab_pm_${line}_${i + 1}`, address: `0x${(base + i).toString(16).padStart(40, '0')}`, state: 'active' }))
		const lists = { realtime: mk('realtime', o.rt, 0x1000), history: mk('history', o.hist, 0x2000) }
		for (const w of [...lists.realtime, ...lists.history]) {
			const sg = new FakeSigner(chain)
			sg.address = w.address!
			sg.sendDelayMs = o.sendDelayMs
			await sg.start(dir, `sg-${w.id}`)
			w.socket = sg.socketPath
			poolSigners.set(w.id!, sg)
		}
		fs.writeFileSync(path.join(dir, 'pools.json'), JSON.stringify(lists))
		// receipts: each transaction answers "no receipt yet" for its first `receiptEmpty` asks (a confirmation time of receiptEmpty poll intervals)
		chain.receiptRule = (_tx, ask) => (ask <= o.receiptEmpty ? 'none' : 'mined')
		chain.onRequest = async () => void (await sleep(o.latencyMs))
		const stateFile = path.join(dir, 'state.json')
		const stateDir = path.join(dir, 'state.v2')
		// the world
		const headStart = o.mode === 'cap' ? DEPLOY_BLOCK + 50 : DEPLOY_BLOCK + 4900
		chain.head = headStart
		const gwei = (b: number, i: number): bigint => 1_000_000n + BigInt((b * 31 + i * 7) % 97) * 1000n
		if (o.mode === 'slope' && o.arrival > 0) {
			chain.withdrawalGen = (b) => (b < DEPLOY_BLOCK ? [] : Array.from({ length: o.arrival }, (_, i) => ({ index: i, validatorIndex: (b * 7 + i) % 6, address: REDEEM, amountGwei: gwei(b, i) })))
			chain.startAutoHead(o.blockMs)
		}
		if (o.mode === 'cap') {
			// seeded realtime backlog: pending entries beyond the freeze height, history and realtime cursors already at the head
			const pending = Array.from({ length: o.seedPending }, (_, i) => ({
				eventKey: ethers.keccak256(ethers.toUtf8Bytes(`pm-seed-${i}`)),
				amount: String(gwei(headStart + 1 + (i >> 4), i & 15) * 1_000_000_000n),
				blockNumber: headStart + 1 + (i >> 4),
				withdrawalIndex: i & 15,
				pubkey: labPubkeys[i % 6]!,
			}))
			writeSegmentedState(stateDir, {
				lastBackfillProcessedBlock: headStart,
				historyCursor: headStart,
				realtimeCursor: headStart,
				lastLiveHeadScanned: headStart,
				freezeH: { height: headStart, hash: chain.blockHash(headStart), frozenAt: new Date().toISOString() },
				pending,
				consumedEventKeys: {},
				exitedPubkeys: {},
			} as never)
		}
		const eventKeysOf = (idem: string): string[] => {
			for (let a = 0; a < 5; a++) {
				try {
					const core = recoverPayoutState(stateDir, { readOnly: true }).core
					for (const [, r] of core.slotEntries()) if ((r as { idempotencyKey?: string }).idempotencyKey === idem) return [...((r as { eventKeys: string[] }).eventKeys)].sort()
				} catch {
					/* a snapshot or log frame was being written: read again */
				}
			}
			return []
		}
		for (const sg of poolSigners.values()) sg.eventKeysOf = eventKeysOf
		const env: NodeJS.ProcessEnv = {
			PATH: process.env.PATH ?? '',
			HOME: dir,
			NODE_ENV: 'test',
			CONET_LAB_MINING_POOL_CL_PAYOUT: '1',
			CONET_LAB_MINING_POOL_PUBKEYS_FILE: path.join(dir, 'pubkeys.json'),
			CONET_LAB_MINING_POOL_CL_PAYOUT_STATE_FILE: stateFile,
			CONET_VALIDATOR_DEPOSIT_RPC_URL: chain.url,
			CONET_VALIDATOR_BEACON_REST_URL: beacon.url,
			CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_SOCKET: poolSigners.get('rt1')!.socketPath,
			CONET_LAB_MINING_POOL_CL_PAYOUT_KEY_ARRAY: KEY_ARRAY,
			CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_ADDRESS: SIGNER_ADDRESS,
			CONET_LAB_DENY_LIST_FILE: path.join(dir, 'deny.json'),
			CONET_LAB_MINING_POOL_CL_PAYOUT_TICK_MS: '15000',
			CONET_LAB_MINING_POOL_CL_PAYOUT_DEPLOY_BLOCK: String(DEPLOY_BLOCK),
			CONET_LAB_MINING_POOL_CL_PAYOUT_CHUNK_BLOCKS: '32',
			CONET_LAB_MINING_POOL_CL_PAYOUT_CHUNKS_PER_TICK: '1',
			CONET_LAB_MINING_POOL_CL_PAYOUT_MAX_GAS_PRICE_WEI: '30000000',
			CONET_LAB_MINING_POOL_CL_PAYOUT_WAL: '1',
			CONET_LAB_MINING_POOL_CL_PAYOUT_DECOUPLED: '1',
			CONET_LAB_MINING_POOL_CL_PAYOUT_POOLS_FILE: path.join(dir, 'pools.json'),
			CONET_LAB_MINING_POOL_CL_PAYOUT_POOLS_MIN_ACTIVE: '1',
			CONET_LAB_MINING_POOL_CL_PAYOUT_MIN_VDR_BALANCE_RESERVE_WEI: '0',
			CONET_LAB_MINING_POOL_CL_PAYOUT_PAY_IDLE_MS: '50',
			CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES: '100',
			CONET_LAB_MINING_POOL_CL_PAYOUT_RPC_BUDGET_TOTAL: String(o.budget),
			CONET_LAB_MINING_POOL_CL_PAYOUT_TX_WAIT_MS: '60000',
			E2E_REPORTER_ROOT: o.root,
			E2E_WAIT_MS: String(o.waitMs),
			E2E_RUN_MS: String(o.runMs),
		}
		const loader = process.execArgv.some((a) => a.includes('tsx')) ? process.execArgv.filter((x) => !x.startsWith('--max-old-space-size')) : ['--import', pathToFileURL(join(dirname(require.resolve('tsx/package.json')), 'dist', 'loader.mjs')).href]
		const child = spawn(process.execPath, [...loader, path.join(__dirname, 'childMain.test.ts')], { cwd: o.root, env, stdio: ['ignore', 'pipe', 'pipe'] })
		const lines: string[] = []
		const onData = (d: Buffer): void => {
			for (const l of d.toString('utf8').split('\n')) if (l) lines.push(l)
		}
		child.stdout.on('data', onData)
		child.stderr.on('data', onData)
		const runStart = Number(process.hrtime.bigint() / 1_000_000n)
		const loadSamples: number[] = [os.loadavg()[0]!]
		const loadTimer = setInterval(() => loadSamples.push(os.loadavg()[0]!), 5000)
		const exit = await new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
		clearInterval(loadTimer)
		loadSamples.push(os.loadavg()[0]!)
		const evs = parseEvents(lines)
		const stateAfter = recoverPayoutState(stateDir, { readOnly: true }).core
		// ---- metrics
		const ids = [...poolSigners.keys()]
		const perWallet: CurveResult['perWallet'] = {}
		const rtSends: { tMs: number; n: number }[] = []
		const hiSends: { tMs: number; n: number }[] = []
		let dup = 0
		const seenKey = new Map<string, number>()
		for (const t of chain.sent.values()) for (const k of t.eventKeys) seenKey.set(k, (seenKey.get(k) ?? 0) + 1)
		for (const n of seenKey.values()) if (n > 1) dup++
		for (const id of ids) {
			const sg = poolSigners.get(id)!
			const gaps = sg.sends.slice(1).map((s, i) => (s.tMs - sg.sends[i]!.tMs) / 1000).sort((a, b) => a - b)
			perWallet[id] = { sends: sg.sends.length, entries: sg.sends.reduce((a, s) => a + s.n, 0), maxConcurrentSends: sg.maxConcurrentSends, batchSeconds: gaps.length ? { p50: gaps[Math.floor(gaps.length * 0.5)]!, p90: gaps[Math.floor(gaps.length * 0.9)]! } : null }
			;(id.startsWith('rt') ? rtSends : hiSends).push(...sg.sends)
		}
		const runEnd = runStart + o.runMs
		const winStart = runStart + o.runMs / 2
		const inWin = (s: { tMs: number }): boolean => s.tMs >= winStart && s.tMs <= runEnd
		const rtWin = rtSends.filter(inWin).reduce((a, s) => a + s.n, 0)
		const hiWin = hiSends.filter(inWin).reduce((a, s) => a + s.n, 0)
		const winSec = o.runMs / 2 / 1000
		const fieldHours = (sec: number): number => (sec * o.fieldFactor) / 3600
		const prog = evs.filter((e) => e.kind === 'mark' && e.attrs.kind === 'prog')
		const pts = (f: (e: Ev) => number): [number, number][] => prog.map((e) => [fieldHours(e.t / 1000), f(e)])
		const age = pts((e) => Number(e.attrs.tipGap))
		const pend = pts((e) => Number(e.attrs.pending))
		const rtMarks = evs.filter((e) => e.kind === 'mark' && e.attrs.kind === 'rt')
		const histMarks = evs.filter((e) => e.kind === 'mark' && e.attrs.kind === 'hist')
		const pausedRt = rtMarks.filter((e) => e.attrs.paused === '1')
		const pausedHist = histMarks.filter((e) => e.attrs.paused === '1')
		const firstPaused = [...pausedRt, ...pausedHist].sort((a, b) => a.t - b.t)[0]
		// scan lag: head(t) - realtime cursor after the scan; the cursor is the window's last block (the line printed after the rt mark carries blocks=a-b)
		const scanLag: [number, number][] = []
		for (let i = 0; i < lines.length; i++) {
			const m = /^E2E_EV mark kind=rt .* t=([\d.]+)$/.exec(strip(lines[i]!))
			if (!m) continue
			const b = /scan-summary line=realtime blocks=\d+-(\d+)/.exec(strip(lines[i + 1] ?? ''))
			if (!b) continue
			const t = Number(m[1])
			scanLag.push([fieldHours(t / 1000), headStart + t / o.blockMs - Number(b[1])])
		}
		const cpu = evs.find((e) => e.kind === 'summary')
		const res: CurveResult = {
			mode: o.mode,
			rt: o.rt,
			hist: o.hist,
			params: { ...o, root: undefined, outDir: undefined },
			rtPaidPerSec: rtWin / winSec,
			rtPaidPerFieldHour: rtWin / fieldHours(winSec),
			histPaidPerFieldHour: hiWin / fieldHours(winSec),
			perWallet,
			totalPaidEntries: [...seenKey.keys()].length,
			arrivalPerFieldHour: o.mode === 'slope' ? (o.arrival * 3600 * o.fieldFactor) / (o.blockMs / 1000) / o.fieldFactor : null,
			pendingStart: pend.length ? pend[0]![1] : null,
			pendingEnd: pend.length ? pend[pend.length - 1]![1] : null,
			pendingGrowthPerFieldHour: slope(pend),
			pendingAgeSlopePerFieldHour: slope(age),
			pendingAgeFirstLast: age.length ? [age[0]![1], age[age.length - 1]![1]] : null,
			scanLagSlopePerFieldHour: slope(scanLag),
			pausedMarks: { rt: pausedRt.length, hist: pausedHist.length, firstPausedAtRealS: firstPaused ? firstPaused.t / 1000 : null },
			maxConcurrentRpc: chain.maxConcurrentRpc,
			slotsAtEnd: stateAfter.slotCount,
			duplicatePaid: dup,
			cpuMs: cpu ? Number(cpu.attrs.cpuUserMs) + Number(cpu.attrs.cpuSysMs) : null,
			exit,
			counts: { scanTicks: prog.length, scanWaits: evs.filter((e) => e.kind === 'wait-set').length, walletPasses: chain.adminReads },
			load: { samples: loadSamples.length, min: Math.min(...loadSamples), mean: loadSamples.reduce((a, b) => a + b, 0) / loadSamples.length, max: Math.max(...loadSamples) },
		}
		if (o.outDir) {
			fs.mkdirSync(path.join(o.outDir, 'raw-lines'), { recursive: true })
			fs.writeFileSync(path.join(o.outDir, 'raw-lines', `${o.mode}_rt${o.rt}_hi${o.hist}.log`), lines.map(strip).join('\n') + '\n')
		}
		return res
	} finally {
		for (const sg of poolSigners.values()) await sg.stop()
		await beacon.stop()
		await chain.stop()
		if (!process.env.E2E_KEEP) fs.rmSync(dir, { recursive: true, force: true })
	}
}

const f = (x: number | null | undefined, d = 0): string => (x == null || !Number.isFinite(x) ? 'n/a' : x.toFixed(d))
export function table(rs: CurveResult[]): string {
	const rows = [['mode', 'W_rt', 'W_hist', 'rt paid/field-h', 'hist paid/field-h', 'x vs W=1', 'pend growth/h', 'pend age slope/h', 'scan lag slope/h', 'paused rt/hist', 'max RPC', 'dup paid', 'slots end', 'load mean/max']]
	const base = rs.find((r) => r.rt === 1)?.rtPaidPerFieldHour
	for (const r of rs) rows.push([r.mode, String(r.rt), String(r.hist), f(r.rtPaidPerFieldHour), f(r.histPaidPerFieldHour), base ? f(r.rtPaidPerFieldHour / base, 2) : 'n/a', f(r.pendingGrowthPerFieldHour), f(r.pendingAgeSlopePerFieldHour), f(r.scanLagSlopePerFieldHour), `${r.pausedMarks.rt}/${r.pausedMarks.hist}`, String(r.maxConcurrentRpc), String(r.duplicatePaid), String(r.slotsAtEnd), `${f(r.load.mean, 1)}/${f(r.load.max, 1)}`])
	const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)))
	return rows.map((r) => r.map((c, i) => c.padEnd(w[i]!)).join('  ')).join('\n')
}

async function cli(): Promise<void> {
	const a = process.argv.slice(2)
	const arg = (n: string, d?: string): string => {
		const i = a.indexOf(`--${n}`)
		if (i >= 0) return a[i + 1]!
		if (d === undefined) throw new Error(`--${n} required`)
		return d
	}
	const out = arg('out')
	fs.mkdirSync(out, { recursive: true })
	const ws = arg('w', '1,2,4').split(',').map(Number)
	const results: CurveResult[] = []
	for (const w of ws) {
		const o: Opts = {
			mode: arg('mode') as 'cap' | 'slope',
			rt: w,
			hist: Number(arg('histWallets', '1')),
			runMs: Number(arg('runMs', '60000')),
			latencyMs: Number(arg('latencyMs', '19')),
			sendDelayMs: Number(arg('sendDelayMs', '150')),
			receiptEmpty: Number(arg('receiptEmpty', '3')),
			blockMs: Number(arg('blockMs', '60')),
			arrival: Number(arg('arrival', '16')),
			seedPending: Number(arg('seedPending', '30000')),
			waitMs: Number(arg('waitMs', '600')),
			fieldFactor: Number(arg('fieldFactor', '100')),
			budget: Number(arg('budget', '16')),
			root: arg('root', path.resolve(__dirname, '../../..')),
			outDir: out,
		}
		console.log(`[curve] mode=${o.mode} W_rt=${w} W_hist=${o.hist} start ${new Date().toISOString()} load=${os.loadavg().map((x) => x.toFixed(2)).join('/')}`)
		results.push(await runCurve(o))
	}
	fs.writeFileSync(path.join(out, 'curve.json'), JSON.stringify({ writtenAtUtc: new Date().toISOString(), results }, null, 2) + '\n')
	const t = table(results)
	fs.writeFileSync(path.join(out, 'curve.txt'), t + '\n')
	console.log(t)
}

if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
	void cli().catch((e) => {
		console.error(e)
		process.exit(1)
	})
}
