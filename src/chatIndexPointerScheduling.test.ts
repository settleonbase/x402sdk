import assert from 'node:assert/strict'
import test from 'node:test'
import {
	chatIndexPointerOwnerKey,
	chatIndexPointerRequestKey,
	pickChatIndexPointerJobIndex,
} from './chatIndexPointerScheduling.ts'

test('pointer jobs for different owners can use separate workers', () => {
	const jobs = [
		{ owner: '0xAAA', nonce: '1' },
		{ owner: '0xBBB', nonce: '2' },
	]

	assert.equal(pickChatIndexPointerJobIndex(jobs, new Set(['0xaaa'])), 1)
})

test('pointer jobs for the same owner remain blocked while owner is in flight', () => {
	const jobs = [{ owner: '0xAAA', nonce: '1' }]

	assert.equal(pickChatIndexPointerJobIndex(jobs, new Set(['0xaaa'])), -1)
})

test('owner and request keys are case insensitive for address identity', () => {
	assert.equal(chatIndexPointerOwnerKey('0xAbC'), '0xabc')
	assert.equal(chatIndexPointerRequestKey('0xAbC', '7'), '0xabc:7')
})
