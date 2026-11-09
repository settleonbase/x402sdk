import { CHALLENGE_FQDN, STAGING_DIRECTORY } from './dns01Staging.mjs'
import { createRestrictedDnsHook } from './dns01RestrictedHook.mjs'

export { STAGING_DIRECTORY }

export function assertStagingDirectory(directory) {
	if (directory !== STAGING_DIRECTORY) {
		const error = new Error('ACME directory must be the staging directory')
		error.code = 'directory-not-staging'
		throw error
	}
}

export async function waitForAuthoritativeTxt(query, name, value, attempts = 3) {
	for (let i = 0; i < attempts; i += 1) {
		const seen = await query(name)
		if (seen === value) return true
	}
	return false
}

async function removeChallenge(hook) {
	await hook.deleteTxt(CHALLENGE_FQDN)
}

export async function runStagingChallenge(options) {
	assertStagingDirectory(options.directory ?? STAGING_DIRECTORY)
	const hook = createRestrictedDnsHook(options.store, options.credential)
	const value = options.value
	await hook.createTxt(CHALLENGE_FQDN, value)
	if (options.afterCreate) await options.afterCreate(options.store.snapshot())
	if (options.failAfterCreate) {
		await removeChallenge(hook)
		return { ok: false, realOrder: false, reason: 'rolled-back', left: options.store.snapshot(), logLine: 'DNS01_STAGING_NOT_RUN' }
	}
	const seen = await waitForAuthoritativeTxt(options.query, CHALLENGE_FQDN, value, options.attempts ?? 3)
	if (!seen) {
		await removeChallenge(hook)
		return { ok: false, realOrder: false, reason: 'propagation-failed', left: options.store.snapshot(), logLine: 'DNS01_STAGING_NOT_RUN' }
	}
	await removeChallenge(hook)
	return { ok: true, realOrder: false, reason: 'stub-cleaned', left: options.store.snapshot(), logLine: 'DNS01_STAGING_NOT_RUN' }
}
