import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { getAddress, isAddress } from 'ethers'

export type ChainConfig = {
	rpcUrls: string[]
	/** Resend with the same nonce and a higher price after this long without a receipt. */
	resendAfterMs?: number
	maxResends?: number
	receiptPollMs?: number
}

export type GasKeeperChain = {
	minWei: string
	targetWei: string
	perAddressDailyWei: string
	globalDailyWei: string
	pmWarnWei: string
	pmCriticalWei: string
	/**
	 * Business wallets this chain may top up. Missing or empty tops up nobody.
	 * Registry arrays are not an implicit list. Wide pool management is a later phase.
	 */
	wallets?: string[]
	/** Explicit total budget in wei. Missing refuses every top-up on this chain. */
	budgetWei?: string
}

export type TlsListen = { host: string; port: number; cert: string; key: string; ca: string }
export type UnixListen = { path: string; client: string; mode?: number }
/**
 * Listener behind a local nginx that terminates TLS and checks the client certificate. Only here
 * are the X-WS-* identity headers trusted. Unix socket preferred; TCP only on loopback.
 */
export type ProxiedListen = {
	/** Unix socket path (preferred). */
	path?: string
	mode?: number
	/** Loopback TCP fallback: 127.0.0.1 or ::1 only. */
	host?: string
	port?: number
	/** sha256 (hex) of the X-WS-Proxy-Auth value nginx adds. Required for TCP, optional for a socket. */
	secretSha256?: string
}

export type Config = {
	/** vault.json, registry.json, gas keeper and client state. Put it on the encrypted volume. */
	dataDir: string
	/** audit.jsonl and txjournal.jsonl. Defaults to dataDir. */
	logDir: string
	/**
	 * Mount point of the encrypted volume. If set, the daemon and `wsctl init` refuse to run unless
	 * it is mounted and dataDir / logDir live under it, so nothing lands on the root disk.
	 * A directory that merely exists on the parent filesystem does not pass.
	 */
	requireMountPoint?: string
	/** Expected mount source, such as /dev/mapper/securedata. A different device does not pass. */
	requireMountSource?: string
	adminSocket: string
	/** Unix group allowed to use admin.sock (chgrp is done by systemd / tmpfiles). */
	policyFile: string
	compromisedFile: string
	rpc: { tls?: TlsListen; unix?: UnixListen[]; proxied?: ProxiedListen }
	chains: Record<string, ChainConfig>
	gasKeeper: { enabled: boolean; intervalMs: number; chains: Record<string, GasKeeperChain> }
	alerts: { webhookUrl?: string; host?: string }
	/** Fresh vaults use this scrypt N. 2^18 in production. */
	scryptN: number
	/** Wait this long for an idle key before NO_IDLE_KEY. */
	keyWaitMs: number
	/** Allows `wsctl init --unsafe-test-init` (no mnemonic display). Never set in production. */
	allowUnsafeTestInit?: boolean
}

export function loadConfig(path: string): Config {
	const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>
	if (!raw.dataDir) throw new Error('config: dataDir required')
	if (!raw.adminSocket) throw new Error('config: adminSocket required')
	if (!raw.policyFile) throw new Error('config: policyFile required')
	if (!raw.chains || Object.keys(raw.chains).length === 0) throw new Error('config: chains required')
	if (raw.rpc?.proxied) checkProxied(raw.rpc.proxied)
	return {
		dataDir: raw.dataDir,
		logDir: raw.logDir ?? raw.dataDir,
		requireMountPoint: raw.requireMountPoint || undefined,
		requireMountSource: raw.requireMountSource || undefined,
		adminSocket: raw.adminSocket,
		policyFile: raw.policyFile,
		compromisedFile: raw.compromisedFile ?? join(raw.dataDir, 'compromised.json'),
		rpc: raw.rpc ?? {},
		chains: raw.chains,
		gasKeeper: normalizeGasKeeper(raw.gasKeeper),
		alerts: raw.alerts ?? {},
		scryptN: raw.scryptN ?? 2 ** 18,
		keyWaitMs: raw.keyWaitMs ?? 30_000,
		allowUnsafeTestInit: raw.allowUnsafeTestInit === true,
	}
}

function normalizeGasKeeper(raw: Config['gasKeeper'] | undefined): Config['gasKeeper'] {
	const gk = raw ?? { enabled: false, intervalMs: 60_000, chains: {} }
	const chains: Record<string, GasKeeperChain> = {}
	for (const [id, chain] of Object.entries(gk.chains ?? {})) chains[id] = normalizeGasKeeperChain(id, chain)
	return {
		enabled: gk.enabled === true,
		intervalMs: gk.intervalMs ?? 60_000,
		chains,
	}
}

function normalizeGasKeeperChain(id: string, chain: GasKeeperChain): GasKeeperChain {
	const wallets: string[] = []
	const seen = new Set<string>()
	for (const [index, raw] of (chain.wallets ?? []).entries()) {
		if (typeof raw !== 'string' || !isAddress(raw)) throw new Error(`config: gasKeeper.chains.${id}.wallets[${index}] is not an address`)
		const addr = getAddress(raw)
		const key = addr.toLowerCase()
		if (seen.has(key)) throw new Error(`config: gasKeeper.chains.${id}.wallets repeats ${addr}`)
		seen.add(key)
		wallets.push(addr)
	}
	if (chain.budgetWei !== undefined && !/^\d+$/.test(chain.budgetWei)) {
		throw new Error(`config: gasKeeper.chains.${id}.budgetWei must be a wei integer`)
	}
	return { ...chain, wallets }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

function checkProxied(p: ProxiedListen): void {
	if (!!p.path === (p.port !== undefined)) throw new Error('config: rpc.proxied needs exactly one of path or port')
	if (p.port !== undefined) {
		if (!LOOPBACK.has(p.host ?? '')) throw new Error('config: rpc.proxied.host must be 127.0.0.1 or ::1')
		if (!p.secretSha256) throw new Error('config: rpc.proxied over TCP needs secretSha256')
	}
	if (p.secretSha256 && !/^(0x)?[0-9a-fA-F]{64}$/.test(p.secretSha256)) throw new Error('config: rpc.proxied.secretSha256 must be 32 bytes hex')
}

/**
 * Throws unless `requireMountPoint` is a mounted filesystem (different device from its parent)
 * and dataDir / logDir are inside it. Checked before anything is created or written.
 */
export function assertDataMount(c: Config): void {
	const mp = c.requireMountPoint
	if (!mp) return
	if (!isAbsolute(mp)) throw new Error('config: requireMountPoint must be absolute')
	const root = resolve(mp)
	for (const [name, dir] of [['dataDir', c.dataDir], ['logDir', c.logDir]] as const) {
		const d = resolve(dir)
		if (d !== root && !d.startsWith(`${root}/`)) throw new Error(`config: ${name} ${d} is not under requireMountPoint ${root}`)
	}
	if (!existsSync(root)) throw new Error(`encrypted volume not mounted: ${root} does not exist`)
	if (root !== '/' && statSync(root).dev === statSync(dirname(root)).dev) {
		throw new Error(`encrypted volume not mounted: ${root} is on the same filesystem as ${dirname(root)}`)
	}
	if (c.requireMountSource) {
		const actual = mountSourceOf(root)
		if (actual !== c.requireMountSource) {
			throw new Error(`encrypted volume source mismatch: ${root} is ${actual ?? 'unmounted'}, expected ${c.requireMountSource}`)
		}
	}
}

/** Longest matching mount's source device. A plain directory has no source of its own. */
export function mountSourceOf(target: string): string | undefined {
	const root = resolve(target)
	if (existsSync('/proc/self/mountinfo')) return linuxMountSource(root)
	return posixMountSource(root)
}

function linuxMountSource(target: string): string | undefined {
	const lines = readFileSync('/proc/self/mountinfo', 'utf8').split('\n')
	let best: { len: number; source: string } | undefined
	for (const line of lines) {
		const parts = line.split(' ')
		const sep = parts.indexOf('-')
		if (sep < 5 || !parts[sep + 2]) continue
		const mnt = unescapeMount(parts[4] ?? '')
		if (target !== mnt && !(mnt !== '/' && target.startsWith(`${mnt}/`))) continue
		if (!best || mnt.length >= best.len) best = { len: mnt.length, source: unescapeMount(parts[sep + 2]) }
	}
	return best?.source
}

function posixMountSource(target: string): string | undefined {
	const text = execFileSync('mount', { encoding: 'utf8' })
	let best: { len: number; source: string } | undefined
	for (const line of text.split('\n')) {
		const match = /^(.*) on (.*) \([^)]*\)$/.exec(line)
		if (!match) continue
		const source = match[1] ?? ''
		const mnt = match[2] ?? ''
		if (target !== mnt && !(mnt !== '/' && target.startsWith(`${mnt}/`))) continue
		if (!best || mnt.length >= best.len) best = { len: mnt.length, source }
	}
	return best?.source
}

function unescapeMount(value: string): string {
	return value.replace(/\\040/g, ' ').replace(/\\011/g, '\t').replace(/\\012/g, '\n').replace(/\\134/g, '\\')
}

export const paths = (c: Config) => ({
	vault: join(c.dataDir, 'vault.json'),
	registry: join(c.dataDir, 'registry.json'),
	audit: join(c.logDir, 'audit.jsonl'),
	journal: join(c.logDir, 'txjournal.jsonl'),
	typedDataReplay: join(c.logDir, 'typed-data-replay.jsonl'),
	gasState: join(c.dataDir, 'gaskeeper-state.json'),
	clientState: join(c.dataDir, 'clients-disabled.json'),
})
