import { CHALLENGE_FQDN, assertWritableName, classifyCredential } from './dns01Staging.mjs'

export function createMemoryTxtStore() {
	const records = new Map()
	const history = []
	return {
		history,
		snapshot() {
			return Object.fromEntries(records)
		},
		async writeTxt(name, value) {
			records.set(name, value)
			history.push({ op: 'create', name })
		},
		async removeTxt(name) {
			records.delete(name)
			history.push({ op: 'delete', name })
		},
	}
}

export function createRestrictedDnsHook(store, credential) {
	const kind = classifyCredential(credential)
	return {
		kind,
		async createTxt(name, value) {
			assertWritableName(name)
			if (kind === 'disallowed-global') {
				const error = new Error('global API key is refused')
				error.code = 'disallowed-global'
				throw error
			}
			if (kind !== 'scoped-token') {
				const error = new Error('restricted TXT credential is missing')
				error.code = kind
				throw error
			}
			if (name !== CHALLENGE_FQDN) {
				const error = new Error('TXT name is not the staging challenge')
				error.code = 'name-not-allowed'
				throw error
			}
			await store.writeTxt(name, value)
		},
		async deleteTxt(name) {
			assertWritableName(name)
			await store.removeTxt(name)
		},
	}
}
