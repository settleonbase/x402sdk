import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildVdrSignerTx, readVdrSignerConfig, sendConfiguredSettle, SETTLE_SELECTOR } from './vdrPayoutSigner.ts'

const HASH = '0x' + 'ab'.repeat(32)

function listenFake(socketPath: string) {
	const seen: unknown[] = []
	const server = createServer((req, res) => {
		const chunks: Buffer[] = []
		req.on('data', (chunk) => chunks.push(chunk))
		req.on('end', () => {
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
				method?: string
				params?: { value?: string; data?: string; chainId?: number; keyArray?: string; gasLimit?: string }
			}
			seen.push(body)
			const tx = body.params
			if (!tx || tx.value !== '0') {
				res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'native value must be 0' } }))
				return
			}
			if (!String(tx.data || '').toLowerCase().startsWith(SETTLE_SELECTOR)) {
				res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'refusing selector' } }))
				return
			}
			res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { hash: HASH } }))
		})
	})
	return new Promise<{ server: typeof server; seen: unknown[] }>((resolve) => {
		server.listen(socketPath, () => resolve({ server, seen }))
	})
}

test('missing socket or keyArray fails closed and does not call withSettleWallet', async () => {
	assert.equal(readVdrSignerConfig({}), null)
	await assert.rejects(
		() => sendConfiguredSettle({
			to: '0xc71e246DD78B37C2fABc905D340932F28F503433',
			guardianIds: [1n],
			amounts: [2n],
			eventKeys: [HASH],
			gasLimit: 200000,
			env: {},
		}),
		/not configured/
	)
	const reporter = readFileSync(new URL('./validatorClRewardPayoutReporter.ts', import.meta.url), 'utf8')
	assert.equal(reporter.includes('withSettleWallet('), false)
	assert.equal(reporter.includes('shiftSettleConet('), false)
	assert.match(reporter, /sendConfiguredSettle/)
})

test('fake socket accepts only settleNodeRewards with value 0', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'vdr-signer-'))
	const socketPath = path.join(dir, 'signer.sock')
	const fake = await listenFake(socketPath)
	try {
		const sent = await sendConfiguredSettle({
			to: '0xc71e246DD78B37C2fABc905D340932F28F503433',
			guardianIds: [7n],
			amounts: [9n],
			eventKeys: [HASH],
			gasLimit: 1_695_000,
			env: {
				CONET_VALIDATOR_CL_REWARD_PAYOUT_SIGNER_SOCKET: socketPath,
				CONET_VALIDATOR_CL_REWARD_PAYOUT_KEY_ARRAY: 'vdr-payout-test',
			},
		})
		assert.equal(sent.hash, HASH)
		const body = fake.seen[0] as { method: string; params: { value: string; chainId: number; keyArray: string; gasLimit: string; data: string } }
		assert.equal(body.method, 'signer_sendTransaction')
		assert.equal(body.params.value, '0')
		assert.equal(body.params.chainId, 224422)
		assert.equal(body.params.keyArray, 'vdr-payout-test')
		assert.equal(body.params.gasLimit, '1695000')
		assert.equal(body.params.data.slice(0, 10).toLowerCase(), SETTLE_SELECTOR)

		const bad = buildVdrSignerTx({
			keyArray: 'vdr-payout-test',
			to: '0xc71e246DD78B37C2fABc905D340932F28F503433',
			guardianIds: [1n],
			amounts: [1n],
			eventKeys: [HASH],
			gasLimit: 21000,
		})
		const refused = await new Promise<string>((resolve, reject) => {
			const payload = JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'signer_sendTransaction',
				params: { ...bad, value: '1' },
			})
			const req = httpRequest(
				{
					socketPath,
					path: '/rpc',
					method: 'POST',
					headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
				},
				(res) => {
					const chunks: Buffer[] = []
					res.on('data', (chunk) => chunks.push(chunk))
					res.on('end', () => {
						const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: { message?: string } }
						resolve(parsed.error?.message ?? '')
					})
				}
			)
			req.on('error', reject)
			req.end(payload)
		})
		assert.match(refused, /native value must be 0/)
		const seenBeforeLimits = fake.seen.length

		const env = {
			CONET_VALIDATOR_CL_REWARD_PAYOUT_SIGNER_SOCKET: socketPath,
			CONET_VALIDATOR_CL_REWARD_PAYOUT_KEY_ARRAY: 'vdr-payout-test',
		}
		await assert.rejects(
			() => sendConfiguredSettle({
				to: '0xc71e246DD78B37C2fABc905D340932F28F503433',
				guardianIds: [],
				amounts: [],
				eventKeys: [],
				gasLimit: 21000,
				env,
			}),
			/1\.\.29, got 0/
		)
		const thirty = Array.from({ length: 30 }, (_, i) => BigInt(i + 1))
		await assert.rejects(
			() => sendConfiguredSettle({
				to: '0xc71e246DD78B37C2fABc905D340932F28F503433',
				guardianIds: thirty,
				amounts: thirty,
				eventKeys: Array.from({ length: 30 }, () => HASH),
				gasLimit: 21000,
				env,
			}),
			/1\.\.29, got 30/
		)
		await assert.rejects(
			() => sendConfiguredSettle({
				to: '0xc71e246DD78B37C2fABc905D340932F28F503433',
				guardianIds: [1n],
				amounts: [1n, 2n],
				eventKeys: [HASH],
				gasLimit: 21000,
				env,
			}),
			/equal length/
		)
		assert.equal(fake.seen.length, seenBeforeLimits)
	} finally {
		await new Promise<void>((resolve) => fake.server.close(() => resolve()))
	}
})
