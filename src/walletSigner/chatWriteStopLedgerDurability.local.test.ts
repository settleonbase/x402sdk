/**
 * Ledger path, pre-send durability, corrupt/failed writes, and multi-process merge.
 * This file does not import util.ts, settleContractPool.ts, chatIndexPointer.ts, or beamioMaster.ts.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Interface } from 'ethers'
import { CHAT_POINTER_METHOD } from './chatPointerRelayGate.ts'
import { submitIsolatedChatPointer } from './chatPointerIsolatedSend.ts'
import {
	CHAT_TOKEN_LEDGER_DEFAULT_NAME,
	chatTokenLedgerRefusal,
	legacyPoolMayResendChatIdempotency,
	legacyPoolMayResendChatNonce,
	reloadChatRemoteTokenLedger,
	resetChatWriteStopForTests,
	retainRemoteChatToken,
} from './chatWriteStopGate.ts'
import { resetIsolatedChatRelayForTests, setIsolatedChatRelayIdle } from './isolatedChatRelayPool.ts'
import { RemoteSigner, WalletSignerClient } from './remoteSigner.ts'

const here = dirname(fileURLToPath(import.meta.url))
const reviewRoot = dirname(dirname(here))
const gateUrl = pathToFileURL(join(here, 'chatWriteStopGate.ts')).href
const tsx = process.env.TSX ?? 'tsx'
const owner = '0x0000000000000000000000000000000000000001'
const pointerIface = new Interface([`function ${CHAT_POINTER_METHOD}`])
const prevLedger = process.env.WALLET_SIGNER_CHAT_TOKEN_LEDGER
const root = mkdtempSync(join(tmpdir(), 'chat-ledger-durability-'))

function chatKey(nonce: string): string {
	return `chat:${owner}:${nonce}`
}

function useLedger(path: string): void {
	process.env.WALLET_SIGNER_CHAT_TOKEN_LEDGER = path
	resetChatWriteStopForTests()
}

function calldata(nonce: bigint): string {
	const hash = `0x${'11'.repeat(32)}`
	const signature = `0x${'ab'.repeat(65)}`
	return pointerIface.encodeFunctionData('setPointerWithSig', [owner, hash, 1n, 1n, nonce, signature])
}

test('unconfigured ledger does not send', async () => {
	delete process.env.WALLET_SIGNER_CHAT_TOKEN_LEDGER
	resetChatWriteStopForTests()
	assert.equal(chatTokenLedgerRefusal(), 'chat_token_ledger_unconfigured')
	process.env.WALLET_SIGNER_CHAT_TOKEN_LEDGER = join(tmpdir(), CHAT_TOKEN_LEDGER_DEFAULT_NAME)
	assert.equal(chatTokenLedgerRefusal(), 'chat_token_ledger_unconfigured')
	delete process.env.WALLET_SIGNER_CHAT_TOKEN_LEDGER
	let sends = 0
	const original = RemoteSigner.prototype.sendTransaction
	RemoteSigner.prototype.sendTransaction = async () => {
		sends += 1
		return { hash: `0x${'ab'.repeat(32)}`, wait: async () => ({ status: 1 }) } as never
	}
	try {
		setIsolatedChatRelayIdle([
			new RemoteSigner(new WalletSignerClient({ url: 'unix:/tmp/wallet-signer-ledger-durability.sock' }), {
				keyArray: 'chat_index_pointer',
				chainId: 224422,
				address: owner,
			}),
		])
		await assert.rejects(submitIsolatedChatPointer({
			to: owner,
			data: calldata(11n),
			value: 0n,
			gasLimit: 150_000n,
		}), /chat_token_ledger_unconfigured/)
		assert.equal(sends, 0)
		assert.equal(legacyPoolMayResendChatNonce(owner, '11'), true)
		assert.equal(legacyPoolMayResendChatIdempotency(chatKey('11')), true)
	} finally {
		RemoteSigner.prototype.sendTransaction = original
		resetIsolatedChatRelayForTests()
	}
})

test('failed persist does not send and leaves no row to block', async () => {
	const dir = join(root, 'unwritable')
	const ledger = join(dir, 'ledger.json')
	useLedger(ledger)
	chmodSync(dir, 0o555)
	let sends = 0
	const original = RemoteSigner.prototype.sendTransaction
	RemoteSigner.prototype.sendTransaction = async () => {
		sends += 1
		return { hash: `0x${'cd'.repeat(32)}`, wait: async () => ({ status: 1 }) } as never
	}
	try {
		setIsolatedChatRelayIdle([
			new RemoteSigner(new WalletSignerClient({ url: 'unix:/tmp/wallet-signer-ledger-durability.sock' }), {
				keyArray: 'chat_index_pointer',
				chainId: 224422,
				address: owner,
			}),
		])
		await assert.rejects(submitIsolatedChatPointer({
			to: owner,
			data: calldata(12n),
			value: 0n,
			gasLimit: 150_000n,
		}), /chat_token_ledger_persist_failed/)
		assert.equal(sends, 0)
		chmodSync(dir, 0o700)
		reloadChatRemoteTokenLedger()
		assert.equal(legacyPoolMayResendChatNonce(owner, '12'), true)
		assert.equal(readFileSync(ledger, 'utf8').includes(':12'), false)
	} finally {
		RemoteSigner.prototype.sendTransaction = original
		resetIsolatedChatRelayForTests()
		chmodSync(dir, 0o700)
	}
})

test('corrupt ledger fail-closes and a failed write does not replace an existing ledger', () => {
	const dir = join(root, 'existing')
	const ledger = join(dir, 'ledger.json')
	useLedger(ledger)
	retainRemoteChatToken({
		idempotencyKey: chatKey('13'),
		owner,
		pointerNonce: '13',
		phase: 'unconfirmed',
	})
	const before = readFileSync(ledger)
	assert.equal(statSync(ledger).mode & 0o777, 0o600)
	chmodSync(dir, 0o555)
	assert.throws(() => retainRemoteChatToken({
		idempotencyKey: chatKey('14'),
		owner,
		pointerNonce: '14',
		phase: 'abandoned',
	}), /chat_token_ledger_persist_failed/)
	chmodSync(dir, 0o700)
	assert.deepEqual(readFileSync(ledger), before)
	reloadChatRemoteTokenLedger()
	assert.equal(legacyPoolMayResendChatNonce(owner, '13'), false)
	assert.equal(legacyPoolMayResendChatNonce(owner, '14'), true)

	writeFileSync(ledger, '{{{not-a-ledger')
	reloadChatRemoteTokenLedger()
	assert.equal(legacyPoolMayResendChatNonce(owner, '13'), false)
	assert.equal(legacyPoolMayResendChatIdempotency(chatKey('13')), false)
	assert.equal(legacyPoolMayResendChatNonce(owner, '99'), false)
})

test('two processes keep both appended rows after restart', async () => {
	const ledger = join(root, 'shared', 'ledger.json')
	useLedger(ledger)
	const go = join(root, 'shared', 'go')
	const script = [
		`import { existsSync } from 'node:fs'`,
		`import { retainRemoteChatToken } from ${JSON.stringify(gateUrl)}`,
		`process.stdout.write('ready\\n')`,
		`while (!existsSync(process.env.GO ?? '')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)`,
		`retainRemoteChatToken({ idempotencyKey: process.env.KEY, owner: process.env.OWNER, pointerNonce: process.env.NONCE, phase: 'unconfirmed' })`,
	].join('\n')
	const start = (nonce: string) => spawn(tsx, ['--eval', script], {
		cwd: reviewRoot,
		env: {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			WALLET_SIGNER_CHAT_TOKEN_LEDGER: ledger,
			GO: go,
			KEY: chatKey(nonce),
			OWNER: owner,
			NONCE: nonce,
		},
	})
	const first = start('21')
	const second = start('22')
	await Promise.all([waitReady(first), waitReady(second)])
	writeFileSync(go, '1')
	const codes = await Promise.all([waitExit(first), waitExit(second)])
	assert.deepEqual(codes, [0, 0])
	reloadChatRemoteTokenLedger()
	assert.equal(legacyPoolMayResendChatNonce(owner, '21'), false)
	assert.equal(legacyPoolMayResendChatNonce(owner, '22'), false)
	assert.equal(legacyPoolMayResendChatIdempotency(chatKey('21')), false)
	assert.equal(legacyPoolMayResendChatIdempotency(chatKey('22')), false)
	const text = readFileSync(ledger, 'utf8')
	assert.match(text, /:21/)
	assert.match(text, /:22/)
})

test('cleanup durability ledger env', () => {
	if (prevLedger === undefined) delete process.env.WALLET_SIGNER_CHAT_TOKEN_LEDGER
	else process.env.WALLET_SIGNER_CHAT_TOKEN_LEDGER = prevLedger
	resetChatWriteStopForTests()
	rmSync(root, { recursive: true, force: true })
	assert.equal(true, true)
})

function waitReady(child: ReturnType<typeof spawn>): Promise<void> {
	return new Promise((resolve, reject) => {
		let buf = ''
		child.stdout?.on('data', (chunk: Buffer) => {
			buf += chunk.toString('utf8')
			if (buf.includes('ready')) resolve()
		})
		child.on('exit', (code) => {
			if (!buf.includes('ready')) reject(new Error(`child exited ${code} before ready`))
		})
	})
}

function waitExit(child: ReturnType<typeof spawn>): Promise<number> {
	return new Promise((resolve, reject) => {
		let err = ''
		child.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString('utf8') })
		child.on('exit', (code) => {
			if (code === 0) resolve(0)
			else reject(new Error(err || `exit ${code}`))
		})
	})
}
