import assert from 'node:assert/strict'
import test from 'node:test'
import {
	CHALLENGE_FQDN,
	STAGING_DIRECTORY,
	STAGING_FQDN,
	classifyCredential,
	createDns01Client,
} from '../src/dns01Staging.mjs'

test('a global API key is refused before any DNS write', async () => {
	const client = createDns01Client({ credential: { X_Auth_Key: 'do-not-use' }, live: true })
	assert.equal(client.credentialKind, 'disallowed-global')
	const result = await client.publishChallengeTxt(CHALLENGE_FQDN)
	assert.equal(result.wrote, false)
	assert.equal(result.reason, 'disallowed-global')
	assert.deepEqual(client.writes, [])
})

test('production names and the staging hostname itself are not writable', async () => {
	const client = createDns01Client({ credential: { fake: true }, live: true })
	for (const name of ['dle.conet.network', '_acme-challenge.dle.conet.network', STAGING_FQDN]) {
		await assert.rejects(() => client.publishChallengeTxt(name), { code: 'name-not-allowed' })
	}
	assert.deepEqual(client.writes, [])
})

test('a fake credential fails closed and does not count as DNS-01 success', async () => {
	assert.equal(classifyCredential({ fake: true }), 'fake')
	const client = createDns01Client({ credential: { fake: true, token: 'not-a-real-token' }, live: true })
	const result = await client.publishChallengeTxt(CHALLENGE_FQDN)
	assert.equal(result.ok, false)
	assert.equal(result.wrote, false)
	assert.equal(result.reason, 'fake')
	assert.equal(client.directory, STAGING_DIRECTORY)
	assert.deepEqual(client.writes, [])
})

test('a missing credential does not write', async () => {
	const client = createDns01Client({ live: true })
	const result = await client.publishChallengeTxt(CHALLENGE_FQDN)
	assert.equal(result.wrote, false)
	assert.equal(result.reason, 'missing')
	assert.deepEqual(client.writes, [])
})
