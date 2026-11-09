import assert from 'node:assert/strict'
import test from 'node:test'
import { CHALLENGE_FQDN } from '../src/dns01Staging.mjs'
import { runStagingChallenge } from '../src/dns01AcmeStaging.mjs'
import { createMemoryTxtStore, createRestrictedDnsHook } from '../src/dns01RestrictedHook.mjs'

const credential = { token: 'scoped-stub', kind: 'scoped' }

test('the stub creates the staging challenge TXT', async () => {
	const store = createMemoryTxtStore()
	let during = null
	const result = await runStagingChallenge({
		credential,
		store,
		value: 'challenge-one',
		query: async () => 'challenge-one',
		afterCreate(snapshot) {
			during = snapshot
		},
	})
	assert.equal(during[CHALLENGE_FQDN], 'challenge-one')
	assert.equal(result.logLine, 'DNS01_STAGING_NOT_RUN')
	assert.equal(result.realOrder, false)
})

test('the stub removes the TXT when the attempt ends', async () => {
	const store = createMemoryTxtStore()
	const result = await runStagingChallenge({
		credential,
		store,
		value: 'challenge-two',
		query: async () => 'challenge-two',
	})
	assert.deepEqual(result.left, {})
	assert.deepEqual(store.history.map((row) => row.op), ['create', 'delete'])
	assert.equal(result.logLine, 'DNS01_STAGING_NOT_RUN')
})

test('a failed attempt rolls back and leaves no TXT', async () => {
	const store = createMemoryTxtStore()
	const result = await runStagingChallenge({
		credential,
		store,
		value: 'challenge-three',
		query: async () => null,
		failAfterCreate: true,
	})
	assert.equal(result.reason, 'rolled-back')
	assert.deepEqual(result.left, {})
	assert.deepEqual(store.history.map((row) => row.op), ['create', 'delete'])
	const propagation = await runStagingChallenge({
		credential,
		store,
		value: 'challenge-four',
		query: async () => null,
	})
	assert.equal(propagation.reason, 'propagation-failed')
	assert.deepEqual(propagation.left, {})
	assert.equal(propagation.logLine, 'DNS01_STAGING_NOT_RUN')
})

test('the hook refuses a global key and production names before writing', async () => {
	const store = createMemoryTxtStore()
	const globalHook = createRestrictedDnsHook(store, { X_Auth_Key: 'do-not-use' })
	await assert.rejects(() => globalHook.createTxt(CHALLENGE_FQDN, 'x'), { code: 'disallowed-global' })
	const hook = createRestrictedDnsHook(store, credential)
	await assert.rejects(() => hook.createTxt('dle.conet.network', 'x'), { code: 'name-not-allowed' })
	await assert.rejects(() => hook.createTxt('_acme-challenge.dle.conet.network', 'x'), { code: 'name-not-allowed' })
	assert.deepEqual(store.snapshot(), {})
	assert.deepEqual(store.history, [])
})
