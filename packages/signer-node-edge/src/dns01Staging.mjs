export const STAGING_FQDN = 'dle-dns01-staging.conet.network'
export const CHALLENGE_FQDN = `_acme-challenge.${STAGING_FQDN}`
export const STAGING_DIRECTORY = 'https://acme-staging-v02.api.letsencrypt.org/directory'

const FORBIDDEN_FQDNS = new Set([
	'dle.conet.network',
	'_acme-challenge.dle.conet.network',
])

export function classifyCredential(credential) {
	if (!credential || typeof credential !== 'object') return 'missing'
	const keys = Object.keys(credential)
	const globalKey = keys.some((key) => /^(x[-_]?auth[-_]?key|global[-_]?api[-_]?key)$/i.test(key))
	if (globalKey || credential.kind === 'global-api-key') return 'disallowed-global'
	if (credential.fake === true) return 'fake'
	if (typeof credential.token === 'string' && credential.token.length > 0) return 'scoped-token'
	return 'missing'
}

export function assertWritableName(name) {
	if (FORBIDDEN_FQDNS.has(name) || name === STAGING_FQDN) {
		const error = new Error('name is not the staging challenge record')
		error.code = 'name-not-allowed'
		throw error
	}
	if (name !== CHALLENGE_FQDN) {
		const error = new Error('name is outside the staging challenge record')
		error.code = 'name-not-allowed'
		throw error
	}
}

export function createDns01Client(options = {}) {
	const writes = []
	const credentialKind = classifyCredential(options.credential)
	return {
		writes,
		credentialKind,
		directory: STAGING_DIRECTORY,
		async publishChallengeTxt(name) {
			assertWritableName(name)
			if (credentialKind !== 'scoped-token') {
				return { ok: false, reason: credentialKind, wrote: false }
			}
			if (options.live !== true) {
				return { ok: false, reason: 'live-not-authorized', wrote: false }
			}
			return { ok: false, reason: 'live-client-not-configured', wrote: false }
		},
	}
}
