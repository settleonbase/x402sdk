import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Interface, Transaction, Wallet, getAddress } from 'ethers'
import { AuditLog, verifyAuditFile } from '../src/audit'
import { HdRoot, mnemonicToEntropyBytes, newMnemonic } from '../src/hd'
import { Keyring } from '../src/keyring'
import { Policy } from '../src/policy'
import { RateLimiter } from '../src/rateLimit'
import { redactText } from '../src/redact'
import { addArray, emptyRegistry, growArray, rotateArray, signRegistry, verifyRegistry } from '../src/registry'
import { resolveTypedDataNonce } from '../src/typedDataReplay'
import { GasKeeper, ORACLE_DAEMON_CLIENT, ORACLE_GAS_WALLET, adminGasRunRefusal, gasKeeperTopupIdempotencyKey, gasKeeperUsage, gasTopupRpcRefusal, worstCaseNativeTransferGasWei, type SpendRow } from '../src/gasKeeper'
import { journalReservationWei, requestFingerprint, TxManager, type TxRecord } from '../src/txManager'
import { appendDurableJournalLine, parseJournal } from '../src/txJournal'
import { createVaultJson, openVault } from '../src/vault'

const PW = 'unit-test-password-123'

test('vault round trip and ethers recovery path gives the PM key', async () => {
	const phrase = newMnemonic()
	assert.equal(phrase.split(' ').length, 24)
	const entropy = mnemonicToEntropyBytes(phrase)
	const json = await createVaultJson(entropy, PW, 2 ** 12)
	const opened = await openVault(json, PW)
	const viaEthers = await Wallet.fromEncryptedJson(json, PW)
	assert.equal(viaEthers.address, opened.pmAddress)
	assert.equal(HdRoot.fromEntropy(opened.entropy).address(0, 0), opened.pmAddress)
	await assert.rejects(openVault(json, 'wrong-password-xyz'))
})

test('derivation is deterministic and matches standard BIP-44 paths', () => {
	const phrase = newMnemonic()
	const hd = HdRoot.fromEntropy(mnemonicToEntropyBytes(phrase))
	const w = Wallet.fromPhrase(phrase, undefined).deriveChild(0) // m/44'/60'/0'/0/0 base is fromPhrase default
	assert.equal(hd.address(0, 0), Wallet.fromPhrase(phrase).address)
	assert.ok(w.address)
	const hd2 = HdRoot.fromEntropy(mnemonicToEntropyBytes(phrase))
	assert.equal(hd.address(10, 3), hd2.address(10, 3))
	assert.notEqual(hd.address(10, 0), hd.address(11, 0))
})

test('registry: add / grow / rotate, attestation, tamper detection', () => {
	const hd = HdRoot.fromEntropy(mnemonicToEntropyBytes(newMnemonic()))
	const kr = new Keyring()
	kr.load(hd, null)
	let body = emptyRegistry(kr.pmAddress, kr.attestorAddress)
	body = addArray(body, hd, 'settle_contractAdmin', 4, [224422])
	body = addArray(body, hd, 'epochManagre', 1, [224422])
	assert.equal(body.arrays[0]!.account, 10)
	assert.equal(body.arrays[1]!.account, 11)
	body = growArray(body, hd, 'epochManagre', 2)
	body = rotateArray(body, hd, 'settle_contractAdmin')
	const active = body.arrays.find((a) => a.name === 'settle_contractAdmin' && a.status === 'active')!
	assert.equal(active.account, 12)
	assert.equal(active.replaces, 10)
	const file = signRegistry(kr, body)
	assert.deepEqual(verifyRegistry(file, hd), [])
	const tampered = JSON.parse(JSON.stringify(file))
	tampered.arrays[1].addresses[0] = Wallet.createRandom().address
	assert.ok(verifyRegistry(tampered, hd).length > 0)
	const otherHd = HdRoot.fromEntropy(mnemonicToEntropyBytes(newMnemonic()))
	assert.ok(verifyRegistry(file, otherHd).includes('pm address does not match mnemonic'))
	assert.throws(() => addArray(body, hd, 'settle_contractAdmin', 1, [224422]))
	assert.throws(() => addArray(body, hd, 'bad-name', 1, [224422]))
})

test('policy: selector, target, arg rules and chain', () => {
	const epoch = '0x648f1a17269627C3d465fEa40b3C229f7CacE5cA'
	const leaked = '0x4a3aad1ddf82aff2b3969d45b157d34c72b2efc8'
	const p = new Policy({
		version: 1,
		clients: {
			dl: {
				arrays: {
					epochManagre: {
						chains: [224422],
						allow: [
							{ to: epoch, selectors: ['updateInfo(uint256,uint256,uint256)'], maxGas: 300000 },
							{ to: epoch, selectors: ['changeAddressInAdminlist(address,bool)'], args: { '0': { in: '@compromised' }, '1': { eq: false } } },
						],
					},
				},
			},
		},
	})
	const iface = new Interface(['function updateInfo(uint256,uint256,uint256)', 'function changeAddressInAdminlist(address,bool)'])
	const lists = { compromised: new Set([leaked]), registry: new Set<string>() }
	const base = { client: 'dl', array: 'epochManagre', chainId: 224422, to: epoch, value: 0n }
	assert.equal(p.checkCall({ ...base, data: iface.encodeFunctionData('updateInfo', [1, 2, 3]) }, lists).method, 'updateInfo(uint256,uint256,uint256)')
	assert.ok(p.checkCall({ ...base, data: iface.encodeFunctionData('changeAddressInAdminlist', [leaked, false]) }, lists))
	assert.throws(() => p.checkCall({ ...base, data: iface.encodeFunctionData('changeAddressInAdminlist', [leaked, true]) }, lists))
	assert.throws(() => p.checkCall({ ...base, data: iface.encodeFunctionData('changeAddressInAdminlist', [Wallet.createRandom().address, false]) }, lists))
	assert.throws(() => p.checkCall({ ...base, chainId: 8453, data: iface.encodeFunctionData('updateInfo', [1, 2, 3]) }, lists))
	assert.throws(() => p.checkCall({ ...base, value: 1n, data: iface.encodeFunctionData('updateInfo', [1, 2, 3]) }, lists))
	assert.throws(() => p.checkCall({ ...base, gasLimit: 400000n, data: iface.encodeFunctionData('updateInfo', [1, 2, 3]) }, lists))
	assert.throws(() => p.checkCall({ ...base, to: Wallet.createRandom().address, data: iface.encodeFunctionData('updateInfo', [1, 2, 3]) }, lists))
	assert.throws(() => p.checkCall({ ...base, client: 'other', data: iface.encodeFunctionData('updateInfo', [1, 2, 3]) }, lists))
	assert.throws(() => p.checkCall({ ...base, data: '0x' }, lists))
})

test('policy: gas cap follows the matched selector, not the first rule for the target', () => {
	const epoch = '0x648f1a17269627C3d465fEa40b3C229f7CacE5cA'
	const p = new Policy({
		version: 1,
		clients: {
			dl: {
				arrays: {
					settle: {
						chains: [224422],
						allow: [
							{ to: epoch, selectors: ['updateInfo(uint256,uint256,uint256)'], maxGas: 300000 },
							{ to: epoch, selectors: ['poke()'], maxGas: 50000 },
							{ to: epoch, selectors: ['touch()'] },
						],
					},
				},
			},
		},
	})
	const iface = new Interface(['function updateInfo(uint256,uint256,uint256)', 'function poke()', 'function touch()'])
	const lists = { compromised: new Set<string>(), registry: new Set<string>() }
	const base = { client: 'dl', array: 'settle', chainId: 224422, to: epoch, value: 0n }
	assert.equal(p.checkCall({ ...base, data: iface.encodeFunctionData('poke', []) }, lists).maxGas, 50000)
	assert.equal(p.checkCall({ ...base, data: iface.encodeFunctionData('updateInfo', [1, 2, 3]) }, lists).maxGas, 300000)
	assert.equal(p.checkCall({ ...base, data: iface.encodeFunctionData('touch', []) }, lists).maxGas, undefined)
	assert.throws(() => p.checkCall({ ...base, data: iface.encodeFunctionData('poke', []), gasLimit: 50001n }, lists))
	assert.doesNotThrow(() => p.checkCall({ ...base, data: iface.encodeFunctionData('poke', []), gasLimit: 50000n }, lists))
})

test('policy: compile rejects overlap, unknown fields, out-of-range args, and incomplete typed data', () => {
	const epoch = '0x648f1a17269627C3d465fEa40b3C229f7CacE5cA'
	const allow = [{ to: epoch, selectors: ['poke()'], maxGas: 1 }]
	const base = { version: 1 as const, clients: { dl: { arrays: { settle: { chains: [224422], allow } } } } }
	assert.throws(
		() =>
			new Policy({
				version: 1,
				clients: {
					dl: {
						arrays: {
							settle: {
								chains: [224422],
								allow: [
									{ to: epoch, selectors: ['poke()'] },
									{ to: epoch, selectors: ['function poke()'] },
								],
							},
						},
					},
				},
			}),
		/overlapping rule/,
	)
	assert.throws(
		() =>
			new Policy({
				version: 1,
				clients: { dl: { arrays: { settle: { chains: [224422], allow, surprise: true } as never } } },
			}),
		/unknown field surprise/,
	)
	assert.throws(
		() =>
			new Policy({
				version: 1,
				clients: {
					dl: {
						arrays: {
							settle: { chains: [224422], allow: [{ to: epoch, selectors: ['poke()'], args: { '3': { eq: 1 } } }] },
						},
					},
				},
			}),
		/out of range/,
	)
	assert.throws(
		() =>
			new Policy({
				version: 1,
				clients: {
					dl: {
						arrays: {
							settle: {
								chains: [224422],
								allow,
								typedData: [{ chainId: 224422, verifyingContract: epoch, primaryType: 'ExecuteForAdmin' }],
							},
						},
					},
				},
			} as never),
		/typed data authorization is closed/,
	)
})

test('policy: typed data requires the fixed schema and rejects impersonation or expiry', () => {
	const factory = '0xfA52a0CcC96C19cF4b6Ea864615F6d52BD0774FB'
	const types = {
		ExecuteForAdmin: [
			{ name: 'cardAddress', type: 'address' },
			{ name: 'dataHash', type: 'bytes32' },
			{ name: 'deadline', type: 'uint256' },
			{ name: 'nonce', type: 'bytes32' },
		],
	}
	const p = new Policy({
		version: 1,
		clients: {
			card: {
				arrays: {
					cardAdmin: {
						chains: [224422],
						allow: [],
						typedData: [
							{
								chainId: 224422,
								verifyingContract: factory,
								primaryType: 'ExecuteForAdmin',
								domainName: 'BeamioUserCardFactory',
								domainVersion: '1',
								types,
							},
						],
					},
				},
			},
		},
	})
	const deadline = BigInt(Math.floor(Date.now() / 1000) + 600)
	const message = {
		cardAddress: '0x0000000000000000000000000000000000000001',
		dataHash: `0x${'11'.repeat(32)}`,
		deadline,
		nonce: `0x${'22'.repeat(32)}`,
	}
	const domain = { name: 'BeamioUserCardFactory', version: '1', chainId: 224422, verifyingContract: factory }
	assert.equal(p.checkTypedData('card', 'cardAdmin', domain, types, 'ExecuteForAdmin', message).chains[0], 224422)
	assert.throws(() => p.checkTypedData('card', 'cardAdmin', domain, types, 'Inner', message), /primaryType does not match/)
	assert.throws(
		() => p.checkTypedData('card', 'cardAdmin', { ...domain, version: '2' }, types, 'ExecuteForAdmin', message),
		/domain name or version/,
	)
	assert.throws(
		() => p.checkTypedData('card', 'cardAdmin', domain, types, 'ExecuteForAdmin', { ...message, extra: 1 }),
		/message fields/,
	)
	assert.throws(
		() => p.checkTypedData('card', 'cardAdmin', domain, types, 'ExecuteForAdmin', { ...message, deadline: 1n }),
		/deadline is expired/,
	)
	assert.throws(
		() => p.checkTypedData('card', 'cardAdmin', { ...domain, chainId: 8453 }, types, 'ExecuteForAdmin', message),
		/not allowed/,
	)
})

test('rate limiter: per minute and per day', () => {
	const r = new RateLimiter()
	const t0 = Date.UTC(2026, 10, 5, 12)
	assert.ok(r.take('a', 2, undefined, t0))
	assert.ok(r.take('a', 2, undefined, t0))
	assert.ok(!r.take('a', 2, undefined, t0))
	assert.ok(r.take('a', 2, undefined, t0 + 30_000))
	assert.ok(r.take('d', undefined, 1, t0))
	assert.ok(!r.take('d', undefined, 1, t0 + 1000))
})

test('audit log hash chain detects edits', () => {
	const dir = mkdtempSync(join(tmpdir(), 'ws-audit-'))
	const path = join(dir, 'audit.jsonl')
	const log = new AuditLog(path)
	log.write({ event: 'a' })
	log.write({ event: 'b', n: 1n, hash: '0xabc', seq: 99 })
	const lines = require('node:fs').readFileSync(path, 'utf8').trim().split('\n').map((l: string) => JSON.parse(l))
	assert.equal(lines[1].hash, '0xabc')
	assert.equal(lines[1].seq, 2)
	assert.equal(verifyAuditFile(path), null)
	const { readFileSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
	writeFileSync(path, readFileSync(path, 'utf8').replace('"b"', '"c"'))
	assert.equal(verifyAuditFile(path), 2)
})

test('redaction hides key-shaped hex and mnemonic runs', () => {
	const phrase = newMnemonic()
	const k = Wallet.createRandom().privateKey
	const out = redactText(`err ${k} words: ${phrase}`)
	assert.ok(!out.includes(k.slice(2)))
	assert.ok(!out.includes(phrase))
})

test('config: proxied listener must be a socket or loopback TCP with a secret', () => {
	const { writeFileSync } = require('node:fs') as typeof import('node:fs')
	const { loadConfig } = require('../src/config') as typeof import('../src/config')
	const dir = mkdtempSync(join(tmpdir(), 'ws-cfg-'))
	const load = (proxied: unknown) => {
		const p = join(dir, 'c.json')
		writeFileSync(p, JSON.stringify({ dataDir: dir, adminSocket: join(dir, 'a.sock'), policyFile: join(dir, 'p.json'), chains: { '1': { rpcUrls: ['http://127.0.0.1:9'] } }, rpc: { proxied } }))
		return loadConfig(p)
	}
	const secret = 'ab'.repeat(32)
	assert.equal(load({ path: join(dir, 'rpc.sock') }).rpc.proxied?.path, join(dir, 'rpc.sock'))
	assert.equal(load({ host: '127.0.0.1', port: 8445, secretSha256: secret }).rpc.proxied?.port, 8445)
	assert.throws(() => load({ host: '0.0.0.0', port: 8445, secretSha256: secret }), /127\.0\.0\.1/)
	assert.throws(() => load({ host: '127.0.0.1', port: 8445 }), /secretSha256/)
	assert.throws(() => load({ path: join(dir, 'x.sock'), host: '127.0.0.1', port: 1, secretSha256: secret }), /exactly one/)
	assert.throws(() => load({ path: join(dir, 'x.sock'), secretSha256: 'nothex' }), /32 bytes hex/)
	assert.equal(load({ path: join(dir, 'rpc.sock') }).logDir, dir)
})

test('config: requireMountPoint refuses an unmounted volume and paths outside it', () => {
	const { assertDataMount, mountSourceOf } = require('../src/config') as typeof import('../src/config')
	const dir = mkdtempSync(join(tmpdir(), 'ws-mnt-'))
	writeFileSync(join(dir, 'keep'), 'unchanged')
	const before = readdirSync(dir)
	const base = { adminSocket: '', policyFile: '', compromisedFile: '', rpc: {}, chains: {}, gasKeeper: { enabled: false, intervalMs: 1, chains: {} }, alerts: {}, scryptN: 1, keyWaitMs: 1 }
	// A plain directory is on the same filesystem as its parent: "not mounted".
	assert.throws(() => assertDataMount({ ...base, requireMountPoint: dir, dataDir: join(dir, 's'), logDir: join(dir, 'l') }), /not mounted/)
	assert.throws(() => assertDataMount({ ...base, requireMountPoint: join(dir, 'missing'), dataDir: join(dir, 'missing', 's'), logDir: join(dir, 'missing', 'l') }), /not mounted/)
	assert.throws(() => assertDataMount({ ...base, requireMountPoint: dir, dataDir: '/var/lib/wallet-signer', logDir: join(dir, 'l') }), /dataDir .* is not under/)
	assert.throws(() => assertDataMount({ ...base, requireMountPoint: `${dir}x`, dataDir: `${dir}xy/s`, logDir: `${dir}x/l` }), /not under/)
	// No requirement configured: nothing checked.
	assertDataMount({ ...base, dataDir: join(dir, 's'), logDir: join(dir, 'l') })
	// A real mount point: /dev is its own filesystem on Linux and macOS (only stat'ed, nothing written).
	const devSource = mountSourceOf('/dev')
	assert.ok(devSource)
	assert.throws(
		() => assertDataMount({ ...base, requireMountPoint: '/dev', requireMountSource: '/dev/mapper/securedata', dataDir: '/dev/ws/s', logDir: '/dev/ws/l' }),
		/source mismatch/,
	)
	assertDataMount({ ...base, requireMountPoint: '/dev', requireMountSource: devSource, dataDir: '/dev/ws/s', logDir: '/dev/ws/l' })
	assert.deepEqual(readdirSync(dir), before)
	assert.equal(readFileSync(join(dir, 'keep'), 'utf8'), 'unchanged')
	assert.equal(existsUnwritten('/dev/ws'), false)
})

function existsUnwritten(path: string): boolean {
	try {
		readdirSync(path)
		return true
	} catch {
		return false
	}
}

test('idempotency fingerprint is the canonical request, not the key string', () => {
	const to = '0x1511Caa71081C84d8a591490D1b83879088EED72'
	const base = { array: 'chat_index_pointer', chainId: 224422, to, data: '0xAb', value: 0n }
	assert.equal(requestFingerprint(base), requestFingerprint({ ...base, to: to.toLowerCase(), data: '0xab' }))
	assert.notEqual(requestFingerprint(base), requestFingerprint({ ...base, data: '0xac' }))
	assert.notEqual(requestFingerprint(base), requestFingerprint({ ...base, value: 1n }))
	assert.notEqual(requestFingerprint(base), requestFingerprint({ ...base, gasLimit: 150_000n }))
	assert.notEqual(requestFingerprint(base), requestFingerprint({ ...base, array: 'settle_contractAdmin' }))
	assert.notEqual(requestFingerprint(base), requestFingerprint({ ...base, from: '0x0000000000000000000000000000000000000001' }))
})

test('verified typed-data nonce namespace follows the contract, not the caller', () => {
	const factory = '0xfA52a0CcC96C19cF4b6Ea864615F6d52BD0774FB'
	const signer = '0x0000000000000000000000000000000000000001'
	const other = '0x0000000000000000000000000000000000000009'
	const domain = { name: 'BeamioUserCardFactory', version: '1', chainId: 224422, verifyingContract: factory }
	const nonce = `0x${'22'.repeat(32)}`
	const message = {
		cardAddress: '0x0000000000000000000000000000000000000002',
		dataHash: `0x${'11'.repeat(32)}`,
		deadline: 1_900_000_000,
		nonce,
	}
	const admin = resolveTypedDataNonce(signer, domain, 'ExecuteForAdmin', message)
	const changed = resolveTypedDataNonce(signer, domain, 'ExecuteForAdmin', { ...message, dataHash: `0x${'33'.repeat(32)}` })
	assert.ok(admin && changed)
	assert.equal(admin!.id, changed!.id)
	assert.notEqual(admin!.contentHash, changed!.contentHash)
	const otherCard = resolveTypedDataNonce(signer, domain, 'ExecuteForAdmin', {
		...message,
		cardAddress: '0x0000000000000000000000000000000000000003',
	})
	const otherSigner = resolveTypedDataNonce(other, domain, 'ExecuteForAdmin', message)
	assert.notEqual(admin!.id, otherCard!.id)
	assert.notEqual(admin!.id, otherSigner!.id)
	const owner = resolveTypedDataNonce(signer, domain, 'ExecuteForOwner', message)
	const ownerOtherKey = resolveTypedDataNonce(other, domain, 'ExecuteForOwner', message)
	assert.equal(owner!.id, ownerOtherKey!.id)
	const clear = resolveTypedDataNonce(signer, domain, 'ClearAdminMintCounter', {
		...message,
		subordinate: '0x0000000000000000000000000000000000000004',
	})
	assert.notEqual(admin!.id, clear!.id)
	assert.equal(resolveTypedDataNonce(signer, domain, 'RecordUserLike', message), null)
	assert.equal(resolveTypedDataNonce(signer, domain, 'TerminalSettlementClear', message), null)
})

test('old pending journal reserves gasLimit times the highest stored price', () => {
	const row = (patch: Partial<TxRecord>): TxRecord => ({
		id: '1',
		client: 'c',
		array: 'a',
		chainId: 1,
		from: '0x0000000000000000000000000000000000000001',
		to: '0x0000000000000000000000000000000000000002',
		data: '0x',
		value: '0',
		nonce: 0,
		gasLimit: '100',
		type: 0,
		hash: `0x${'11'.repeat(32)}`,
		hashes: [],
		raw: '0x',
		status: 'sent',
		resends: 0,
		createdAt: '2026-11-08T00:00:00.000Z',
		updatedAt: '2026-11-08T00:00:00.000Z',
		lastSentAt: 0,
		...patch,
	})
	assert.equal(journalReservationWei(row({ gasPrice: '3', maxFeePerGas: '5' })), 500n)
	assert.equal(journalReservationWei(row({ budgetWei: '7', gasPrice: '3' })), 7n)
	assert.equal(journalReservationWei(row({ status: 'mined', feeWei: '4' })), 4n)
	assert.equal(journalReservationWei(row({})), 'unknown')
	assert.equal(journalReservationWei(row({ gasPrice: '0' })), 0n)
})

test('journal keeps old lines, drops a torn tail, and refuses an unwritable directory', () => {
	const dir = mkdtempSync(join(tmpdir(), 'journal-'))
	try {
		const path = join(dir, 'txjournal.jsonl')
		const oldLine = JSON.stringify({ id: 'old', client: 'c', idempotencyKey: 'k', status: 'sent', nonce: 0 })
		writeFileSync(path, `${oldLine}\n{"id":"torn"`)
		appendDurableJournalLine(path, `${JSON.stringify({ id: 'new', status: 'sent', nonce: 1 })}\n`)
		const records = parseJournal(readFileSync(path, 'utf8')) as Array<{ id?: string }>
		assert.deepEqual(records.map((row) => row.id), ['old', 'new'])
		const blocked = join(dir, 'blocked')
		mkdirSync(blocked, 0o555)
		assert.throws(() => appendDurableJournalLine(join(blocked, 'txjournal.jsonl'), '{"id":"no"}\n'), /EACCES|EPERM|permission/)
		chmodSync(blocked, 0o755)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('settle allow accepts one listed selector and rejects an unlisted selector or value; registration rejects a settle selector', () => {
	const phrase = newMnemonic()
	assert.equal(phrase.split(' ').length, 24)
	const hd = HdRoot.fromEntropy(mnemonicToEntropyBytes(phrase))
	const synthetic = hd.address(10, 0)
	hd.wipe()
	const policy = new Policy(JSON.parse(readFileSync(join(process.cwd(), 'deploy/policy.example.json'), 'utf8')))
	const aa = '0x869B31C87ABd9bFB858F5183Ef6021b28ED225E2'
	const listed = new Interface(['function createAccountFor(address) returns (address)'])
	const unlisted = new Interface(['function addPayMaster(address)'])
	const lists = { compromised: new Set<string>(), registry: new Set<string>() }
	const settle = { client: 'conet-beamio-api', array: 'settle_contractAdmin', chainId: 224422, to: aa, value: 0n }
	const data = listed.encodeFunctionData('createAccountFor', [synthetic])
	assert.equal(policy.checkCall({ ...settle, data }, lists).method, 'createAccountFor(address)')
	assert.throws(() => policy.checkCall({ ...settle, data: unlisted.encodeFunctionData('addPayMaster', [synthetic]) }, lists))
	assert.throws(() => policy.checkCall({ ...settle, value: 1n, data }, lists))
	assert.throws(() => policy.checkCall({
		client: 'conet-beamio-api',
		array: 'registrationAdmin',
		chainId: 224422,
		to: aa,
		value: 0n,
		data,
	}, lists))
})

test('locked restart checks receipts without rebroadcast; unlock resumes the same raw tx', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'ws-locked-restart-'))
	const methods: string[] = []
	const server = createServer((req, res) => {
		const chunks: Buffer[] = []
		req.on('data', (c) => chunks.push(c as Buffer))
		req.on('end', () => {
			const msg = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number; method: string }
			methods.push(msg.method)
			let result: string | null = null
			if (msg.method === 'eth_getTransactionCount') result = '0x1'
			if (msg.method === 'eth_chainId') result = '0x36ca6'
			if (msg.method === 'eth_sendRawTransaction') result = `0x${'ab'.repeat(32)}`
			reply(res, msg.id, result)
		})
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const port = (server.address() as { port: number }).port
	const wallet = Wallet.createRandom()
	const raw = await wallet.signTransaction({
		type: 0,
		chainId: 224422,
		nonce: 1,
		to: wallet.address,
		value: 0,
		gasLimit: 21_000,
		gasPrice: 1,
		data: '0x',
	})
	const hash = Transaction.from(raw).hash!
	const rec: TxRecord = {
		id: 'locked-restart',
		client: 'conet-beamio-api',
		array: 'registrationAdmin',
		chainId: 224422,
		from: wallet.address,
		to: wallet.address,
		data: '0x',
		value: '0',
		nonce: 1,
		gasLimit: '21000',
		type: 0,
		gasPrice: '1',
		hash,
		hashes: [hash],
		raw,
		status: 'sent',
		resends: 0,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		lastSentAt: 0,
	}
	writeFileSync(join(dir, 'txjournal.jsonl'), `${JSON.stringify(rec)}\n`)
	const gate = { unlocked: false }
	const txm = new TxManager(
		{ '224422': { rpcUrls: [`http://127.0.0.1:${port}`], resendAfterMs: 0, maxResends: 0, receiptPollMs: 20 } },
		gate as unknown as Keyring,
		new AuditLog(join(dir, 'audit.jsonl')),
		{ send() {} },
		join(dir, 'txjournal.jsonl'),
		1,
	)
	try {
		txm.start()
		await waitFor(() => methods.includes('eth_getTransactionReceipt'), 1000)
		await delay(80)
		assert.equal(methods.includes('eth_sendRawTransaction'), false)
		gate.unlocked = true
		await waitFor(() => methods.includes('eth_sendRawTransaction'), 1000)
	} finally {
		txm.stop()
		server.close()
		rmSync(dir, { recursive: true, force: true })
	}
})

test('gas keeper does not schedule while locked and schedules after unlock', () => {
	const dir = mkdtempSync(join(tmpdir(), 'ws-gas-locked-'))
	const gate = { unlocked: false }
	let sends = 0
	const gk = new GasKeeper(
		{},
		60_000,
		{ send() { sends += 1; return Promise.resolve() } } as unknown as TxManager,
		gate as unknown as Keyring,
		() => null,
		() => new Set<string>(),
		{ send() {} },
		new AuditLog(join(dir, 'audit.jsonl')),
		join(dir, 'gas.json'),
	)
	const timer = () => (gk as unknown as { timer?: unknown }).timer
	try {
		gk.start()
		assert.equal(timer(), undefined)
		assert.equal(sends, 0)
		gate.unlocked = true
		gk.start()
		assert.ok(timer())
		assert.equal(sends, 0)
	} finally {
		gk.stop()
		rmSync(dir, { recursive: true, force: true })
	}
})

test('worst-case native gas reserve is at least 21000 times the higher fee', () => {
	assert.equal(worstCaseNativeTransferGasWei(5n, 9n), 21_000n * 9n)
	assert.equal(worstCaseNativeTransferGasWei(5n, null), 21_000n * 5n)
	assert.equal(worstCaseNativeTransferGasWei(null, 4n), 21_000n * 4n)
	assert.equal(worstCaseNativeTransferGasWei(0n, null), undefined)
	assert.equal(worstCaseNativeTransferGasWei(null, null), undefined)
})

test('gas keeper total counts settled history after the UTC day changes', () => {
	const yesterday = new Date(Date.now() - 86_400_000).toISOString()
	const addr = '0x0000000000000000000000000000000000000001'
	const rows: SpendRow[] = [{
		idempotencyKey: 'migrated:224422:0x0000000000000000000000000000000000000001',
		chainId: '224422',
		address: addr,
		amountWei: '5000',
		recordedAt: yesterday,
		status: 'settled',
		attempt: 0,
	}]
	const used = gasKeeperUsage(rows, '224422', addr, new Date().toISOString())
	assert.equal(used.globalDaily, 0n)
	assert.equal(used.addressDaily, 0n)
	assert.equal(used.globalTotal, 5000n)
})

test('gas keeper reserves worst-case gas on the PM and refuses a balance that only covers the top-up', async () => {
	const fx = gasFixture({ gasPrice: 1n, maxFeePerGas: 10n })
	try {
		const amount = 1000n
		fx.balances.set(fx.pm, amount + 21_000n)
		fx.balances.set(fx.addr, 0n)
		await fx.gk.runOnce()
		assert.equal(fx.sends.length, 0)
		assert.ok(fx.alerts.some((code) => code.startsWith('pm-empty:')))
		fx.balances.set(fx.pm, amount + 21_000n * 10n)
		await fx.gk.runOnce()
		assert.equal(fx.sends.length, 1)
		assert.equal(fx.sends[0]!.value, amount)
		assert.equal(fx.sends[0]!.gasLimit, 21_000n)
		assert.equal(fx.sends[0]!.idempotencyKey, gasKeeperTopupIdempotencyKey(224422, fx.addr, 1))
	} finally {
		fx.cleanup()
	}
})

test('gas keeper idempotency key is stable and an unconfirmed top-up is not sent again after restart', async () => {
	const fx = gasFixture({ gasPrice: 2n, maxFeePerGas: null })
	try {
		const amount = 1000n
		fx.balances.set(fx.pm, amount + 21_000n * 2n)
		fx.balances.set(fx.addr, 0n)
		await fx.gk.runOnce()
		assert.equal(fx.sends.length, 1)
		const key = fx.sends[0]!.idempotencyKey!
		assert.equal(key, `topup:224422:${fx.addr.toLowerCase()}:1`)
		assert.equal(key.includes(String(Date.now())), false)
		const disk = JSON.parse(readFileSync(fx.statePath, 'utf8')) as { version: number; spend: SpendRow[] }
		assert.equal(disk.version, 2)
		assert.equal(disk.spend[0]!.status, 'pending')
		assert.equal(disk.spend[0]!.idempotencyKey, key)
		assert.equal(disk.spend[0]!.hash, fx.sends[0]!.hash)
		fx.failSend = true
		const restarted = fx.restart()
		await restarted.runOnce()
		assert.equal(fx.sends.length, 1)
	} finally {
		fx.cleanup()
	}
})

test('gas keeper does not broadcast when a pending top-up is only on disk', async () => {
	const fx = gasFixture({ gasPrice: 1n, maxFeePerGas: null })
	try {
		const key = gasKeeperTopupIdempotencyKey(224422, fx.addr, 1)
		const row: SpendRow = {
			idempotencyKey: key,
			chainId: '224422',
			address: fx.addr.toLowerCase(),
			amountWei: '1000',
			recordedAt: new Date(Date.now() - 86_400_000).toISOString(),
			status: 'pending',
			attempt: 1,
			hash: `0x${'ab'.repeat(32)}`,
		}
		writeFileSync(fx.statePath, JSON.stringify({ version: 2, spend: [row] }))
		fx.remember({ hash: row.hash, status: 'sent', idempotencyKey: key })
		fx.balances.set(fx.pm, 10_000_000n)
		fx.balances.set(fx.addr, 0n)
		await fx.gk.runOnce()
		assert.equal(fx.sends.length, 0)
	} finally {
		fx.cleanup()
	}
})

test('gas keeper total budget does not refill when the UTC day field changes', async () => {
	const fx = gasFixture({ gasPrice: 1n, maxFeePerGas: null })
	try {
		const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
		writeFileSync(fx.statePath, JSON.stringify({
			day: yesterday,
			global: { '224422': '5000' },
			perAddress: { [`224422:${fx.addr.toLowerCase()}`]: '5000' },
		}))
		fx.balances.set(fx.pm, 5_000_000n)
		fx.balances.set(fx.addr, 0n)
		await fx.gk.runOnce()
		assert.equal(fx.sends.length, 0)
		assert.ok(fx.alerts.includes('topup-total-cap:224422'))
	} finally {
		fx.cleanup()
	}
})

test('gas keeper per-address daily window still opens on a new UTC day while the chain total remains', async () => {
	const fx = gasFixture({ gasPrice: 1n, maxFeePerGas: null })
	try {
		const yesterday = new Date(Date.now() - 86_400_000).toISOString()
		const row: SpendRow = {
			idempotencyKey: 'migrated:addr',
			chainId: '224422',
			address: fx.addr.toLowerCase(),
			amountWei: '1000',
			recordedAt: yesterday,
			status: 'settled',
			attempt: 0,
		}
		writeFileSync(fx.statePath, JSON.stringify({ version: 2, day: new Date().toISOString().slice(0, 10), spend: [row] }))
		fx.balances.set(fx.pm, 1000n + 21_000n)
		fx.balances.set(fx.addr, 0n)
		await fx.gk.runOnce()
		assert.equal(fx.sends.length, 1)
		assert.equal(fx.sends[0]!.idempotencyKey, gasKeeperTopupIdempotencyKey(224422, fx.addr, 1))
	} finally {
		fx.cleanup()
	}
})

test('gas keeper config stays disabled and an empty whitelist tops up nobody', () => {
	const { writeFileSync } = require('node:fs') as typeof import('node:fs')
	const { loadConfig } = require('../src/config') as typeof import('../src/config')
	const dir = mkdtempSync(join(tmpdir(), 'ws-gas-cfg-'))
	const p = join(dir, 'c.json')
	writeFileSync(p, JSON.stringify({
		dataDir: dir,
		adminSocket: join(dir, 'a.sock'),
		policyFile: join(dir, 'p.json'),
		chains: { '224422': { rpcUrls: ['http://127.0.0.1:9'] } },
		gasKeeper: {
			enabled: false,
			intervalMs: 60_000,
			chains: { '224422': { minWei: '1', targetWei: '2', perAddressDailyWei: '3', globalDailyWei: '4', pmWarnWei: '5', pmCriticalWei: '6' } },
		},
	}))
	const cfg = loadConfig(p)
	assert.equal(cfg.gasKeeper.enabled, false)
	assert.deepEqual(cfg.gasKeeper.chains['224422']!.wallets, [])
	const omitted = join(dir, 'omitted.json')
	writeFileSync(omitted, JSON.stringify({ dataDir: dir, adminSocket: join(dir, 'a.sock'), policyFile: join(dir, 'p.json'), chains: { '224422': { rpcUrls: ['http://127.0.0.1:9'] } } }))
	assert.equal(loadConfig(omitted).gasKeeper.enabled, false)
	assert.throws(() => {
		writeFileSync(p, JSON.stringify({
			dataDir: dir,
			adminSocket: join(dir, 'a.sock'),
			policyFile: join(dir, 'p.json'),
			chains: { '224422': { rpcUrls: ['http://127.0.0.1:9'] } },
			gasKeeper: { enabled: false, chains: { '224422': { wallets: ['not-an-address'], budgetWei: '1', minWei: '1', targetWei: '1', perAddressDailyWei: '1', globalDailyWei: '1', pmWarnWei: '1', pmCriticalWei: '1' } } },
		}))
		loadConfig(p)
	}, /wallets\[0\]/)
})

test('gas keeper refuses the oracle address unless it is on the business-wallet whitelist', async () => {
	const other = getAddress(Wallet.createRandom().address)
	const fx = gasFixture({ gasPrice: 1n, maxFeePerGas: null }, {
		wallets: [other],
		registryAddresses: [other, ORACLE_GAS_WALLET],
	})
	try {
		fx.balances.set(fx.pm, 5_000_000n)
		fx.balances.set(other, 0n)
		fx.balances.set(ORACLE_GAS_WALLET, 0n)
		fx.balances.set(fx.addr, 0n)
		await fx.gk.runOnce()
		assert.equal(fx.sends.length, 1)
		assert.equal(getAddress(fx.sends[0]!.to), other)
		assert.equal(fx.sends.some((row) => getAddress(row.to) === getAddress(ORACLE_GAS_WALLET)), false)
		assert.equal(fx.sends.some((row) => getAddress(row.to) === fx.addr), false)
	} finally {
		fx.cleanup()
	}
})

test('gas keeper refuses a top-up that exceeds the explicit budget', async () => {
	const fx = gasFixture({ gasPrice: 1n, maxFeePerGas: null }, {
		wallets: [ORACLE_GAS_WALLET],
		budgetWei: '10',
		perAddressDailyWei: '500000',
		globalDailyWei: '500000',
	})
	try {
		fx.balances.set(fx.pm, 5_000_000n)
		fx.balances.set(ORACLE_GAS_WALLET, 0n)
		await fx.gk.runOnce()
		assert.equal(fx.sends.length, 0)
		assert.ok(fx.alerts.includes('topup-budget:224422'))
	} finally {
		fx.cleanup()
	}
})

test('gas keeper does not sign while locked even when the oracle wallet is whitelisted', async () => {
	const fx = gasFixture({ gasPrice: 1n, maxFeePerGas: null }, { wallets: [ORACLE_GAS_WALLET], unlocked: false })
	try {
		fx.balances.set(fx.pm, 5_000_000n)
		fx.balances.set(ORACLE_GAS_WALLET, 0n)
		await fx.gk.runOnce()
		assert.equal(fx.sends.length, 0)
		assert.equal(fx.providerCalls, 0)
	} finally {
		fx.cleanup()
	}
})

test('gas keeper tops up a whitelisted oracle from the PM on a local mock', async () => {
	const bystander = getAddress(Wallet.createRandom().address)
	const fx = gasFixture({ gasPrice: 1n, maxFeePerGas: null }, {
		wallets: [ORACLE_GAS_WALLET],
		registryAddresses: [bystander],
		budgetWei: '1000000',
	})
	try {
		const amount = 1000n
		fx.balances.set(fx.pm, amount + 21_000n)
		fx.balances.set(ORACLE_GAS_WALLET, 0n)
		fx.balances.set(bystander, 0n)
		await fx.gk.runOnce()
		assert.equal(fx.sends.length, 1)
		const sent = fx.sends[0]!
		assert.equal(getAddress(sent.to), getAddress(ORACLE_GAS_WALLET))
		assert.equal(sent.value, amount)
		assert.equal(sent.client, 'gas-keeper')
		assert.notEqual(sent.client, ORACLE_DAEMON_CLIENT)
		assert.equal(sent.array, 'PM')
		assert.deepEqual(sent.candidates.map((addr) => getAddress(addr)), [fx.pm])
		assert.equal(sent.candidates.includes(bystander), false)
	} finally {
		fx.cleanup()
	}
})

test('oracle-daemon cannot reach the gas keeper through client RPC or an admin-socket argument', () => {
	assert.equal(gasTopupRpcRefusal('signer_sendTransaction', ORACLE_DAEMON_CLIENT), null)
	assert.equal(gasTopupRpcRefusal('signer_topup', ORACLE_DAEMON_CLIENT), 'oracle-daemon')
	assert.equal(gasTopupRpcRefusal('gas.run', 'conet-beamio-api'), 'client-rpc')
	assert.equal(adminGasRunRefusal({}), null)
	assert.equal(adminGasRunRefusal({ client: ORACLE_DAEMON_CLIENT }), 'oracle-daemon')
	assert.equal(adminGasRunRefusal({ address: ORACLE_GAS_WALLET }), 'caller-or-target')
})

function gasFixture(fee: { gasPrice: bigint | null; maxFeePerGas: bigint | null }, opts: {
	wallets?: string[]
	budgetWei?: string
	perAddressDailyWei?: string
	globalDailyWei?: string
	unlocked?: boolean
	registryAddresses?: string[]
} = {}): {
	gk: GasKeeper
	restart: () => GasKeeper
	pm: string
	addr: string
	statePath: string
	sends: Array<{ idempotencyKey?: string; value: bigint; gasLimit?: bigint; hash: string; to: string; client?: string; array?: string; candidates: string[] }>
	alerts: string[]
	balances: Map<string, bigint>
	providerCalls: number
	remember: (rec: { hash?: string; status?: string; idempotencyKey?: string }) => void
	failSend: boolean
	cleanup: () => void
} {
	const dir = mkdtempSync(join(tmpdir(), 'ws-gas-keeper-'))
	const statePath = join(dir, 'gaskeeper-state.json')
	const pm = getAddress(Wallet.createRandom().address)
	const addr = getAddress(Wallet.createRandom().address)
	const balances = new Map<string, bigint>()
	const alerts: string[] = []
	const sends: Array<{ idempotencyKey?: string; value: bigint; gasLimit?: bigint; hash: string; to: string; client?: string; array?: string; candidates: string[] }> = []
	let providerCallsSeen = 0
	const records = new Map<string, { hash?: string; status?: string; idempotencyKey?: string }>()
	const fx = {
		failSend: false,
		remember(rec: { hash?: string; status?: string; idempotencyKey?: string }) {
			if (rec.idempotencyKey) records.set(rec.idempotencyKey, rec)
			if (rec.hash) records.set(rec.hash, rec)
		},
	}
	const txm = {
		provider() {
			providerCallsSeen += 1
			return {
				async getBalance(who: string) {
					return balances.get(getAddress(who)) ?? 0n
				},
				async getFeeData() {
					return fee
				},
			}
		},
		inflightCount() {
			return 0
		},
		get(query: { idempotencyKey?: string; hash?: string }) {
			if (query.idempotencyKey) return records.get(query.idempotencyKey)
			if (query.hash) return records.get(query.hash)
			return undefined
		},
		async send(req: { idempotencyKey?: string; value: bigint; gasLimit?: bigint; to: string; client?: string; array?: string; candidates?: string[] }) {
			if (fx.failSend) throw new Error('restart must not broadcast')
			const disk = JSON.parse(readFileSync(statePath, 'utf8')) as { spend: SpendRow[] }
			const pending = disk.spend.find((row) => row.idempotencyKey === req.idempotencyKey)
			assert.equal(pending?.status, 'pending')
			assert.equal(pending?.hash, undefined)
			const hash = `0x${(sends.length + 1).toString(16).padStart(64, '0')}`
			const rec = { hash, status: 'sent', idempotencyKey: req.idempotencyKey }
			sends.push({
				idempotencyKey: req.idempotencyKey,
				value: req.value,
				gasLimit: req.gasLimit,
				hash,
				to: req.to,
				client: req.client,
				array: req.array,
				candidates: req.candidates ?? [],
			})
			if (req.idempotencyKey) records.set(req.idempotencyKey, rec)
			records.set(hash, rec)
			return rec
		},
	}
	const chain = {
		'224422': {
			minWei: '100',
			targetWei: '1000',
			perAddressDailyWei: opts.perAddressDailyWei ?? '1000',
			globalDailyWei: opts.globalDailyWei ?? '5000',
			budgetWei: opts.budgetWei ?? '1000000',
			pmWarnWei: '1',
			pmCriticalWei: '1',
			wallets: opts.wallets ?? [addr],
		},
	}
	const registry = () => ({
		version: 1 as const,
		pm,
		attestor: pm,
		updatedAt: '2026-01-01T00:00:00.000Z',
		arrays: [{
			name: 'settle',
			account: 10,
			count: 1,
			chains: [224422],
			status: 'active' as const,
			addresses: opts.registryAddresses ?? [addr],
			createdAt: '2026-01-01T00:00:00.000Z',
		}],
	})
	const make = () => new GasKeeper(
		chain,
		60_000,
		txm as unknown as TxManager,
		{ unlocked: opts.unlocked !== false } as unknown as Keyring,
		registry,
		() => new Set<string>(),
		{ send(_level: string, code: string) { alerts.push(code) } },
		new AuditLog(join(dir, 'audit.jsonl')),
		statePath,
	)
	return {
		gk: make(),
		restart: make,
		pm,
		addr,
		statePath,
		sends,
		alerts,
		balances,
		get providerCalls() { return providerCallsSeen },
		remember: fx.remember,
		get failSend() { return fx.failSend },
		set failSend(value: boolean) { fx.failSend = value },
		cleanup() { rmSync(dir, { recursive: true, force: true }) },
	}
}

function reply(res: ServerResponse, id: number, result: string | null): void {
	res.setHeader('content-type', 'application/json')
	res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
	const start = Date.now()
	while (!pred()) {
		if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for rpc')
		await delay(10)
	}
}
