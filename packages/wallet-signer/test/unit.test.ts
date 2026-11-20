import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Interface, Transaction, Wallet, getAddress, zeroPadValue } from 'ethers'
import { AuditLog, verifyAuditFile } from '../src/audit'
import { HdRoot, mnemonicToEntropyBytes, newMnemonic } from '../src/hd'
import { Keyring } from '../src/keyring'
import { Policy } from '../src/policy'
import { RateLimiter } from '../src/rateLimit'
import { redactText } from '../src/redact'
import { addArray, emptyRegistry, growArray, rotateArray, signRegistry, verifyRegistry } from '../src/registry'
import { resolveTypedDataNonce } from '../src/typedDataReplay'
import { TypedDataReplayLog } from '../src/typedDataReplay'
import { BEAMIO_ORACLE_CONTRACT, GAS_KEEPER_CHAIN_ID, GasKeeper, LAB_POSTSIGN_TARGET_WEI, LAB_POSTSIGN_THRESHOLD_WEI, ORACLE_DAEMON_CLIENT, ORACLE_OWNER_ARRAY, ORACLE_OWNER_WALLET_EXAMPLE, adminGasRunRefusal, decodeAddressWord, gasKeeperTopupIdempotencyKey, gasKeeperUsage, gasTopupRpcRefusal, isEmptyRuntimeCode, oracleQuoteNeedWei, selectOracleOwnerRecipients, worstCaseNativeTransferGasWei, type SpendRow } from '../src/gasKeeper'
import type { KeyArray } from '../src/registry'
import { journalReservationWei, requestFingerprint, TxManager, type TxRecord } from '../src/txManager'
import { appendDurableJournalLine, parseJournal } from '../src/txJournal'
import { createVaultJson, openVault } from '../src/vault'
import { SignerService } from '../src/service'
import { decodeLabInitialGasAdminStatus, encodeLabInitialGasAdminCall, PM_LAB_INITIAL_GAS_ADMIN_SELECTOR, PM_LAB_INITIAL_GAS_CHAIN_ID, PM_LAB_INITIAL_GAS_CLIENT, PM_LAB_INITIAL_GAS_GAS_LIMIT, PM_LAB_INITIAL_GAS_IDEMPOTENCY_KEY, PM_LAB_INITIAL_GAS_MAX_FEE_WEI, PM_LAB_INITIAL_GAS_MAX_TOTAL_WEI, PM_LAB_INITIAL_GAS_RECIPIENT, PM_LAB_INITIAL_GAS_TARGET_WEI, requireMatchingLabInitialGasSnapshots, runPmLabInitialGas, type LabInitialGasDeps, type LabInitialGasSnapshot } from '../src/pmLabInitialGas'
import { PM_GRANT_CLIENT, PM_GRANT_VDR } from '../src/pmGrantAdmin'

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
	// Test fixture only (not a real account).
	const denied = '0x5a1ab0000000000000000000000000000000f4f4'
	const p = new Policy({
		version: 1,
		clients: {
			dl: {
				arrays: {
					epochManagre: {
						chains: [224422],
						allow: [
							{ to: epoch, selectors: ['updateInfo(uint256,uint256,uint256)'], maxGas: 300000 },
							{ to: epoch, selectors: ['changeAddressInAdminlist(address,bool)'], args: { '0': { in: '@denied' }, '1': { eq: false } } },
						],
					},
				},
			},
		},
	})
	const iface = new Interface(['function updateInfo(uint256,uint256,uint256)', 'function changeAddressInAdminlist(address,bool)'])
	const lists = { denied: new Set([denied]), registry: new Set<string>() }
	const base = { client: 'dl', array: 'epochManagre', chainId: 224422, to: epoch, value: 0n }
	assert.equal(p.checkCall({ ...base, data: iface.encodeFunctionData('updateInfo', [1, 2, 3]) }, lists).method, 'updateInfo(uint256,uint256,uint256)')
	assert.ok(p.checkCall({ ...base, data: iface.encodeFunctionData('changeAddressInAdminlist', [denied, false]) }, lists))
	assert.throws(() => p.checkCall({ ...base, data: iface.encodeFunctionData('changeAddressInAdminlist', [denied, true]) }, lists))
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
	const lists = { denied: new Set<string>(), registry: new Set<string>() }
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
	const base = { adminSocket: '', policyFile: '', deniedAddressesFile: '', rpc: {}, chains: {}, gasKeeper: { enabled: false, intervalMs: 1, chains: {}, refusedOwners: [] }, pmLabInitialGas: { enabled: false, dryRun: true, maxSpendWei: '0', dailyCapWei: '0', maxFeePerGasWei: '0' }, alerts: {}, scryptN: 1, keyWaitMs: 1 }
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
	const lists = { denied: new Set<string>(), registry: new Set<string>() }
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

test('post-sign reads the signing wallet, uses the existing whitelist, and funds only below the configured minimum', async () => {
	const cap = '1000000000000000000'
	const fx = gasFixture({ gasPrice: 1n, maxFeePerGas: null }, { targetWei: cap, perAddressDailyWei: cap, globalDailyWei: cap, budgetWei: cap })
	try {
		fx.balances.set(fx.addr, LAB_POSTSIGN_THRESHOLD_WEI)
		fx.balances.set(fx.pm, 1_000_000_000_000_000_000n)
		await fx.gk.afterSuccessfulSignature(fx.addr)
		assert.equal(fx.sends.length, 0, 'equality with minWei is not below threshold')
		fx.balances.set(fx.addr, LAB_POSTSIGN_THRESHOLD_WEI - 1n)
		await fx.gk.afterSuccessfulSignature(fx.addr)
		assert.equal(fx.sends.length, 1)
		assert.equal(fx.sends[0]!.to, fx.addr)
		assert.equal(fx.sends[0]!.value, LAB_POSTSIGN_TARGET_WEI - LAB_POSTSIGN_THRESHOLD_WEI + 1n)
		const before = fx.balanceReads
		await fx.gk.afterSuccessfulSignature(getAddress(Wallet.createRandom().address))
		assert.equal(fx.balanceReads, before + 1, 'an unlisted signing wallet is still read')
		assert.equal(fx.sends.length, 1, 'an unlisted wallet is not funded')
	} finally { fx.cleanup() }
})

test('post-sign balance RPC failure stays unavailable and never falls through to a zero balance', async () => {
	const fx = gasFixture({ gasPrice: 1n, maxFeePerGas: null })
	try {
		fx.balances.set(fx.pm, 10_000_000n)
		fx.balanceFailure = true
		await fx.gk.afterSuccessfulSignature(fx.addr)
		assert.equal(fx.sends.length, 0)
		assert.match(readFileSync(fx.auditPath, 'utf8'), /gas\.postsign\.unavailable/)
	} finally { fx.cleanup() }
})

test('post-sign still reads while signer is locked but does not fund', async () => {
	const cap = '1000000000000000000'
	const fx = gasFixture({ gasPrice: 1n, maxFeePerGas: null }, { unlocked: false, targetWei: cap, perAddressDailyWei: cap, globalDailyWei: cap, budgetWei: cap })
	try {
		fx.balances.set(fx.addr, 1n)
		fx.balances.set(fx.pm, 1_000_000_000_000_000_000n)
		await fx.gk.afterSuccessfulSignature(fx.addr)
		assert.equal(fx.balanceReads, 1)
		assert.equal(fx.sends.length, 0)
	} finally { fx.cleanup() }
})

test('post-sign concurrent checks serialize and a mined old intent gets a fresh attempt key', async () => {
	const cap = '1000000000000000000'
	const fx = gasFixture({ gasPrice: 1n, maxFeePerGas: null }, { targetWei: cap, perAddressDailyWei: cap, globalDailyWei: cap, budgetWei: cap })
	const key = gasKeeperTopupIdempotencyKey(224422, fx.addr, 1)
	const hash = `0x${'ab'.repeat(32)}`
	fx.remember({ idempotencyKey: key, hash, status: 'mined' })
	fx.balances.set(fx.addr, 1n)
	fx.balances.set(fx.pm, 1_000_000_000_000_000_000n)
	writeFileSync(fx.statePath, JSON.stringify({ version: 2, spend: [{ idempotencyKey: key, chainId: '224422', address: fx.addr.toLowerCase(), amountWei: '123', recordedAt: new Date().toISOString(), status: 'pending', attempt: 1, hash }] }))
	try {
		await Promise.all([fx.gk.afterSuccessfulSignature(fx.addr), fx.gk.afterSuccessfulSignature(fx.addr)])
		assert.equal(fx.sends.length, 1)
		assert.notEqual(fx.sends[0]!.idempotencyKey, key)
		const state = JSON.parse(readFileSync(fx.statePath, 'utf8')) as { spend: SpendRow[] }
		assert.equal(state.spend[0]!.status, 'settled')
		assert.equal(state.spend[1]!.status, 'pending')
		assert.equal(state.spend[1]!.attempt, 2)
	} finally { fx.cleanup() }
})

test('post-sign refreshes a balance after a mined pending row and does not create another attempt when the top-up arrived', async () => {
	const cap = '1000000000000000000'
	const fx = gasFixture({ gasPrice: 1n, maxFeePerGas: null }, { targetWei: cap, perAddressDailyWei: cap, globalDailyWei: cap, budgetWei: cap })
	const key = gasKeeperTopupIdempotencyKey(224422, fx.addr, 1)
	const hash = `0x${'bc'.repeat(32)}`
	fx.remember({ idempotencyKey: key, hash, status: 'mined' })
	fx.balanceSequence.push(LAB_POSTSIGN_THRESHOLD_WEI - 1n, LAB_POSTSIGN_THRESHOLD_WEI)
	fx.balances.set(fx.pm, 1_000_000_000_000_000_000n)
	writeFileSync(fx.statePath, JSON.stringify({ version: 2, spend: [{ idempotencyKey: key, chainId: '224422', address: fx.addr.toLowerCase(), amountWei: '123', recordedAt: new Date().toISOString(), status: 'pending', attempt: 1, hash }] }))
	try {
		await fx.gk.afterSuccessfulSignature(fx.addr)
		assert.equal(fx.sends.length, 0, 'fresh threshold-or-higher balance prevents retry payment')
		const state = JSON.parse(readFileSync(fx.statePath, 'utf8')) as { spend: SpendRow[] }
		assert.equal(state.spend[0]!.status, 'settled')
		assert.equal(state.spend.length, 1)
		assert.equal(fx.balanceReads, 2)
	} finally { fx.cleanup() }
})

test('post-sign releases a hashless intent when refreshed balance is sufficient and recalculates a later attempt', async () => {
	const cap = '1000000000000000000'
	const low = 5_000_000_000_000_000n
	const fx = gasFixture({ gasPrice: 1n, maxFeePerGas: null }, { targetWei: cap, perAddressDailyWei: cap, globalDailyWei: cap, budgetWei: cap })
	const key = gasKeeperTopupIdempotencyKey(224422, fx.addr, 1)
	fx.balanceSequence.push(low, LAB_POSTSIGN_THRESHOLD_WEI, low)
	fx.balances.set(fx.pm, 1_000_000_000_000_000_000n)
	writeFileSync(fx.statePath, JSON.stringify({ version: 2, spend: [{ idempotencyKey: key, chainId: '224422', address: fx.addr.toLowerCase(), amountWei: '123', recordedAt: new Date().toISOString(), status: 'pending', attempt: 1 }] }))
	try {
		await fx.gk.afterSuccessfulSignature(fx.addr)
		let state = JSON.parse(readFileSync(fx.statePath, 'utf8')) as { spend: SpendRow[] }
		assert.equal(state.spend[0]!.status, 'released', 'unbroadcast intent is durably released once the fresh balance is sufficient')
		assert.equal(fx.sends.length, 0)

		await fx.gk.afterSuccessfulSignature(fx.addr)
		state = JSON.parse(readFileSync(fx.statePath, 'utf8')) as { spend: SpendRow[] }
		assert.equal(fx.sends.length, 1)
		assert.notEqual(fx.sends[0]!.idempotencyKey, key, 'later shortfall gets a new idempotency key')
		assert.equal(fx.sends[0]!.value, LAB_POSTSIGN_TARGET_WEI - low, 'new amount uses the new low balance, not the stale row amount')
		assert.equal(state.spend[1]!.amountWei, (LAB_POSTSIGN_TARGET_WEI - low).toString())
		assert.equal(state.spend[1]!.attempt, 2)
	} finally { fx.cleanup() }
})

test('post-sign service checks each newly created signature but not typed-data replay or wait reuse', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'post-sign-service-'))
	const wallet = Wallet.createRandom()
	const address = getAddress(wallet.address)
	const raw = await wallet.signTransaction({ chainId: 224422, nonce: 0, to: address, value: 0, gasLimit: 21_000, gasPrice: 1, data: '0x' })
	const checks: string[] = []
	const sends: Array<Record<string, unknown>> = []
	const makeService = (replayPath: string): SignerService => {
		const target = Object.create(SignerService.prototype) as SignerService
		const mutable = target as unknown as Record<string, unknown>
		Object.assign(mutable, {
			state: 'unlocked',
			registry: { version: 1, pm: Wallet.createRandom().address, attestor: Wallet.createRandom().address, arrays: [{ name: 'lab', account: 1, count: 1, chains: [224422], status: 'active', addresses: [address], createdAt: new Date(0).toISOString() }], updatedAt: new Date(0).toISOString(), attestation: '' },
			denied: new Set<string>(),
			keyring: {
				info: () => ({ role: 'array', array: 'lab', address }),
				signTransaction: () => raw,
				signMessage: () => `0x${'11'.repeat(65)}`,
				signTypedData: () => `0x${'22'.repeat(65)}`,
			},
			policy: {
				grant: () => ({ allowSignOnly: true, allowPersonalSign: true, rate: {} }),
				checkCall: () => ({ grant: { rate: {} }, method: 'test', args: [] }),
				checkTypedData: () => ({ rate: {} }),
			},
			audit: { write() {} },
			txm: { async send(req: Record<string, unknown>) { sends.push(req); return { hash: `0x${'66'.repeat(32)}`, from: address, nonce: 1, chainId: 224422, status: 'sent', raw: '0x' } } },
			gasKeeper: { async afterSuccessfulSignature(who: string) { checks.push(who) } },
			typedDataReplay: new TypedDataReplayLog(replayPath),
			activeAddresses: () => [address],
			registrySet: () => new Set<string>(),
			takeRate() {},
		})
		return target
	}
	const service = makeService(join(dir, 'replay.jsonl'))
	const typed = {
		domain: { name: 'BeamioUserCardFactory', version: '1', chainId: 224422, verifyingContract: '0x0000000000000000000000000000000000001000' },
		types: { ExecuteForAdmin: [
			{ name: 'cardAddress', type: 'address' },
			{ name: 'dataHash', type: 'bytes32' },
			{ name: 'deadline', type: 'uint256' },
			{ name: 'nonce', type: 'bytes32' },
		] },
		primaryType: 'ExecuteForAdmin',
		message: { cardAddress: '0x0000000000000000000000000000000000002000', dataHash: `0x${'33'.repeat(32)}`, deadline: 1_900_000_000, nonce: `0x${'44'.repeat(32)}` },
	}
	try {
		await service.signTransaction('client', { from: address, chainId: 224422, nonce: 0, to: address, value: '0', gasLimit: '21000', gasPrice: '1', data: '0x' })
		await service.personalSign('client', 'message', address)
		await service.signTypedData('client', address, typed)
		await service.signTypedData('client', address, typed)
		assert.deepEqual(checks, [address, address, address], 'replay reuses an existing signature without another balance check')
		await service.sendTransaction('gas-keeper', { keyArray: 'lab', chainId: 224422, from: address, to: address, data: '0x', value: '0', skipPostSignCheck: true } as never)
		assert.equal(sends[0]!.client, 'gas-keeper')
		assert.equal(sends[0]!.skipPostSignCheck, undefined, 'RPC input cannot set the internal recursion marker')

		const waitPath = join(dir, 'wait.jsonl')
		const waitService = makeService(waitPath)
		const binding = resolveTypedDataNonce(address, typed.domain, 'ExecuteForAdmin', typed.message)!
		const replay = waitService.typedDataReplay.reserve(binding)
		assert.equal(replay.mode, 'fresh')
		const waiting = waitService.signTypedData('client', address, typed)
		await delay(0)
		if (replay.mode === 'fresh') replay.resolve(`0x${'55'.repeat(65)}`)
		assert.equal(await waiting, `0x${'55'.repeat(65)}`)
		assert.equal(checks.length, 3, 'wait returns an existing signature without another balance check')
	} finally { rmSync(dir, { recursive: true, force: true }) }
})

test('TxManager checks new signatures regardless of client name, marks internal top-ups, and skips same-raw rebroadcast', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'post-sign-txm-'))
	const hd = HdRoot.fromEntropy(mnemonicToEntropyBytes(newMnemonic()))
	const keyring = new Keyring()
	keyring.load(hd, null)
	const from = keyring.pmAddress
	const to = Wallet.createRandom().address
	let price = 1n
	let broadcasts = 0
	const hookCalls: Array<{ client: string; address: string; internal: boolean }> = []
	const txm = new TxManager({ '224422': { rpcUrls: ['http://127.0.0.1:1'], resendAfterMs: 0, maxResends: 1, receiptPollMs: 1000 } }, keyring, new AuditLog(join(dir, 'audit.jsonl')), { send() {} }, join(dir, 'txjournal.jsonl'), 1)
	const internals = txm as unknown as { chains: Map<number, { provider: unknown; cfg: { resendAfterMs: number; maxResends: number } }>; track: (row: TxRecord) => Promise<void> }
	const ctx = internals.chains.get(224422)!
	ctx.provider = {
		async getFeeData() { return { gasPrice: price, maxFeePerGas: null, maxPriorityFeePerGas: null } },
		async getBalance() { return 1_000_000_000_000_000_000n },
		async getTransactionCount() { return 0 },
		async getTransactionReceipt() { return null },
		async broadcastTransaction(raw: string) { broadcasts++; return { hash: Transaction.from(raw).hash } },
	} as never
	txm.setPostSignHook(async (client, address, internal) => { hookCalls.push({ client, address, internal }) })
	const base = { array: 'PM', chainId: 224422, candidates: [from], from, to, data: '0x', value: 0n, gasLimit: 21_000n, maxInflightPerKey: 4, skipSimulation: true }
	try {
		let signCalls = 0
		const sign = keyring.signTransaction.bind(keyring)
		keyring.signTransaction = ((address: string, tx: never) => { signCalls++; return sign(address, tx) }) as typeof keyring.signTransaction
		await assert.rejects(txm.send({ ...base, client: 'lab-initial-gas', idempotencyKey: 'nonce-mismatch', expectedNonce: 99 }), /nonce changed/)
		assert.equal(signCalls, 0, 'nonce mismatch is rejected while holding the PM nonce lock, before signing')
		assert.equal(hookCalls.length, 0)
		const pmState = (txm as unknown as { state: (chainId: number, address: string) => { floor: number } }).state(224422, from)
		pmState.floor = 1
		await assert.rejects(txm.send({ ...base, client: 'lab-initial-gas', idempotencyKey: 'nonce-floor-ahead', expectedNonce: 0 }), /nonce floor is newer/)
		assert.equal(signCalls, 0, 'journal floor newer than preflight nonce must fail before signing')
		assert.equal(broadcasts, 0, 'journal floor newer than preflight nonce must fail before broadcasting')
		pmState.floor = 0
		await txm.send({ ...base, client: 'gas-keeper', idempotencyKey: 'same-name-external-client', expectedNonce: 0 })
		assert.equal(hookCalls.length, 1, 'client text cannot spoof the internal bypass')
		assert.equal(hookCalls[0]!.internal, false)
		await txm.send({ ...base, client: 'gas-keeper', idempotencyKey: 'internal-transfer', skipPostSignCheck: true })
		assert.equal(hookCalls.length, 2, 'hook receives the explicit internal marker')
		assert.equal(hookCalls[1]!.internal, true, 'internal marker, not client identity text, identifies recursion')
		const userRow = txm.recent(10).find((row) => row.idempotencyKey === 'same-name-external-client')!
		price = 2n
		await internals.track(userRow)
		assert.equal(hookCalls.length, 3, 'a newly signed reprice is checked')
		const repriced = txm.recent(10).find((row) => row.idempotencyKey === 'same-name-external-client')!
		await internals.track({ ...repriced, lastSentAt: 0 })
		assert.equal(hookCalls.length, 3, 'same-raw rebroadcast is not a new signature')
		assert.equal(broadcasts, 4)
	} finally {
		keyring.wipe()
		hd.wipe()
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
		const amount = oracleQuoteNeedWei(1n, 10n)!
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
		const amount = oracleQuoteNeedWei(2n, null)!
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

test('an unconfirmed pending from yesterday still reserves today and the persistent budget', async () => {
	const yesterday = new Date(Date.now() - 86_400_000).toISOString()
	const fx = gasFixture({ gasPrice: 1n, maxFeePerGas: null }, {
		globalDailyWei: '1500',
		perAddressDailyWei: '5000',
		budgetWei: '1500',
	})
	try {
		const key = gasKeeperTopupIdempotencyKey(224422, fx.addr, 1)
		const hash = `0x${'cd'.repeat(32)}`
		const row: SpendRow = {
			idempotencyKey: key,
			chainId: '224422',
			address: fx.addr.toLowerCase(),
			amountWei: '1000',
			recordedAt: yesterday,
			status: 'pending',
			attempt: 1,
			hash,
		}
		writeFileSync(fx.statePath, JSON.stringify({ version: 2, spend: [row] }))
		fx.remember({ hash, status: 'sent', idempotencyKey: key })
		fx.balances.set(fx.pm, 5_000_000n)
		fx.balances.set(fx.addr, 0n)
		await fx.gk.runOnce()
		assert.equal(fx.sends.length, 0)
		assert.equal(fx.alerts.includes('topup-global-cap:224422'), false)
		assert.equal(fx.alerts.some((code) => code.includes('ineligible-pending')), false)
		const disk = JSON.parse(readFileSync(fx.statePath, 'utf8')) as { version: number; spend: SpendRow[] }
		assert.equal(disk.spend.length, 1)
		assert.equal(disk.spend[0]!.status, 'pending')
		assert.equal(disk.spend[0]!.hash, hash)
		assert.equal(disk.spend[0]!.recordedAt, yesterday)
		const used = gasKeeperUsage(disk.spend, '224422', fx.addr.toLowerCase(), new Date().toISOString())
		assert.equal(used.globalDaily, 1000n)
		assert.equal(used.addressDaily, 1000n)
		assert.equal(used.globalTotal, 1000n)
		assert.equal(used.globalDaily + 1000n > 1500n, true)
		assert.equal(used.globalTotal + 1000n > 1500n, true)
	} finally {
		fx.cleanup()
	}
})

test('a full UTC day does not keep blocking, and the persistent budget does not refill', async () => {
	const yesterday = new Date(Date.now() - 86_400_000).toISOString()
	const earlier = new Date(Date.now() - 2 * 86_400_000).toISOString()
	const spent = (when: string, amount: string, key: string): SpendRow => ({
		idempotencyKey: key,
		chainId: '224422',
		address: '',
		amountWei: amount,
		recordedAt: when,
		status: 'settled',
		attempt: 0,
	})
	const opened = gasFixture({ gasPrice: 1n, maxFeePerGas: null }, {
		globalDailyWei: '200000',
		perAddressDailyWei: '1000000',
		budgetWei: '400000',
	})
	const exhausted = gasFixture({ gasPrice: 1n, maxFeePerGas: null }, {
		globalDailyWei: '200000',
		perAddressDailyWei: '1000000',
		budgetWei: '400000',
	})
	try {
		writeFileSync(opened.statePath, JSON.stringify({
			version: 2,
			spend: [{ ...spent(yesterday, '1000', 'day-1'), address: opened.addr.toLowerCase() }],
		}))
		opened.balances.set(opened.pm, 5_000_000n)
		opened.balances.set(opened.addr, 0n)
		await opened.gk.runOnce()
		assert.equal(opened.sends.length, 1)
		assert.equal(opened.alerts.includes('topup-global-cap:224422'), false)
		assert.equal(opened.alerts.includes('topup-budget:224422'), false)
		const disk = JSON.parse(readFileSync(opened.statePath, 'utf8')) as { version: number; spend: SpendRow[] }
		for (const row of disk.spend) if (row.status === 'pending') row.status = 'settled'
		writeFileSync(opened.statePath, JSON.stringify(disk))
		opened.balances.set(opened.addr, 0n)
		await opened.gk.runOnce()
		assert.equal(opened.sends.length, 1)
		assert.ok(opened.alerts.includes('topup-global-cap:224422'))

		writeFileSync(exhausted.statePath, JSON.stringify({
			version: 2,
			spend: [
				{ ...spent(earlier, '200000', 'day-0'), address: exhausted.addr.toLowerCase() },
				{ ...spent(yesterday, '200000', 'day-1b'), address: exhausted.addr.toLowerCase() },
			],
		}))
		exhausted.balances.set(exhausted.pm, 5_000_000n)
		exhausted.balances.set(exhausted.addr, 0n)
		await exhausted.gk.runOnce()
		assert.equal(exhausted.sends.length, 0)
		assert.ok(exhausted.alerts.includes('topup-budget:224422'))
		assert.equal(exhausted.alerts.includes('topup-global-cap:224422'), false)
	} finally {
		opened.cleanup()
		exhausted.cleanup()
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
		fx.balances.set(fx.pm, 200_000n + 21_000n)
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
	assert.equal(cfg.gasKeeper.postSignEnabled, false)
	assert.deepEqual(cfg.gasKeeper.chains['224422']!.wallets, [])
	const omitted = join(dir, 'omitted.json')
	writeFileSync(omitted, JSON.stringify({ dataDir: dir, adminSocket: join(dir, 'a.sock'), policyFile: join(dir, 'p.json'), chains: { '224422': { rpcUrls: ['http://127.0.0.1:9'] } } }))
	assert.equal(loadConfig(omitted).gasKeeper.enabled, false)
	const postSign = join(dir, 'post-sign.json')
	writeFileSync(postSign, JSON.stringify({ dataDir: dir, adminSocket: join(dir, 'a.sock'), policyFile: join(dir, 'p.json'), chains: { '224422': { rpcUrls: ['http://127.0.0.1:9'] } }, gasKeeper: { postSignEnabled: true, chains: { '224422': { minWei: '1', targetWei: '2', perAddressDailyWei: '3', globalDailyWei: '4', pmWarnWei: '5', pmCriticalWei: '6' } } } }))
	assert.equal(loadConfig(postSign).gasKeeper.postSignEnabled, true)
	writeFileSync(postSign, JSON.stringify({ dataDir: dir, adminSocket: join(dir, 'a.sock'), policyFile: join(dir, 'p.json'), chains: { '224422': { rpcUrls: ['http://127.0.0.1:9'] } }, gasKeeper: { postSignEnabled: 'yes', chains: {} } }))
	assert.throws(() => loadConfig(postSign), /postSignEnabled must be a boolean/)
	assert.throws(() => {
		writeFileSync(p, JSON.stringify({
			dataDir: dir,
			adminSocket: join(dir, 'a.sock'),
			policyFile: join(dir, 'p.json'),
			chains: { '224422': { rpcUrls: ['http://127.0.0.1:9'] } },
		gasKeeper: { enabled: false, chains: { '224422': { wallets: ['not-an-address'], budgetWei: '1', minWei: '1', targetWei: '2', perAddressDailyWei: '3', globalDailyWei: '4', pmWarnWei: '5', pmCriticalWei: '6' } } },
		}))
		loadConfig(p)
	}, /wallets\[0\]/)
})

test('Lab post-sign candidate is explicitly registered but fails closed by default and all caps are zero', () => {
	const { loadConfig } = require('../src/config') as typeof import('../src/config')
	const candidate = join(process.cwd(), 'deploy/lab-mining-pool/config.lab-postsign-candidate-disabled.json')
	const cfg = loadConfig(candidate)
	const chain = cfg.gasKeeper.chains['224422']!
	assert.equal(cfg.gasKeeper.enabled, false)
	assert.equal(cfg.gasKeeper.postSignEnabled, false)
	assert.deepEqual(chain.wallets, ['0xcFAF85E6C1765DA01a4Dc58C81b28Cd572067135'])
	assert.equal(chain.budgetWei, '0')
	assert.equal(chain.perAddressDailyWei, '0')
	assert.equal(chain.globalDailyWei, '0')
	assert.equal(chain.maxFeePerGasWei, '0')
	assert.equal(cfg.pmLabInitialGas.enabled, false)
	assert.equal(cfg.pmLabInitialGas.dryRun, true)
	assert.equal(cfg.pmLabInitialGas.maxSpendWei, '0')
	assert.equal(cfg.pmLabInitialGas.dailyCapWei, '0')
	assert.equal(cfg.pmLabInitialGas.maxFeePerGasWei, '0')
})

function labInitialGasFixture(opts: {
	config?: Partial<LabInitialGasDeps['cfg']>
	balance?: bigint
	pmBalance?: bigint
	chainId?: bigint
	gasPrice?: bigint | null
	maxFeePerGas?: bigint | null
	nonce?: number
	pmMatch?: boolean
	pmAdmin?: boolean
	labAdmin?: boolean
	validatorContractCode?: string
	labRecipientCode?: string
	unlocked?: boolean
	readError?: string
	journalRecord?: TxRecord
	sendDelayMs?: number
	sendHashInvalid?: boolean
} = {}) {
	const pm = getAddress(Wallet.createRandom().address)
	const read: string[] = []
	const sends: Array<Parameters<LabInitialGasDeps['send']>[0]> = []
	let journal = opts.journalRecord
	const cfg: LabInitialGasDeps['cfg'] = {
		enabled: true,
		dryRun: true,
		maxSpendWei: PM_LAB_INITIAL_GAS_TARGET_WEI.toString(),
		dailyCapWei: PM_LAB_INITIAL_GAS_MAX_TOTAL_WEI.toString(),
		maxFeePerGasWei: PM_LAB_INITIAL_GAS_MAX_FEE_WEI.toString(),
		...opts.config,
	}
	const deps: LabInitialGasDeps = {
		cfg,
		registryPm: pm,
		keyringPm: opts.pmMatch === false ? Wallet.createRandom().address : pm,
		unlocked: opts.unlocked !== false,
		reader: {
			async snapshot() {
				read.push('snapshot')
				if (opts.readError === 'chainId') throw new Error('mock chainId failure')
				if (opts.readError === 'admin') throw new Error('mock admins RPC failure')
				if (opts.readError === 'balance') throw new Error('mock balance failure')
				return { chainId: opts.chainId ?? 224422n, blockNumber: 2_235_067n, blockHash: `0x${'77'.repeat(32)}`, pmAdmin: opts.pmAdmin ?? true, labAdmin: opts.labAdmin ?? true, pmBalance: opts.pmBalance ?? 10n ** 18n, labBalance: opts.balance ?? 0n, validatorContractCode: opts.validatorContractCode ?? '0x6000', labRecipientCode: opts.labRecipientCode ?? '0x' }
			},
			async feeData() { read.push('feeData'); if (opts.readError === 'feeData') throw new Error('mock fee failure'); return { gasPrice: opts.gasPrice === undefined ? 1n : opts.gasPrice, maxFeePerGas: opts.maxFeePerGas === undefined ? null : opts.maxFeePerGas } },
			async pendingNonce() { read.push('nonce'); if (opts.readError === 'nonce') throw new Error('mock nonce failure'); return opts.nonce ?? 7 },
		},
		txm: { get() { return journal } } as unknown as TxManager,
		async send(req) {
			sends.push(req)
			if (opts.sendDelayMs) await delay(opts.sendDelayMs)
			const durableHash = `0x${'ab'.repeat(32)}`
			const result = { hash: opts.sendHashInvalid ? '' : durableHash, from: pm, nonce: req.expectedNonce, chainId: PM_LAB_INITIAL_GAS_CHAIN_ID, status: 'sent' as const, idempotencyKey: req.idempotencyKey, raw: '0x' }
			journal = { id: `${req.chainId}:${pm.toLowerCase()}:${req.expectedNonce}`, idempotencyKey: req.idempotencyKey, client: req.client, array: req.array, chainId: req.chainId, from: pm, to: req.to, data: req.data, value: req.value.toString(), nonce: req.expectedNonce, gasLimit: req.gasLimit.toString(), type: 0, hash: durableHash, hashes: [durableHash], raw: '0x', status: 'sent', resends: 0, createdAt: '', updatedAt: '', lastSentAt: 0 } as TxRecord
			return result
		},
		audit() {},
	}
	return { deps, read, sends, get journal() { return journal } }
}

test('Lab initial Gas is fixed and dry-run calculates only the difference to 0.1 CNET at 0/0.05/0.1 boundaries', async () => {
	const disabled = labInitialGasFixture({ config: { enabled: false } })
	assert.deepEqual(await runPmLabInitialGas(disabled.deps), { status: 'disabled' })
	assert.deepEqual(disabled.read, [])
	assert.equal(disabled.sends.length, 0)
	for (const [balance, expected] of [[0n, PM_LAB_INITIAL_GAS_TARGET_WEI], [50_000_000_000_000_000n, 50_000_000_000_000_000n], [PM_LAB_INITIAL_GAS_TARGET_WEI, 0n]] as const) {
		const fx = labInitialGasFixture({ balance })
		const result = await runPmLabInitialGas(fx.deps)
		if (balance === PM_LAB_INITIAL_GAS_TARGET_WEI) {
			assert.deepEqual(result, { status: 'already-funded', balanceWei: balance.toString() })
			assert.deepEqual(fx.read, ['snapshot'])
		} else {
			assert.equal(result.status, 'dry-run')
			if (result.status === 'dry-run') {
				assert.equal(result.amountWei, expected.toString())
				assert.equal(result.nonce, 7)
			}
			assert.equal(fx.sends.length, 0, 'dry-run never calls the sender')
		}
	}
})

test('Lab initial Gas sends through the PM TxManager with fixed Lab recipient, exact delta, fee cap, nonce and idempotency', async () => {
	const balance = 50_000_000_000_000_000n
	const fx = labInitialGasFixture({ balance, config: { dryRun: false } })
	const result = await runPmLabInitialGas(fx.deps)
	assert.equal(result.status, 'pending')
	assert.equal(fx.sends.length, 1)
	const sent = fx.sends[0]!
	assert.equal(sent.client, PM_LAB_INITIAL_GAS_CLIENT)
	assert.notEqual(sent.client, PM_GRANT_CLIENT, 'Lab initial Gas is not the VDR/PM grant route')
	assert.equal(sent.array, 'PM')
	assert.equal(sent.chainId, 224422)
	assert.equal(sent.from, fx.deps.registryPm)
	assert.deepEqual(sent.candidates, [fx.deps.registryPm])
	assert.equal(sent.to, PM_LAB_INITIAL_GAS_RECIPIENT)
	assert.notEqual(sent.to, PM_GRANT_VDR)
	assert.equal(sent.value, PM_LAB_INITIAL_GAS_TARGET_WEI - balance)
	assert.equal(sent.gasLimit, PM_LAB_INITIAL_GAS_GAS_LIMIT)
	assert.equal(sent.maxGasPriceWei, PM_LAB_INITIAL_GAS_MAX_FEE_WEI)
	assert.equal(sent.expectedNonce, 7)
	assert.equal(sent.idempotencyKey, PM_LAB_INITIAL_GAS_IDEMPOTENCY_KEY)
	assert.equal(sent.maxInflightPerKey, 1)
})

test('Lab initial Gas is idempotent across concurrent and repeated calls and refuses prior pending intent', async () => {
	const fx = labInitialGasFixture({ balance: 1n, config: { dryRun: false }, sendDelayMs: 10 })
	const results = await Promise.all([runPmLabInitialGas(fx.deps), runPmLabInitialGas(fx.deps)])
	assert.equal(fx.sends.length, 1)
	assert.deepEqual(results.map((r) => r.status).sort(), ['already-attempted', 'pending'])
	const priorReadCount = fx.read.length
	assert.equal((await runPmLabInitialGas(fx.deps)).status, 'already-attempted')
	assert.equal(fx.read.length, priorReadCount, 'journaled intent blocks before new reads or sends')
	assert.equal(fx.sends.length, 1)
})

test('Lab initial Gas refuses an unhashable sender result and blocks retries from the durable journal', async () => {
	const fx = labInitialGasFixture({ balance: 1n, config: { dryRun: false }, sendHashInvalid: true })
	await assert.rejects(runPmLabInitialGas(fx.deps), /no valid transaction hash.*requires reconcile/)
	assert.ok(fx.journal, 'the mock TxManager has persisted its intent before returning')
	const reads = fx.read.length
	assert.equal((await runPmLabInitialGas(fx.deps)).status, 'already-attempted')
	assert.equal(fx.sends.length, 1)
	assert.equal(fx.read.length, reads, 'an uncertain result blocks all retry reads and sends')
})

test('Lab initial Gas refuses RPC, chain, PM binding, fee, nonce, max-spend, daily-cap and PM-balance failures without send', async () => {
	const cases: Array<{ name: string; options: Parameters<typeof labInitialGasFixture>[0]; pattern: RegExp }> = [
		{ name: 'recipient RPC failure', options: { readError: 'balance' }, pattern: /mock balance failure/ },
		{ name: 'admin status RPC failure', options: { readError: 'admin' }, pattern: /mock admins RPC failure/ },
		{ name: 'chain mismatch', options: { chainId: 1n }, pattern: /chainId mismatch/ },
		{ name: 'PM admin false', options: { pmAdmin: false }, pattern: /both be admins/ },
		{ name: 'Lab admin false', options: { labAdmin: false }, pattern: /both be admins/ },
		{ name: 'Validator contract absent', options: { validatorContractCode: '0x' }, pattern: /code or fixed Lab wallet code/ },
		{ name: 'Lab recipient is not an EOA', options: { labRecipientCode: '0x6000' }, pattern: /code or fixed Lab wallet code/ },
		{ name: 'PM binding mismatch', options: { pmMatch: false }, pattern: /registered PM key/ },
		{ name: 'PM locked', options: { unlocked: false }, pattern: /unlocked registered PM key/ },
		{ name: 'fee RPC failure', options: { readError: 'feeData' }, pattern: /mock fee failure/ },
		{ name: 'fee unavailable', options: { gasPrice: null, maxFeePerGas: null }, pattern: /fee data is unavailable/ },
		{ name: 'fee above cap', options: { gasPrice: PM_LAB_INITIAL_GAS_MAX_FEE_WEI + 1n }, pattern: /market fee exceeds/ },
		{ name: 'nonce RPC failure', options: { readError: 'nonce' }, pattern: /mock nonce failure/ },
		{ name: 'invalid pending nonce', options: { nonce: -1 }, pattern: /pending nonce is invalid/ },
		{ name: 'max spend too small', options: { config: { maxSpendWei: '1' } }, pattern: /exceeds its fixed spend cap/ },
		{ name: 'daily cap too small', options: { config: { dailyCapWei: '1' } }, pattern: /cap/ },
		{ name: 'PM balance insufficient', options: { pmBalance: 1n }, pattern: /PM balance does not cover/ },
	]
	for (const item of cases) {
		const fx = labInitialGasFixture({ ...(item.options ?? {}), config: { dryRun: false, ...(item.options?.config ?? {}) } })
		await assert.rejects(runPmLabInitialGas(fx.deps), item.pattern, item.name)
		assert.equal(fx.sends.length, 0, `${item.name} must fail before TxManager send`)
	}
})

test('Lab initial Gas encodes only the fixed ValidatorDepositRedeem admins read and strictly decodes bool', () => {
	const call = encodeLabInitialGasAdminCall(PM_LAB_INITIAL_GAS_RECIPIENT)
	assert.equal(call.to, PM_GRANT_VDR)
	assert.equal(call.data.slice(0, 10), PM_LAB_INITIAL_GAS_ADMIN_SELECTOR)
	assert.equal(decodeLabInitialGasAdminStatus('0x' + '0'.repeat(63) + '1'), true)
	assert.equal(decodeLabInitialGasAdminStatus('0x' + '0'.repeat(64)), false)
	assert.throws(() => decodeLabInitialGasAdminStatus('0x01'), /data/)
})

test('Lab initial Gas requires independent EIP-1898 readers to agree on block and every decision value', () => {
	const baseline: LabInitialGasSnapshot = { chainId: 224422n, blockNumber: 2_235_067n, blockHash: `0x${'77'.repeat(32)}`, pmAdmin: true, labAdmin: true, pmBalance: 100n, labBalance: 50n, validatorContractCode: '0x6000', labRecipientCode: '0x' }
	assert.equal(requireMatchingLabInitialGasSnapshots(baseline, { ...baseline, blockHash: baseline.blockHash.toUpperCase().replace('0X', '0x') }), baseline)
	assert.throws(() => requireMatchingLabInitialGasSnapshots(baseline, { ...baseline, blockNumber: baseline.blockNumber + 1n }), /block anchors differ/)
	assert.throws(() => requireMatchingLabInitialGasSnapshots(baseline, { ...baseline, labBalance: baseline.labBalance + 1n }), /same-block reads differ/)
})

test('gas keeper refuses the oracle contract even when the whitelist names it', async () => {
	const fx = gasFixture({ gasPrice: 1n, maxFeePerGas: null }, {
		extraWallets: [BEAMIO_ORACLE_CONTRACT],
		codes: { [BEAMIO_ORACLE_CONTRACT]: '0x' },
	})
	try {
		fx.balances.set(fx.pm, 5_000_000n)
		fx.balances.set(fx.addr, 0n)
		fx.balances.set(BEAMIO_ORACLE_CONTRACT, 0n)
		await fx.gk.runOnce()
		assert.equal(fx.sends.length, 1)
		assert.equal(getAddress(fx.sends[0]!.to), fx.addr)
		assert.equal(fx.sends.some((row) => getAddress(row.to) === getAddress(BEAMIO_ORACLE_CONTRACT)), false)
		assert.ok(fx.alerts.some((code) => code.startsWith(`topup-refused:224422:contract:${BEAMIO_ORACLE_CONTRACT.toLowerCase()}`)))
		const audit = readFileSync(fx.auditPath, 'utf8')
		assert.equal(audit.includes(BEAMIO_ORACLE_CONTRACT), true)
		assert.equal(audit.includes('"reason":"contract"'), true)
	} finally {
		fx.cleanup()
	}
})

test('a higher quote fee cannot hide below the old minWei', async () => {
	const oldMin = 200_001_400_000n
	const worst = 2_000_014n
	const quoteNeed = oracleQuoteNeedWei(null, worst)
	assert.equal(quoteNeed, 200_000n * worst)
	assert.ok(quoteNeed !== undefined && quoteNeed > oldMin)
	const balance = oldMin + 1n
	assert.ok(balance < quoteNeed!)
	const partialTarget = quoteNeed! / 2n
	const partialBalance = partialTarget / 2n
	assert.ok(partialBalance < partialTarget && partialTarget < quoteNeed!)
	const partial = gasFixture({ gasPrice: 1n, maxFeePerGas: worst }, {
		targetWei: partialTarget.toString(),
		perAddressDailyWei: quoteNeed!.toString(),
		globalDailyWei: quoteNeed!.toString(),
		budgetWei: quoteNeed!.toString(),
	})
	const blocked = gasFixture({ gasPrice: 1n, maxFeePerGas: worst }, {
		targetWei: oldMin.toString(),
		perAddressDailyWei: quoteNeed!.toString(),
		globalDailyWei: quoteNeed!.toString(),
		budgetWei: quoteNeed!.toString(),
	})
	const funded = gasFixture({ gasPrice: 1n, maxFeePerGas: worst }, {
		targetWei: quoteNeed!.toString(),
		perAddressDailyWei: quoteNeed!.toString(),
		globalDailyWei: quoteNeed!.toString(),
		budgetWei: (quoteNeed! - balance).toString(),
	})
	const capped = gasFixture({ gasPrice: 1n, maxFeePerGas: worst }, {
		targetWei: quoteNeed!.toString(),
		perAddressDailyWei: quoteNeed!.toString(),
		globalDailyWei: quoteNeed!.toString(),
		budgetWei: quoteNeed!.toString(),
		maxFeePerGasWei: '1000007',
	})
	try {
		blocked.balances.set(blocked.pm, 10n ** 18n)
		blocked.balances.set(blocked.addr, balance)
		await blocked.gk.runOnce()
		assert.equal(blocked.sends.length, 0)
		assert.ok(blocked.alerts.includes(`topup-deferred:224422:target-short:${blocked.addr.toLowerCase()}`))
		const blockedAudit = readFileSync(blocked.auditPath, 'utf8')
		assert.equal(blockedAudit.includes('"event":"gas.topup-deferred"'), true)
		assert.equal(blockedAudit.includes('"reason":"target-short"'), true)
		assert.equal(existsSync(blocked.statePath), false)

		partial.balances.set(partial.pm, 10n ** 18n)
		partial.balances.set(partial.addr, partialBalance)
		await partial.gk.runOnce()
		assert.equal(partial.sends.length, 0)
		assert.ok(partial.alerts.includes(`topup-deferred:224422:target-short:${partial.addr.toLowerCase()}`))
		const partialAudit = readFileSync(partial.auditPath, 'utf8')
		assert.equal(partialAudit.includes('"event":"gas.topup-deferred"'), true)
		assert.equal(partialAudit.includes('"reason":"target-short"'), true)
		assert.equal(existsSync(partial.statePath), false)

		const gap = quoteNeed! - balance
		funded.balances.set(funded.pm, 10n ** 18n)
		funded.balances.set(funded.addr, balance)
		await funded.gk.runOnce()
		assert.equal(funded.sends.length, 1)
		assert.equal(funded.sends[0]!.value, gap)
		assert.ok(funded.sends[0]!.value <= gap)

		capped.balances.set(capped.pm, 10n ** 18n)
		capped.balances.set(capped.addr, balance)
		await capped.gk.runOnce()
		assert.equal(capped.sends.length, 0)
		assert.ok(capped.alerts.includes(`topup-deferred:224422:fee-cap:${capped.addr.toLowerCase()}`))
		const cappedAudit = readFileSync(capped.auditPath, 'utf8')
		assert.equal(cappedAudit.includes('"reason":"fee-cap"'), true)
	} finally {
		blocked.cleanup()
		funded.cleanup()
		capped.cleanup()
		partial.cleanup()
	}
})

test('gas keeper refuses a top-up that exceeds the explicit budget', async () => {
	const fx = gasFixture({ gasPrice: 1n, maxFeePerGas: null }, {
		budgetWei: '10',
		perAddressDailyWei: '500000',
		globalDailyWei: '500000',
	})
	try {
		fx.balances.set(fx.pm, 5_000_000n)
		fx.balances.set(fx.addr, 0n)
		await fx.gk.runOnce()
		assert.equal(fx.sends.length, 0)
		assert.ok(fx.alerts.includes('topup-budget:224422'))
	} finally {
		fx.cleanup()
	}
})

test('gas keeper does not sign while locked even when the oracle wallet is whitelisted', async () => {
	const fx = gasFixture({ gasPrice: 1n, maxFeePerGas: null }, { unlocked: false })
	try {
		fx.balances.set(fx.pm, 5_000_000n)
		fx.balances.set(fx.addr, 0n)
		await fx.gk.runOnce()
		assert.equal(fx.sends.length, 0)
		assert.equal(fx.providerCalls, 0)
	} finally {
		fx.cleanup()
	}
})

test('gas keeper tops up only the intersection from the PM on a local mock', async () => {
	const bystander = getAddress(Wallet.createRandom().address)
	const fx = gasFixture({ gasPrice: 1n, maxFeePerGas: null }, {
		extraWallets: [bystander, BEAMIO_ORACLE_CONTRACT],
		extraArrays: [keyArray('settle_contractAdmin', [bystander])],
		budgetWei: '1000000',
	})
	try {
		const amount = oracleQuoteNeedWei(1n, null)!
		fx.balances.set(fx.pm, amount + 21_000n)
		fx.balances.set(fx.addr, 0n)
		fx.balances.set(bystander, 0n)
		fx.balances.set(BEAMIO_ORACLE_CONTRACT, 0n)
		await fx.gk.runOnce()
		assert.equal(fx.sends.length, 1)
		const sent = fx.sends[0]!
		assert.equal(getAddress(sent.to), fx.addr)
		assert.notEqual(getAddress(sent.to), getAddress(BEAMIO_ORACLE_CONTRACT))
		assert.notEqual(getAddress(sent.to), getAddress(ORACLE_OWNER_WALLET_EXAMPLE))
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

test('gas keeper does not pay the example owner unless the intersection matches', async () => {
	const fx = gasFixture({ gasPrice: 1n, maxFeePerGas: null }, {
		wallets: [ORACLE_OWNER_WALLET_EXAMPLE],
		registryAddresses: [ORACLE_OWNER_WALLET_EXAMPLE],
	})
	try {
		fx.balances.set(fx.pm, 5_000_000n)
		fx.balances.set(ORACLE_OWNER_WALLET_EXAMPLE, 0n)
		await fx.gk.runOnce()
		assert.equal(fx.sends.length, 0)
		assert.ok(fx.alerts.some((code) => code.includes(`:not-owner:${ORACLE_OWNER_WALLET_EXAMPLE.toLowerCase()}`)))
	} finally {
		fx.cleanup()
	}
})

test('gas keeper refuses other arrays, unregistered addresses, retired rows, the denied owner, and nonempty code', async () => {
	const coded = getAddress(Wallet.createRandom().address)
	const other = gasFixture({ gasPrice: 1n, maxFeePerGas: null }, { arrayName: 'settle_contractAdmin' })
	const missing = gasFixture({ gasPrice: 1n, maxFeePerGas: null }, {
		wallets: [ORACLE_OWNER_WALLET_EXAMPLE],
		registryAddresses: [ORACLE_OWNER_WALLET_EXAMPLE],
		arrayName: 'settle_contractAdmin',
		owner: ORACLE_OWNER_WALLET_EXAMPLE,
	})
	const retired = gasFixture({ gasPrice: 1n, maxFeePerGas: null }, { arrayStatus: 'retired' })
	const denied = gasFixture({ gasPrice: 1n, maxFeePerGas: null }, {
		wallets: [REFUSED_FIXTURE_OWNER],
		registryAddresses: [REFUSED_FIXTURE_OWNER],
		owner: REFUSED_FIXTURE_OWNER,
		refused: [REFUSED_FIXTURE_OWNER.toLowerCase()],
	})
	const code = gasFixture({ gasPrice: 1n, maxFeePerGas: null }, {
		wallets: [coded],
		registryAddresses: [coded],
		owner: coded,
		codes: { [coded]: '0x6000' },
	})
	try {
		for (const fx of [other, missing, retired, denied, code]) {
			fx.balances.set(fx.pm, 5_000_000n)
			fx.balances.set(fx.addr, 0n)
			await fx.gk.runOnce()
			assert.equal(fx.sends.length, 0)
		}
		assert.ok(other.alerts.some((item) => item.includes(':other-array:')))
		assert.ok(missing.alerts.some((item) => item.includes(':other-array:')))
		assert.ok(retired.alerts.some((item) => item.includes(':inactive:')))
		assert.ok(denied.alerts.some((item) => item.includes(':denied:')))
		assert.ok(code.alerts.some((item) => item.includes(':code:')))
		const unregistered = gasFixture({ gasPrice: 1n, maxFeePerGas: null }, {
			wallets: [ORACLE_OWNER_WALLET_EXAMPLE],
			registryAddresses: [],
			owner: ORACLE_OWNER_WALLET_EXAMPLE,
		})
		try {
			unregistered.balances.set(unregistered.pm, 5_000_000n)
			await unregistered.gk.runOnce()
			assert.equal(unregistered.sends.length, 0)
			assert.ok(unregistered.alerts.some((item) => item.includes(':unregistered:')))
		} finally {
			unregistered.cleanup()
		}
	} finally {
		for (const fx of [other, missing, retired, denied, code]) fx.cleanup()
	}
})

test('gas keeper does not resume a saved top-up to the oracle contract', async () => {
	const fx = gasFixture({ gasPrice: 1n, maxFeePerGas: null })
	try {
		const row: SpendRow = {
			idempotencyKey: `topup:224422:${BEAMIO_ORACLE_CONTRACT.toLowerCase()}:1`,
			chainId: '224422',
			address: BEAMIO_ORACLE_CONTRACT.toLowerCase(),
			amountWei: '1000',
			recordedAt: new Date().toISOString(),
			status: 'pending',
			attempt: 1,
		}
		writeFileSync(fx.statePath, JSON.stringify({ version: 2, spend: [row] }))
		fx.balances.set(fx.pm, 5_000_000n)
		fx.balances.set(fx.addr, 0n)
		await fx.gk.runOnce()
		assert.equal(fx.sends.some((sent) => getAddress(sent.to) === getAddress(BEAMIO_ORACLE_CONTRACT)), false)
		const disk = JSON.parse(readFileSync(fx.statePath, 'utf8')) as { spend: SpendRow[] }
		assert.equal(disk.spend.find((item) => item.address === BEAMIO_ORACLE_CONTRACT.toLowerCase())?.status, 'released')
	} finally {
		fx.cleanup()
	}
})

test('gas keeper does not read a provider for Base', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'ws-gas-base-'))
	const alerts: string[] = []
	let calls = 0
	const gk = new GasKeeper(
		{
			'8453': {
				minWei: '1',
				targetWei: '2',
				perAddressDailyWei: '3',
				globalDailyWei: '4',
				pmWarnWei: '5',
				pmCriticalWei: '6',
				budgetWei: '9',
				wallets: [ORACLE_OWNER_WALLET_EXAMPLE],
			},
		},
		60_000,
		{ provider() { calls += 1; throw new Error('base provider') } } as unknown as TxManager,
		{ unlocked: true } as unknown as Keyring,
		() => ({ version: 1, pm: ORACLE_OWNER_WALLET_EXAMPLE, attestor: ORACLE_OWNER_WALLET_EXAMPLE, arrays: [keyArray(ORACLE_OWNER_ARRAY, [ORACLE_OWNER_WALLET_EXAMPLE])], updatedAt: '2026-01-01T00:00:00.000Z' }),
		() => new Set<string>(),
		{ send(_level: string, code: string) { alerts.push(code) } },
		new AuditLog(join(dir, 'audit.jsonl')),
		join(dir, 'gas.json'),
	)
	try {
		await gk.runOnce()
		assert.equal(calls, 0)
		assert.ok(alerts.includes('topup-chain-refused:8453'))
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('empty runtime code is only the bare 0x word', () => {
	assert.equal(isEmptyRuntimeCode('0x'), true)
	assert.equal(isEmptyRuntimeCode('  0X  '), true)
	assert.equal(isEmptyRuntimeCode('0x00'), false)
	assert.equal(isEmptyRuntimeCode('0x0000'), false)
	assert.equal(isEmptyRuntimeCode('0x0'), false)
	assert.equal(isEmptyRuntimeCode('0x000'), false)
	assert.equal(isEmptyRuntimeCode(''), false)
	assert.equal(isEmptyRuntimeCode('0xzz'), false)
	assert.equal(isEmptyRuntimeCode('not-hex'), false)
	assert.equal(isEmptyRuntimeCode(undefined), false)
	assert.equal(isEmptyRuntimeCode(null), false)
})

test('owner() accepts only a 32-byte ABI address and a dirty word funds nobody', async () => {
	const wallet = getAddress(Wallet.createRandom().address)
	const body = `${'0'.repeat(24)}${wallet.slice(2).toLowerCase()}`
	const word = `0x${body}`
	assert.equal(body.length, 64)
	assert.equal(decodeAddressWord(word), wallet)
	assert.equal(decodeAddressWord(body), wallet)
	assert.equal(decodeAddressWord(`0x${wallet.slice(2)}`), null)
	assert.equal(decodeAddressWord(`0x${'0'.repeat(62)}`), null)
	assert.equal(decodeAddressWord(`0x${'01'}${'0'.repeat(22)}${wallet.slice(2).toLowerCase()}`), null)
	assert.equal(decodeAddressWord(`${word}00`), null)
	assert.equal(decodeAddressWord(`0x${'0'.repeat(64)}${body}`), null)
	assert.equal(decodeAddressWord(''), null)
	assert.equal(decodeAddressWord('0xgg' + '0'.repeat(62)), null)

	const registry = {
		version: 1 as const,
		pm: wallet,
		attestor: wallet,
		updatedAt: '2026-11-09T00:00:00.000Z',
		arrays: [keyArray(ORACLE_OWNER_ARRAY, [wallet])],
	}
	const dirty = [`0x${wallet.slice(2)}`, `0x${'01'}${'0'.repeat(22)}${wallet.slice(2).toLowerCase()}`, `${word}00`]
	for (const callResult of dirty) {
		const picked = await selectOracleOwnerRecipients(224422, [wallet], registry, new Set(), {
			async getCode() { return '0x' },
			async call() { return callResult },
		})
		assert.equal(picked.owner, null)
		assert.deepEqual(picked.fund, [])
	}
	for (const code of ['0x00', '0x0000', '0x0', '']) {
		const picked = await selectOracleOwnerRecipients(224422, [wallet], registry, new Set(), {
			async getCode() { return code },
			async call() { return word },
		})
		assert.equal(picked.owner, wallet)
		assert.deepEqual(picked.fund, [])
		assert.equal(picked.refused.some((row) => row.reason === 'code'), true)
	}
	const funded = await selectOracleOwnerRecipients(224422, [wallet], registry, new Set(), {
		async getCode() { return '0x' },
		async call() { return word },
	})
	assert.deepEqual(funded.fund, [wallet])
})

test('oracle-daemon cannot reach the gas keeper through client RPC or an admin-socket argument', () => {
	assert.equal(gasTopupRpcRefusal('signer_sendTransaction', ORACLE_DAEMON_CLIENT), null)
	assert.equal(gasTopupRpcRefusal('signer_topup', ORACLE_DAEMON_CLIENT), 'oracle-daemon')
	assert.equal(gasTopupRpcRefusal('gas.run', 'conet-beamio-api'), 'client-rpc')
	assert.equal(adminGasRunRefusal({}), null)
	assert.equal(adminGasRunRefusal({ client: ORACLE_DAEMON_CLIENT }), 'oracle-daemon')
	assert.equal(adminGasRunRefusal({ address: BEAMIO_ORACLE_CONTRACT }), 'caller-or-target')
	assert.equal(GAS_KEEPER_CHAIN_ID, 224422)
	assert.equal(ORACLE_OWNER_ARRAY, 'beamio_oracle_owner')
})

function keyArray(name: string, addresses: string[], status: 'active' | 'retired' = 'active', account = 10): KeyArray {
	return {
		name,
		account,
		count: addresses.length,
		chains: [224422],
		status,
		addresses,
		createdAt: '2026-11-09T09:49:58.152Z',
	}
}

// Test fixture only (not a real account): an owner address the gas keeper must refuse.
const REFUSED_FIXTURE_OWNER = '0x5a1ab0000000000000000000000000000000f1f1'

function gasFixture(fee: { gasPrice: bigint | null; maxFeePerGas: bigint | null }, opts: {
	wallets?: string[]
	extraWallets?: string[]
	budgetWei?: string
	omitBudget?: boolean
	targetWei?: string
	maxFeePerGasWei?: string
	perAddressDailyWei?: string
	globalDailyWei?: string
	unlocked?: boolean
	registryAddresses?: string[]
	arrayName?: string
	arrayStatus?: 'active' | 'retired'
	extraArrays?: KeyArray[]
	owner?: string
	codes?: Record<string, string>
	refused?: string[]
} = {}): {
	gk: GasKeeper
	restart: () => GasKeeper
	pm: string
	addr: string
	statePath: string
	auditPath: string
	sends: Array<{ idempotencyKey?: string; value: bigint; gasLimit?: bigint; hash: string; to: string; client?: string; array?: string; candidates: string[] }>
	alerts: string[]
	balances: Map<string, bigint>
	providerCalls: number
	balanceReads: number
	balanceFailure: boolean
	balanceSequence: bigint[]
	remember: (rec: { hash?: string; status?: string; idempotencyKey?: string }) => void
	failSend: boolean
	cleanup: () => void
} {
	const dir = mkdtempSync(join(tmpdir(), 'ws-gas-keeper-'))
	const statePath = join(dir, 'gaskeeper-state.json')
	const auditPath = join(dir, 'audit.jsonl')
	const pm = getAddress(Wallet.createRandom().address)
	const addr = getAddress(Wallet.createRandom().address)
	const owner = getAddress(opts.owner ?? addr)
	const codes = new Map(Object.entries(opts.codes ?? {}).map(([who, code]) => [getAddress(who).toLowerCase(), code]))
	const balances = new Map<string, bigint>()
	const balanceSequence: bigint[] = []
	const alerts: string[] = []
	const sends: Array<{ idempotencyKey?: string; value: bigint; gasLimit?: bigint; hash: string; to: string; client?: string; array?: string; candidates: string[] }> = []
	let providerCallsSeen = 0
	let balanceReadsSeen = 0
	const records = new Map<string, { hash?: string; status?: string; idempotencyKey?: string }>()
	const fx = {
		failSend: false,
		balanceFailure: false,
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
					balanceReadsSeen += 1
					if (fx.balanceFailure) throw new Error('mock balance RPC failure')
					if (balanceSequence.length > 0) return balanceSequence.shift()!
					return balances.get(getAddress(who)) ?? 0n
				},
				async getFeeData() {
					return fee
				},
				async getCode(who: string) {
					return codes.get(getAddress(who).toLowerCase()) ?? '0x'
				},
				async call(tx: { to?: string; data?: string }) {
					if (tx.data !== '0x8da5cb5b') throw new Error('unexpected owner call')
					return zeroPadValue(owner, 32)
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
	const need = oracleQuoteNeedWei(fee.gasPrice, fee.maxFeePerGas) ?? 200_000n
	const chain = {
		'224422': {
			minWei: '100',
			targetWei: opts.targetWei ?? need.toString(),
			perAddressDailyWei: opts.perAddressDailyWei ?? need.toString(),
			globalDailyWei: opts.globalDailyWei ?? (need * 5n).toString(),
			budgetWei: opts.omitBudget ? undefined : opts.budgetWei ?? (need * 10n).toString(),
			...(opts.maxFeePerGasWei !== undefined ? { maxFeePerGasWei: opts.maxFeePerGasWei } : {}),
			pmWarnWei: '1',
			pmCriticalWei: '1',
			wallets: [...(opts.wallets ?? [addr]), ...(opts.extraWallets ?? [])],
		},
	}
	const registered = opts.registryAddresses ?? [addr]
	const registry = () => ({
		version: 1 as const,
		pm,
		attestor: pm,
		updatedAt: '2026-01-01T00:00:00.000Z',
		arrays: [
			keyArray(opts.arrayName ?? ORACLE_OWNER_ARRAY, registered, opts.arrayStatus ?? 'active'),
			...(opts.extraArrays ?? []),
		],
	})
	const make = () => new GasKeeper(
		chain,
		60_000,
		txm as unknown as TxManager,
		{ unlocked: opts.unlocked !== false, pmAddress: pm } as unknown as Keyring,
		registry,
		() => new Set<string>(opts.refused ?? []),
		{ send(_level: string, code: string) { alerts.push(code) } },
		new AuditLog(auditPath),
		statePath,
		true,
	)
	return {
		gk: make(),
		restart: make,
		pm,
		addr,
		statePath,
		auditPath,
		sends,
		alerts,
		balances,
		balanceSequence,
		get providerCalls() { return providerCallsSeen },
		get balanceReads() { return balanceReadsSeen },
		get balanceFailure() { return fx.balanceFailure },
		set balanceFailure(value: boolean) { fx.balanceFailure = value },
		remember: fx.remember,
		get failSend() { return fx.failSend },
		set failSend(value: boolean) { fx.failSend = value },
		cleanup() { rmSync(dir, { recursive: true, force: true }) },
	}
}

const VDR_PROXY = '0xc71e246DD78B37C2fABc905D340932F28F503433'
const settleIface = new Interface(['function settleNodeRewards(uint256[] ids, uint256[] amounts, bytes32[] roots)'])

function settleData(ids: number, amounts = ids, roots = ids): string {
	const word = '0x' + '11'.repeat(32)
	return settleIface.encodeFunctionData('settleNodeRewards', [
		Array.from({ length: ids }, (_, i) => i + 1),
		Array.from({ length: amounts }, (_, i) => (i + 1) * 10),
		Array.from({ length: roots }, () => word),
	])
}

function vdrPolicy(): Policy {
	return new Policy({
		version: 1,
		clients: {
			'vdr-payout': {
				arrays: {
					beamio_vdr_payout: {
						chains: [224422],
						allow: [{
							to: VDR_PROXY,
							selectors: ['settleNodeRewards(uint256[],uint256[],bytes32[])'],
							maxValueWei: '0',
							maxGas: 2000000,
							equalArrays: [0, 1, 2],
							args: {
								'0': { minItems: 1, maxItems: 29 },
								'1': { minItems: 1, maxItems: 29 },
								'2': { minItems: 1, maxItems: 29 },
							},
						}],
					},
				},
			},
			other: {
				arrays: {
					epochManagre: {
						chains: [224422],
						allow: [{
							to: '0x648f1a17269627C3d465fEa40b3C229f7CacE5cA',
							selectors: ['updateInfo(uint256,uint256,uint256)'],
							maxValueWei: '0',
						}],
					},
				},
			},
		},
	})
}

test('policy: signer enforces VDR settle length; caller checks are not the whitelist', () => {
	const p = vdrPolicy()
	const lists = { denied: new Set<string>(), registry: new Set<string>() }
	const base = { client: 'vdr-payout', array: 'beamio_vdr_payout', chainId: 224422, to: VDR_PROXY, value: 0n }
	assert.equal(p.checkCall({ ...base, data: settleData(1) }, lists).method, 'settleNodeRewards(uint256[],uint256[],bytes32[])')
	assert.doesNotThrow(() => p.checkCall({ ...base, data: settleData(29) }, lists))
	assert.throws(() => p.checkCall({ ...base, data: settleData(0) }, lists), /length 0 is below 1/)
	assert.throws(() => p.checkCall({ ...base, data: settleData(30) }, lists), /length 30 is above 29/)
	assert.throws(() => p.checkCall({ ...base, data: settleData(1, 2, 1) }, lists), /same length/)
	assert.throws(() => p.checkCall({ ...base, value: 1n, data: settleData(1) }, lists), /value above 0/)
	assert.throws(() => p.checkCall({ ...base, to: Wallet.createRandom().address, data: settleData(1) }, lists), /not in policy/)
	assert.throws(() => p.checkCall({ ...base, data: '0xdeadbeef' }, lists), /not in policy/)
	assert.throws(() => p.checkCall({ ...base, data: settleIface.getFunction('settleNodeRewards')!.selector + '00' }, lists), /does not decode/)
	const grant = p.grant('vdr-payout', 'beamio_vdr_payout')
	assert.equal(grant.allowSignOnly, undefined)
	assert.equal(grant.allowPersonalSign, undefined)
	assert.equal(grant.typedData, undefined)
	const other = new Interface(['function updateInfo(uint256,uint256,uint256)'])
	assert.doesNotThrow(() => p.checkCall({
		client: 'other', array: 'epochManagre', chainId: 224422,
		to: '0x648f1a17269627C3d465fEa40b3C229f7CacE5cA', value: 0n,
		data: other.encodeFunctionData('updateInfo', [1, 2, 3]),
	}, lists))
	assert.throws(() => new Policy(JSON.parse(`{"version":1,"clients":{"vdr-payout":{"arrays":{"beamio_vdr_payout":{"chains":[224422],"allow":[{"to":"${VDR_PROXY}","selectors":["settleNodeRewards(uint256[],uint256[],bytes32[])"],"args":{"0":{"minLength":1}}}]}}}}}`)), /unknown field minLength/)
})

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

test('config: gasKeeper enabled without refusedOwners fails closed; refusedOwners must be addresses', () => {
	const { loadConfig } = require('../src/config') as typeof import('../src/config')
	const dir = mkdtempSync(join(tmpdir(), 'wsgk-refused-'))
	try {
		const base = { dataDir: dir, logDir: dir, adminSocket: join(dir, 'a.sock'), policyFile: join(dir, 'p.json'), chains: { '224422': { rpcUrls: ['http://127.0.0.1:1'] } } }
		writeFileSync(join(dir, 'none.json'), JSON.stringify({ ...base, gasKeeper: { enabled: true, intervalMs: 60000, chains: {} } }))
		assert.throws(() => loadConfig(join(dir, 'none.json')), /refusedOwners is required/)
		writeFileSync(join(dir, 'bad.json'), JSON.stringify({ ...base, gasKeeper: { enabled: true, intervalMs: 60000, chains: {}, refusedOwners: ['nope'] } }))
		assert.throws(() => loadConfig(join(dir, 'bad.json')), /is not an address/)
		writeFileSync(join(dir, 'ok.json'), JSON.stringify({ ...base, gasKeeper: { enabled: false, intervalMs: 60000, chains: {} } }))
		assert.deepEqual(loadConfig(join(dir, 'ok.json')).gasKeeper.refusedOwners, [])
	} finally { rmSync(dir, { recursive: true, force: true }) }
})

test('config: an unknown top-level key is refused by name (no silent empty lists)', () => {
	const { loadConfig } = require('../src/config') as typeof import('../src/config')
	const dir = mkdtempSync(join(tmpdir(), 'wsgk-unknown-key-'))
	try {
		const base = { dataDir: dir, logDir: dir, adminSocket: join(dir, 'a.sock'), policyFile: join(dir, 'p.json'), chains: { '224422': { rpcUrls: ['http://127.0.0.1:1'] } } }
		writeFileSync(join(dir, 'unknown.json'), JSON.stringify({ ...base, unknownTestKey: 'x' }))
		assert.throws(() => loadConfig(join(dir, 'unknown.json')), /unknown top-level key "unknownTestKey"/)
		writeFileSync(join(dir, 'ok.json'), JSON.stringify({ ...base, deniedAddressesFile: join(dir, 'd.json') }))
		assert.equal(loadConfig(join(dir, 'ok.json')).deniedAddressesFile, join(dir, 'd.json'))
	} finally { rmSync(dir, { recursive: true, force: true }) }
})
