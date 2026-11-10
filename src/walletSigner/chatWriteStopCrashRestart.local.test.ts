/**
 * A crashed writer can leave a stale ledger lock. A later process must take it
 * without sleeping out the 30s stale window, and must keep the unreconciled nonce blocked.
 * This file does not import util.ts, settleContractPool.ts, or chatIndexPointer.ts.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
	legacyPoolMayResendChatNonce,
	reloadChatRemoteTokenLedger,
	resetChatWriteStopForTests,
	retainRemoteChatToken,
} from './chatWriteStopGate.ts'

const here = dirname(fileURLToPath(import.meta.url))
const reviewRoot = dirname(dirname(here))
const gateUrl = pathToFileURL(join(here, 'chatWriteStopGate.ts')).href
const tsx = process.env.TSX ?? 'tsx'
const owner = '0x0000000000000000000000000000000000000001'
const prevLedger = process.env.WALLET_SIGNER_CHAT_TOKEN_LEDGER
const root = mkdtempSync(join(tmpdir(), 'chat-ledger-crash-'))
const ledger = join(root, 'ledger.json')
const lock = `${ledger}.lock`

function chatKey(nonce: string): string {
	return `chat:${owner}:${nonce}`
}

test('stale crash lock is reclaimed and the unreconciled nonce stays blocked', () => {
	process.env.WALLET_SIGNER_CHAT_TOKEN_LEDGER = ledger
	resetChatWriteStopForTests()
	retainRemoteChatToken({
		idempotencyKey: chatKey('61'),
		owner,
		pointerNonce: '61',
		phase: 'unconfirmed',
	})
	writeFileSync(lock, '')
	const stale = new Date(Date.now() - 31_000)
	utimesSync(lock, stale, stale)
	assert.equal(existsSync(lock), true)

	const script = [
		`import { existsSync } from 'node:fs'`,
		`import { legacyPoolMayResendChatNonce, retainRemoteChatToken } from ${JSON.stringify(gateUrl)}`,
		`retainRemoteChatToken({ idempotencyKey: process.env.KEY, owner: process.env.OWNER, pointerNonce: process.env.NONCE, phase: 'unconfirmed' })`,
		`const blocked = legacyPoolMayResendChatNonce(process.env.OWNER, '61')`,
		`process.stdout.write(JSON.stringify({ blocked, lockRemains: existsSync(process.env.LOCK) }))`,
	].join('\n')
	const child = spawnSync(tsx, ['--eval', script], {
		cwd: reviewRoot,
		env: {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			WALLET_SIGNER_CHAT_TOKEN_LEDGER: ledger,
			OWNER: owner,
			NONCE: '62',
			KEY: chatKey('62'),
			LOCK: lock,
		},
		encoding: 'utf8',
		timeout: 8_000,
	})
	assert.equal(child.status, 0, child.stderr || child.stdout)
	assert.equal((child.stderr || '').includes('chat_token_ledger_persist_failed'), false)
	const reported = JSON.parse(child.stdout) as { blocked: boolean; lockRemains: boolean }
	assert.equal(reported.blocked, false)
	assert.equal(reported.lockRemains, false)
	assert.equal(existsSync(lock), false)
	reloadChatRemoteTokenLedger()
	assert.equal(legacyPoolMayResendChatNonce(owner, '61'), false)
	assert.equal(legacyPoolMayResendChatNonce(owner, '62'), false)
	const text = readFileSync(ledger, 'utf8')
	assert.match(text, /:61/)
	assert.match(text, /:62/)

	if (prevLedger === undefined) delete process.env.WALLET_SIGNER_CHAT_TOKEN_LEDGER
	else process.env.WALLET_SIGNER_CHAT_TOKEN_LEDGER = prevLedger
	resetChatWriteStopForTests()
	rmSync(root, { recursive: true, force: true })
})
