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
	/** UTC-day ceiling. Not a lifetime cap. */
	globalDailyWei: string
	pmWarnWei: string
	pmCriticalWei: string
	/**
	 * Business wallets this chain may top up. Missing or empty tops up nobody.
	 * Registry arrays are not an implicit list. Wide pool management is a later phase.
	 */
	wallets?: string[]
	/** Persistent total in wei. A new UTC day does not refill it. Missing refuses every top-up. */
	budgetWei?: string
	/**
	 * Optional oracle-only ceiling, in wei per gas. Absent means this authorization
	 * has no fee cap: fees() does not reject a high market price. A live fee above
	 * the ceiling blocks the top-up and leaves the shortfall visible.
	 */
	maxFeePerGasWei?: string
}

/** One fixed Lab initial-Gas operation. Disabled and dry-run by default; no caller target is accepted. */
export type PmLabInitialGasConfig = {
	enabled: boolean
	dryRun: boolean
	maxSpendWei: string
	dailyCapWei: string
	maxFeePerGasWei: string
	/** Separate HTTPS-only read endpoints. Never shared with or used for transaction broadcast. */
	readRpcUrls: string[]
}

export type TlsListen = { host: string; port: number; cert: string; key: string; ca: string }
/** gid: numeric group applied to the socket after listen. The process must already be a member of it. */
export type UnixListen = { path: string; client: string; mode?: number; gid?: number }
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
	/** Mode of admin.sock. 0o660 (default, wsadmin group) or 0o600 (owner only, for a dedicated service). */
	adminSocketMode?: number
	/** Unix group allowed to use admin.sock (chgrp is done by systemd / tmpfiles). */
	policyFile: string
	deniedAddressesFile: string
	rpc: { tls?: TlsListen; unix?: UnixListen[]; proxied?: ProxiedListen }
	chains: Record<string, ChainConfig>
	gasKeeper: { enabled: boolean; postSignEnabled?: boolean; intervalMs: number; chains: Record<string, GasKeeperChain>; refusedOwners: string[] }
	/** PM-issued addAdmin for reviewed dedicated wallets. Off by default. */
	pmGrantAdmin?: { enabled: boolean; targets: string[]; denyAddresses?: string[]; maxGasPriceWei?: string }
	pmLabInitialGas: PmLabInitialGasConfig
	alerts: { webhookUrl?: string; host?: string }
	/** Fresh vaults use this scrypt N. 2^18 in production. */
	scryptN: number
	/** Wait this long for an idle key before NO_IDLE_KEY. */
	keyWaitMs: number
	/** Allows `wsctl init --unsafe-test-init` (no mnemonic display). Never set in production. */
	allowUnsafeTestInit?: boolean
}

/** Top-level keys this loader consumes. Any other key is refused at load time. */
const KNOWN_CONFIG_KEYS: ReadonlySet<string> = new Set([
	'dataDir', 'logDir', 'requireMountPoint', 'requireMountSource', 'adminSocket', 'adminSocketMode', 'policyFile',
	'deniedAddressesFile', 'rpc', 'chains', 'gasKeeper', 'pmGrantAdmin', 'pmLabInitialGas', 'pmOneShot', 'alerts', 'scryptN', 'keyWaitMs', 'allowUnsafeTestInit',
])

export function loadConfig(path: string): Config {
	const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>
	// Unknown top-level keys are refused by name, so a stale key never silently changes behaviour (fail closed).
	for (const key of Object.keys(raw)) {
		if (!KNOWN_CONFIG_KEYS.has(key)) throw new Error(`config: unknown top-level key "${key}"; refusing to start (fail closed)`)
	}
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
		adminSocketMode: normalizeAdminMode(raw.adminSocketMode),
		policyFile: raw.policyFile,
		deniedAddressesFile: raw.deniedAddressesFile ?? join(raw.dataDir, 'denied-addresses.json'),
		rpc: raw.rpc ?? {},
		chains: raw.chains,
		gasKeeper: normalizeGasKeeper(raw.gasKeeper),
		pmGrantAdmin: normalizePmGrant(raw.pmGrantAdmin),
		pmLabInitialGas: normalizePmLabInitialGas(raw.pmLabInitialGas),
		alerts: raw.alerts ?? {},
		scryptN: raw.scryptN ?? 2 ** 18,
		keyWaitMs: raw.keyWaitMs ?? 30_000,
		allowUnsafeTestInit: raw.allowUnsafeTestInit === true,
	}
}

function normalizePmLabInitialGas(raw: unknown): PmLabInitialGasConfig {
	if (raw === undefined) return { enabled: false, dryRun: true, maxSpendWei: '0', dailyCapWei: '0', maxFeePerGasWei: '0', readRpcUrls: [] }
	const r = raw as Partial<PmLabInitialGasConfig>
	if (typeof r.enabled !== 'boolean' || typeof r.dryRun !== 'boolean') throw new Error('config: pmLabInitialGas.enabled and dryRun must be booleans')
	for (const field of ['maxSpendWei', 'dailyCapWei', 'maxFeePerGasWei'] as const) {
		if (typeof r[field] !== 'string' || !/^\d+$/.test(r[field])) throw new Error(`config: pmLabInitialGas.${field} must be a wei integer string`)
	}
	const maxSpendWei = r.maxSpendWei!
	const dailyCapWei = r.dailyCapWei!
	const maxFeePerGasWei = r.maxFeePerGasWei!
	const readRpcUrls = r.readRpcUrls ?? []
	if (!Array.isArray(readRpcUrls) || readRpcUrls.some((url) => typeof url !== 'string')) throw new Error('config: pmLabInitialGas.readRpcUrls must be a string array')
	if (readRpcUrls.length !== 0 && readRpcUrls.length !== 2) throw new Error('config: pmLabInitialGas.readRpcUrls must be empty or contain exactly two endpoints')
	for (const url of readRpcUrls) {
		let parsed: URL
		try { parsed = new URL(url) } catch { throw new Error('config: pmLabInitialGas.readRpcUrls entries must be valid HTTPS URLs') }
		if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.hash) throw new Error('config: pmLabInitialGas.readRpcUrls entries must be credential-free HTTPS URLs without fragments')
	}
	if (readRpcUrls.length === 2 && readRpcUrls[0] === readRpcUrls[1]) throw new Error('config: pmLabInitialGas read RPC endpoints must be distinct')
	if (r.enabled && readRpcUrls.length !== 2) throw new Error('config: enabled pmLabInitialGas requires two separate readRpcUrls')
	const maxSpend = BigInt(maxSpendWei)
	const dailyCap = BigInt(dailyCapWei)
	const feeCap = BigInt(maxFeePerGasWei)
	if (maxSpend > 100_000_000_000_000_000n) throw new Error('config: pmLabInitialGas.maxSpendWei exceeds fixed 0.1 CNET target')
	if (dailyCap > 100_000_000_000_630_000n) throw new Error('config: pmLabInitialGas.dailyCapWei exceeds fixed target plus hard worst-case fee')
	if (feeCap > 30_000_000n) throw new Error('config: pmLabInitialGas.maxFeePerGasWei exceeds hard 0.03 Gwei ceiling')
	if (r.enabled && !r.dryRun && (maxSpend === 0n || dailyCap === 0n || feeCap === 0n)) throw new Error('config: live pmLabInitialGas requires non-zero spend, daily, and fee caps')
	return { enabled: r.enabled, dryRun: r.dryRun, maxSpendWei, dailyCapWei, maxFeePerGasWei, readRpcUrls }
}

function normalizeAdminMode(raw: unknown): number {
	if (raw === undefined) return 0o660
	if (raw !== 0o600 && raw !== 0o660) throw new Error('config: adminSocketMode must be 384 (0600) or 432 (0660)')
	return raw
}

function normalizePmGrant(raw: unknown): { enabled: boolean; targets: string[]; denyAddresses: string[]; maxGasPriceWei?: string } {
	if (raw === undefined) return { enabled: false, targets: [], denyAddresses: [] }
	const r = raw as { enabled?: unknown; targets?: unknown; denyAddresses?: unknown; maxGasPriceWei?: unknown }
	if (r.maxGasPriceWei !== undefined && (typeof r.maxGasPriceWei !== 'string' || !/^\d+$/.test(r.maxGasPriceWei))) throw new Error('config: pmGrantAdmin.maxGasPriceWei must be a wei integer string')
	if (typeof r.enabled !== 'boolean') throw new Error('config: pmGrantAdmin.enabled must be a boolean')
	const targets = Array.isArray(r.targets) ? r.targets : []
	const out: string[] = []
	for (const [i, t] of targets.entries()) {
		if (typeof t !== 'string' || !isAddress(t)) throw new Error(`config: pmGrantAdmin.targets[${i}] is not an address`)
		out.push(getAddress(t))
	}
	const denyRaw = Array.isArray(r.denyAddresses) ? r.denyAddresses : []
	const deny: string[] = []
	for (const [i, d] of denyRaw.entries()) {
		if (typeof d !== 'string' || !isAddress(d)) throw new Error(`config: pmGrantAdmin.denyAddresses[${i}] is not an address`)
		deny.push(getAddress(d))
	}
	if (r.enabled === true && deny.length === 0) throw new Error('config: pmGrantAdmin.denyAddresses is required when enabled (fail closed)')
	return { enabled: r.enabled, targets: out, denyAddresses: deny, ...(typeof r.maxGasPriceWei === 'string' ? { maxGasPriceWei: r.maxGasPriceWei } : {}) }
}

function normalizeGasKeeper(raw: Config['gasKeeper'] | undefined): Config['gasKeeper'] {
	const gk = raw ?? { enabled: false, intervalMs: 60_000, chains: {} }
	if ((gk as { postSignEnabled?: unknown }).postSignEnabled !== undefined && typeof (gk as { postSignEnabled?: unknown }).postSignEnabled !== 'boolean') {
		throw new Error('config: gasKeeper.postSignEnabled must be a boolean')
	}
	const chains: Record<string, GasKeeperChain> = {}
	for (const [id, chain] of Object.entries(gk.chains ?? {})) chains[id] = normalizeGasKeeperChain(id, chain)
	const refusedRaw = (gk as { refusedOwners?: unknown }).refusedOwners
	const refusedOwners: string[] = []
	if (refusedRaw !== undefined) {
		if (!Array.isArray(refusedRaw)) throw new Error('config: gasKeeper.refusedOwners must be an array of addresses')
		for (const [i, a] of refusedRaw.entries()) {
			if (typeof a !== 'string' || !isAddress(a)) throw new Error(`config: gasKeeper.refusedOwners[${i}] is not an address`)
			refusedOwners.push(getAddress(a))
		}
	}
	const enabled = gk.enabled === true
	if (enabled && refusedOwners.length === 0) throw new Error('config: gasKeeper.refusedOwners is required when gasKeeper is enabled (fail closed)')
	return {
		enabled,
		postSignEnabled: (gk as { postSignEnabled?: unknown }).postSignEnabled === true,
		intervalMs: gk.intervalMs ?? 60_000,
		chains,
		refusedOwners,
	}
}

function normalizeGasKeeperChain(id: string, chain: GasKeeperChain): GasKeeperChain {
	for (const field of ['minWei', 'targetWei', 'perAddressDailyWei', 'globalDailyWei', 'pmWarnWei', 'pmCriticalWei'] as const) {
		if (typeof chain[field] !== 'string' || !/^\d+$/.test(chain[field])) {
			throw new Error(`config: gasKeeper.chains.${id}.${field} must be a wei integer`)
		}
	}
	if (BigInt(chain.targetWei) <= BigInt(chain.minWei)) throw new Error(`config: gasKeeper.chains.${id}.targetWei must be above minWei`)
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
	if (chain.maxFeePerGasWei !== undefined && !/^\d+$/.test(chain.maxFeePerGasWei)) {
		throw new Error(`config: gasKeeper.chains.${id}.maxFeePerGasWei must be a wei integer`)
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
