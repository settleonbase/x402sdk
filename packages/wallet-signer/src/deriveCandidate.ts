/**
 * Derive a minimal candidate config and policy from COPIES of the live files. Reads inputs only and writes
 * new files under --out. Never writes to the input paths. Adds only: the Lab listener, the Lab policy client
 * (from the reviewed fragment), and the pinned pmGrantAdmin allowlist. gasKeeper is left as found and must be false.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const LAB_LISTENER_PATH = '/run/wallet-signer-lab-mining-pool/lab-payout.sock'
export const LAB_PINNED_TARGET = '0xcFAF85E6C1765DA01a4Dc58C81b28Cd572067135'

export type DeriveOut = { config: string; policy: string; sha256: { config: string; policy: string; liveConfig: string; livePolicy: string }; warnings: string[] }

function sha(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function deriveCandidate(opts: { liveConfig: string; livePolicy: string; labPolicyFragment: string; labGid: number; outDir: string; labPath?: string; enableGrant?: boolean }): DeriveOut {
	const warnings: string[] = []
	for (const p of [opts.liveConfig, opts.livePolicy, opts.labPolicyFragment]) if (!existsSync(p)) throw new Error(`missing input: ${p}`)
	if (!Number.isInteger(opts.labGid) || opts.labGid <= 0) throw new Error('labGid must be a positive integer (getent group wslab)')
	// Refuse before any write: the output must not be an input location, and must not sit beside live files.
	const outAbs = resolve(opts.outDir)
	for (const input of [opts.liveConfig, opts.livePolicy, opts.labPolicyFragment]) {
		const inAbs = resolve(input)
		if (outAbs === inAbs || inAbs.startsWith(outAbs + '/')) throw new Error(`output directory would overlap input ${inAbs}`)
		const inDir = resolve(inAbs, '..')
		if (outAbs === inDir || outAbs.startsWith(inDir + '/')) throw new Error(`output directory lies inside the input tree ${inDir}`)
	}
	if (existsSync(join(outAbs, 'config.json')) || existsSync(join(outAbs, 'policy.json'))) throw new Error('output already contains config.json or policy.json; refusing to overwrite')
	const before = { c: sha(opts.liveConfig), p: sha(opts.livePolicy) }
	const cfg = JSON.parse(readFileSync(opts.liveConfig, 'utf8')) as Record<string, any>
	const pol = JSON.parse(readFileSync(opts.livePolicy, 'utf8')) as { version: number; clients: Record<string, unknown> }
	const frag = JSON.parse(readFileSync(opts.labPolicyFragment, 'utf8')) as Record<string, any>
	const labClient = frag['lab-mining-pool'] ?? frag.clients?.['lab-mining-pool']
	if (!labClient) throw new Error('fragment has no lab-mining-pool client')
	if (cfg.gasKeeper?.enabled === true) throw new Error('live gasKeeper.enabled is true: candidate requires false (owner decision pending)')
	if (cfg.pmOneShot !== undefined) warnings.push('pmOneShot block present in live config: kept unchanged, owner decision pending (B-7)')
	if (cfg.pmGrantAdmin !== undefined) throw new Error('live config already has pmGrantAdmin; refusing to overwrite it silently')
	if (cfg.rpc === undefined) cfg.rpc = {}
	cfg.rpc.unix = Array.isArray(cfg.rpc.unix) ? cfg.rpc.unix : []
	if (cfg.rpc.unix.some((u: { client?: string }) => u.client === 'lab-mining-pool')) throw new Error('live config already has a lab-mining-pool listener')
	cfg.rpc.unix.push({ path: opts.labPath ?? LAB_LISTENER_PATH, client: 'lab-mining-pool', mode: 432, gid: opts.labGid })
	if (opts.enableGrant === true) throw new Error('enableGrant is not supported by the derive tool: the deny list is private configuration')
	cfg.pmGrantAdmin = { enabled: false, targets: [LAB_PINNED_TARGET], denyAddresses: [] }
	if (pol.clients['lab-mining-pool']) throw new Error('live policy already has lab-mining-pool')
	pol.clients['lab-mining-pool'] = labClient
	mkdirSync(opts.outDir, { recursive: true })
	const cfgOut = join(resolve(opts.outDir), 'config.json')
	const polOut = join(resolve(opts.outDir), 'policy.json')
	writeFileSync(cfgOut, JSON.stringify(cfg, null, 2) + '\n')
	writeFileSync(polOut, JSON.stringify(pol, null, 2) + '\n')
	if (sha(opts.liveConfig) !== before.c || sha(opts.livePolicy) !== before.p) throw new Error('input changed during derivation')
	return { config: cfgOut, policy: polOut, sha256: { config: sha(cfgOut), policy: sha(polOut), liveConfig: before.c, livePolicy: before.p }, warnings }
}

if (require.main === module) {
	const a = process.argv.slice(2)
	const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined }
	const need = (k: string) => { const v = get(k); if (!v) { console.error(`missing ${k}`); process.exit(2) } return v as string }
	try {
		const r = deriveCandidate({ liveConfig: need('--live-config'), livePolicy: need('--live-policy'), labPolicyFragment: need('--lab-policy'), labGid: Number(need('--lab-gid')), outDir: need('--out'), labPath: get('--lab-path'), enableGrant: a.includes('--enable-grant') })
		process.stdout.write(JSON.stringify(r, null, 2) + '\n')
	} catch (e) { console.error(`refused: ${(e as Error).message}`); process.exit(1) }
}
