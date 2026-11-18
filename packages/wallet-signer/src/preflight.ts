/**
 * Preflight for a candidate config and policy, run before the restart. Read-only: loads files, compiles the
 * policy, checks listener and admin wiring. Exit 0 only if every check passes.
 */
import { existsSync } from 'node:fs'
import { loadConfig } from './config'
import { Policy } from './policy'
import { PM_GRANT_MAX_GAS_PRICE_WEI } from './pmGrantAdmin'

export type PreflightResult = { ok: boolean; problems: string[]; policyHash: string | null; listeners: { path: string; client: string }[] }

export function preflight(configPath: string, policyPath?: string): PreflightResult {
	const problems: string[] = []
	let cfg
	try {
		cfg = loadConfig(configPath)
	} catch (e) {
		return { ok: false, problems: [`config: ${(e as Error).message}`], policyHash: null, listeners: [] }
	}
	const pPath = policyPath ?? cfg.policyFile
	let policy: Policy | null = null
	try {
		if (!existsSync(pPath)) throw new Error(`policy file missing: ${pPath}`)
		policy = Policy.load(pPath)
	} catch (e) {
		problems.push(`policy: ${(e as Error).message}`)
	}
	const listeners = (cfg.rpc.unix ?? []).map((u) => ({ path: u.path, client: u.client }))
	const paths = new Set<string>()
	for (const l of listeners) {
		if (paths.has(l.path)) problems.push(`duplicate listener path ${l.path}`)
		paths.add(l.path)
		if (l.path === cfg.adminSocket) problems.push(`listener ${l.path} collides with the admin socket`)
		if (policy && !policy.client(l.client)) problems.push(`listener client ${l.client} has no policy entry`)
	}
	if (cfg.adminSocket && paths.has(cfg.adminSocket)) problems.push('admin socket must not be a business listener')
	// PM array must not be held by any client, on any listener or not.
	if (policy) {
		for (const c of policy.clients()) {
			const arrays = policy.client(c)?.arrays ?? {}
			if (Object.keys(arrays).includes('PM')) problems.push(`client ${c} must not hold the PM array`)
		}
	}
	// Live listeners that must survive the candidate unchanged.
	for (const required of ['oracle-daemon', 'vdr-payout']) {
		if (!listeners.some((l) => l.client === required)) problems.push(`required listener for ${required} is missing`)
	}
	// The Lab listener must carry its own dedicated group (gid), or the socket inherits the service group.
	for (const l of cfg.rpc.unix ?? []) {
		if (l.client === 'lab-mining-pool' && typeof l.gid !== 'number') problems.push('lab-mining-pool listener must declare a dedicated gid')
	}
	if (cfg.pmGrantAdmin?.enabled === true && (cfg.pmGrantAdmin.denyAddresses ?? []).length === 0) {
		problems.push('pmGrantAdmin.denyAddresses must be non-empty when pmGrantAdmin is enabled (fail closed)')
	}
	if (cfg.pmGrantAdmin?.maxGasPriceWei !== undefined && BigInt(cfg.pmGrantAdmin.maxGasPriceWei) > PM_GRANT_MAX_GAS_PRICE_WEI) {
		problems.push(`pmGrantAdmin.maxGasPriceWei ${cfg.pmGrantAdmin.maxGasPriceWei} is above the 0.03 Gwei upper bound`)
	}
	if (policy) {
		const lab = policy.client('lab-mining-pool')?.arrays?.lab_mining_pool_payout as { maxGasPriceGwei?: Record<string, number> } | undefined
		const cap = lab?.maxGasPriceGwei?.['224422']
		if (cap === undefined) problems.push('lab-mining-pool policy has no maxGasPriceGwei for chain 224422')
		else if (cap > 0.03) problems.push(`lab-mining-pool maxGasPriceGwei ${cap} is above 0.03`)
	}
	if (cfg.gasKeeper.enabled === true) problems.push('gasKeeper.enabled is true: automatic top-up loop is not approved for this window')
	if (cfg.adminSocketMode !== undefined && ![0o600, 0o660].includes(cfg.adminSocketMode)) problems.push('adminSocketMode must be 0600 or 0660')
	const policyHash = policy ? policy.hash : null
	return { ok: problems.length === 0, problems, policyHash, listeners }
}

if (require.main === module) {
	const args = process.argv.slice(2)
	const ci = args.indexOf('--config')
	const pi = args.indexOf('--policy')
	if (ci < 0) { console.error('usage: preflight --config <path> [--policy <path>]'); process.exit(2) }
	const r = preflight(args[ci + 1]!, pi >= 0 ? args[pi + 1] : undefined)
	process.stdout.write(JSON.stringify(r, null, 2) + '\n')
	process.exit(r.ok ? 0 : 1)
}
