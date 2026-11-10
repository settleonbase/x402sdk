/**
 * Local Anvil only. The PM key is a synthetic HD key created in this process.
 * Nothing here reads ~/.master.json, prints a key, or talks to a production RPC.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { JsonRpcProvider, Wallet, getAddress, hexlify, toBeHex } from 'ethers'
import { AuditLog } from '../src/audit'
import { BEAMIO_ORACLE_CONTRACT, GasKeeper, LEAKED_ORACLE_OWNER, ORACLE_OWNER_ARRAY, ORACLE_OWNER_WALLET_EXAMPLE } from '../src/gasKeeper'
import { HdRoot, PM_ACCOUNT, mnemonicToEntropyBytes, newMnemonic } from '../src/hd'
import type { Keyring } from '../src/keyring'
import type { KeyArray, RegistryBody } from '../src/registry'
import type { TxManager } from '../src/txManager'

const OWNER = getAddress(ORACLE_OWNER_WALLET_EXAMPLE)
const CONTRACT = getAddress(BEAMIO_ORACLE_CONTRACT)
const LEAKED = getAddress(LEAKED_ORACLE_OWNER)

function ownerRuntime(addr: string): string {
	const word = addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')
	return `0x7f${word}60005260206000f3`
}

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

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer()
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			const port = typeof address === 'object' && address ? address.port : 0
			server.close(() => resolve(port))
		})
	})
}

type PmTx = { hash: string; to: string | null; value: bigint }

async function pmTransfers(provider: JsonRpcProvider, from: string): Promise<PmTx[]> {
	const latest = await provider.getBlockNumber()
	const out: PmTx[] = []
	const want = from.toLowerCase()
	for (let i = 0; i <= latest; i++) {
		const block = await provider.send('eth_getBlockByNumber', [`0x${i.toString(16)}`, true]) as {
			transactions?: Array<{ hash: string; from: string; to: string | null; value: string }>
		} | null
		for (const tx of block?.transactions ?? []) {
			if (tx.from.toLowerCase() !== want) continue
			out.push({ hash: tx.hash, to: tx.to, value: BigInt(tx.value) })
		}
	}
	return out
}

function assertNoValueTo(txs: PmTx[], to: string): void {
	const want = to.toLowerCase()
	assert.equal(txs.some((tx) => tx.to?.toLowerCase() === want && tx.value > 0n), false)
}

test('anvil: oracle owner intersection, refusals, budget, retry, lock, restart', { timeout: 180_000 }, async (t) => {
	const port = await freePort()
	const anvil: ChildProcess = spawn('anvil', [
		'--host', '127.0.0.1',
		'--port', String(port),
		'--chain-id', '224422',
		'--silent',
		'--gas-price', '1',
	], { stdio: 'ignore' })
	const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, 224422, { staticNetwork: true, cacheTimeout: -1 })
	const hd = HdRoot.fromEntropy(mnemonicToEntropyBytes(newMnemonic()))
	const derived = hd.derive(PM_ACCOUNT, 0)
	const pm = new Wallet(hexlify(derived.priv))
	derived.priv.fill(0)
	hd.wipe()
	const signer = pm.connect(provider)
	const dirs: string[] = []

	const stop = async (): Promise<void> => {
		provider.destroy()
		anvil.kill('SIGTERM')
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
	}

	try {
		let ready = false
		for (let i = 0; i < 50; i++) {
			try {
				await provider.getBlockNumber()
				ready = true
				break
			} catch {
				await delay(100)
			}
		}
		if (!ready) throw new Error('anvil did not start')
		assert.equal(Number(await provider.send('eth_chainId', [])), 224422)

		await provider.send('anvil_setBalance', [pm.address, toBeHex(10n ** 18n)])
		await provider.send('anvil_setBalance', [OWNER, '0x0'])
		await provider.send('anvil_setBalance', [CONTRACT, '0x0'])
		await provider.send('anvil_setBalance', [LEAKED, '0x0'])
		await provider.send('anvil_setCode', [CONTRACT, ownerRuntime(OWNER)])
		const ownerWord = await provider.call({ to: CONTRACT, data: '0x8da5cb5b' })
		assert.equal(getAddress(`0x${ownerWord.slice(-40)}`), OWNER)
		const contractCode = await provider.getCode(CONTRACT)
		assert.equal(contractCode === '0x' || contractCode === '0x0', false)

		const make = (label: string, opts: {
			wallets: string[]
			arrays: KeyArray[]
			budgetWei?: string
			perAddressDailyWei?: string
			globalDailyWei?: string
			unlocked?: boolean
		}) => {
			const dir = mkdtempSync(join(tmpdir(), `ws-anvil-${label}-`))
			dirs.push(dir)
			const statePath = join(dir, 'gaskeeper-state.json')
			const auditPath = join(dir, 'audit.jsonl')
			const alerts: string[] = []
			const records = new Map<string, { hash?: string; status?: string; idempotencyKey?: string }>()
			let throwBeforeSend = false
			let reportSent = false
			const txm = {
				provider() {
					return provider
				},
				inflightCount() {
					return 0
				},
				get(query: { idempotencyKey?: string; hash?: string }) {
					if (query.idempotencyKey && records.has(query.idempotencyKey)) return records.get(query.idempotencyKey)
					if (query.hash && records.has(query.hash)) return records.get(query.hash)
					return undefined
				},
				async send(req: { to: string; value: bigint; gasLimit?: bigint; idempotencyKey?: string; client?: string; array?: string; candidates?: string[] }) {
					if (throwBeforeSend) throw new Error('broadcast failed before send')
					assert.equal(req.client, 'gas-keeper')
					assert.equal(req.array, 'PM')
					assert.deepEqual((req.candidates ?? []).map((addr) => getAddress(addr)), [getAddress(pm.address)])
					const fee = await provider.getFeeData()
					const gasPrice = fee.maxFeePerGas ?? fee.gasPrice
					if (gasPrice === null || gasPrice === undefined || gasPrice <= 0n) throw new Error('anvil fee missing')
					const tx = await signer.sendTransaction({
						to: req.to,
						value: req.value,
						gasLimit: req.gasLimit ?? 21_000n,
						chainId: 224422,
						type: 0,
						gasPrice,
					})
					const receipt = await tx.wait()
					assert.equal(receipt?.status, 1)
					const status = reportSent ? 'sent' : 'mined'
					const row = { hash: tx.hash, status, idempotencyKey: req.idempotencyKey }
					if (req.idempotencyKey) records.set(req.idempotencyKey, row)
					records.set(tx.hash, row)
					return row
				},
			}
			const registry = (): RegistryBody => ({
				version: 1,
				pm: getAddress(pm.address),
				attestor: getAddress(pm.address),
				arrays: opts.arrays,
				updatedAt: '2026-11-09T09:49:58.152Z',
			})
			const chain = {
				'224422': {
					minWei: '100',
					targetWei: '1000',
					perAddressDailyWei: opts.perAddressDailyWei ?? '100000',
					globalDailyWei: opts.globalDailyWei ?? '100000',
					budgetWei: opts.budgetWei ?? '1000000',
					pmWarnWei: '1',
					pmCriticalWei: '1',
					wallets: opts.wallets,
				},
			}
			const build = () => new GasKeeper(
				chain,
				60_000,
				txm as unknown as TxManager,
				{ unlocked: opts.unlocked !== false } as unknown as Keyring,
				registry,
				() => new Set<string>(),
				{ send(_level: string, code: string) { alerts.push(code) } },
				new AuditLog(auditPath),
				statePath,
			)
			return {
				gk: build(),
				restart: build,
				alerts,
				auditPath,
				armThrow() { throwBeforeSend = true },
				clearThrow() { throwBeforeSend = false },
				reportUnconfirmed() { reportSent = true },
			}
		}

		await t.test('contract on the whitelist is refused and receives nothing', async () => {
			const before = await pmTransfers(provider, pm.address)
			const fx = make('contract', {
				wallets: [CONTRACT, OWNER],
				arrays: [keyArray(ORACLE_OWNER_ARRAY, [OWNER])],
			})
			// Owner is eligible, so this run also proves the contract is skipped while the wallet is paid.
			await provider.send('anvil_setBalance', [OWNER, '0x0'])
			await fx.gk.runOnce()
			const after = await pmTransfers(provider, pm.address)
			const fresh = after.slice(before.length)
			assert.equal(fresh.length, 1, fx.alerts.join(' | '))
			assert.equal(getAddress(fresh[0]!.to!), OWNER)
			assert.equal(fresh[0]!.value, 1000n)
			assertNoValueTo(after, CONTRACT)
			assert.equal(await provider.getBalance(CONTRACT), 0n)
			assert.equal(await provider.getBalance(OWNER), 1000n)
			const audit = readFileSync(fx.auditPath, 'utf8')
			assert.equal(audit.includes('"event":"gas.topup-refused"'), true)
			assert.equal(audit.includes('"reason":"contract"'), true)
			assert.equal(audit.includes(CONTRACT), true)
			assert.ok(fx.alerts.some((code) => code.startsWith(`topup-refused:224422:contract:${CONTRACT.toLowerCase()}`)))
		})

		await t.test('other array, unregistered, leaked, and nonempty code are refused', async () => {
			const coded = getAddress(Wallet.createRandom().address)
			await provider.send('anvil_setCode', [coded, '0x60016000f3'])
			await provider.send('anvil_setCode', [CONTRACT, ownerRuntime(coded)])
			const before = await pmTransfers(provider, pm.address)
			const codedFx = make('code', {
				wallets: [coded],
				arrays: [keyArray(ORACLE_OWNER_ARRAY, [coded])],
			})
			await codedFx.gk.runOnce()
			assert.ok(codedFx.alerts.some((code) => code.includes(':code:')))

			await provider.send('anvil_setCode', [CONTRACT, ownerRuntime(LEAKED)])
			const leakedFx = make('leaked', {
				wallets: [LEAKED],
				arrays: [keyArray(ORACLE_OWNER_ARRAY, [LEAKED])],
			})
			await leakedFx.gk.runOnce()
			assert.ok(leakedFx.alerts.some((code) => code.includes(':leaked:')))

			await provider.send('anvil_setCode', [CONTRACT, ownerRuntime(OWNER)])
			const otherFx = make('other', {
				wallets: [OWNER],
				arrays: [keyArray('settle_contractAdmin', [OWNER])],
			})
			await otherFx.gk.runOnce()
			assert.ok(otherFx.alerts.some((code) => code.includes(':other-array:')))

			const missingFx = make('missing', {
				wallets: [OWNER],
				arrays: [keyArray(ORACLE_OWNER_ARRAY, [])],
			})
			await missingFx.gk.runOnce()
			assert.ok(missingFx.alerts.some((code) => code.includes(':unregistered:')))

			const after = await pmTransfers(provider, pm.address)
			assert.equal(after.length, before.length)
			assertNoValueTo(after, CONTRACT)
			assertNoValueTo(after, LEAKED)
			assertNoValueTo(after, coded)
			assert.equal(await provider.getBalance(LEAKED), 0n)
			assert.equal(await provider.getBalance(coded), 0n)
		})

		await t.test('example owner is not paid when owner() disagrees', async () => {
			const stranger = getAddress(Wallet.createRandom().address)
			await provider.send('anvil_setCode', [CONTRACT, ownerRuntime(stranger)])
			await provider.send('anvil_setBalance', [OWNER, '0x0'])
			const before = await pmTransfers(provider, pm.address)
			const fx = make('bypass', {
				wallets: [OWNER],
				arrays: [keyArray(ORACLE_OWNER_ARRAY, [OWNER])],
			})
			await fx.gk.runOnce()
			await provider.send('anvil_setCode', [CONTRACT, ownerRuntime(OWNER)])
			const after = await pmTransfers(provider, pm.address)
			assert.equal(after.length, before.length)
			assert.equal(await provider.getBalance(OWNER), 0n)
			assert.ok(fx.alerts.some((code) => code.includes(`:not-owner:${OWNER.toLowerCase()}`)))
		})

		await t.test('persistent budget stops a second top-up', async () => {
			await provider.send('anvil_setBalance', [OWNER, '0x0'])
			const before = await pmTransfers(provider, pm.address)
			const fx = make('budget', {
				wallets: [OWNER],
				arrays: [keyArray(ORACLE_OWNER_ARRAY, [OWNER])],
				budgetWei: '1000',
				perAddressDailyWei: '100000',
				globalDailyWei: '100000',
			})
			await fx.gk.runOnce()
			assert.equal(await provider.getBalance(OWNER), 1000n)
			await provider.send('anvil_setBalance', [OWNER, '0x0'])
			await fx.gk.runOnce()
			const after = await pmTransfers(provider, pm.address)
			assert.equal(after.length, before.length + 1)
			assert.equal(await provider.getBalance(OWNER), 0n)
			assert.ok(fx.alerts.includes('topup-budget:224422'))
		})

		await t.test('a failed broadcast retries once and then pays', async () => {
			await provider.send('anvil_setBalance', [OWNER, '0x0'])
			const before = await pmTransfers(provider, pm.address)
			const fx = make('retry', {
				wallets: [OWNER],
				arrays: [keyArray(ORACLE_OWNER_ARRAY, [OWNER])],
			})
			fx.armThrow()
			await fx.gk.runOnce()
			assert.equal((await pmTransfers(provider, pm.address)).length, before.length)
			fx.clearThrow()
			await fx.gk.runOnce()
			const after = await pmTransfers(provider, pm.address)
			assert.equal(after.length, before.length + 1)
			assert.equal(getAddress(after.at(-1)!.to!), OWNER)
			assert.equal(await provider.getBalance(OWNER), 1000n)
		})

		await t.test('locked keeper does not sign', async () => {
			const nonce = await provider.getTransactionCount(pm.address)
			const before = await pmTransfers(provider, pm.address)
			const fx = make('locked', {
				wallets: [OWNER, CONTRACT],
				arrays: [keyArray(ORACLE_OWNER_ARRAY, [OWNER])],
				unlocked: false,
			})
			await fx.gk.runOnce()
			assert.equal(await provider.getTransactionCount(pm.address), nonce)
			assert.equal((await pmTransfers(provider, pm.address)).length, before.length)
			assert.equal(fx.alerts.length, 0)
		})

		await t.test('0x00 bytecode is refused even when owner, registry, and whitelist match', async () => {
			const coded = getAddress(Wallet.createRandom().address)
			await provider.send('anvil_setCode', [coded, '0x00'])
			await provider.send('anvil_setCode', [CONTRACT, ownerRuntime(coded)])
			assert.equal((await provider.getCode(coded)).toLowerCase(), '0x00')
			const before = await pmTransfers(provider, coded)
			const pmBefore = await pmTransfers(provider, pm.address)
			const fx = make('zero-byte', {
				wallets: [coded],
				arrays: [keyArray(ORACLE_OWNER_ARRAY, [coded])],
			})
			await fx.gk.runOnce()
			await provider.send('anvil_setCode', [CONTRACT, ownerRuntime(OWNER)])
			const after = await pmTransfers(provider, pm.address)
			assert.equal(after.length, pmBefore.length)
			assert.equal((await pmTransfers(provider, coded)).length, before.length)
			assertNoValueTo(after, coded)
			assert.equal(await provider.getBalance(coded), 0n)
			assert.ok(fx.alerts.some((code) => code.includes(`:code:${coded.toLowerCase()}`)))
		})

		await t.test('restart does not broadcast an unconfirmed top-up again', async () => {
			await provider.send('anvil_setBalance', [OWNER, '0x0'])
			const fx = make('restart', {
				wallets: [OWNER],
				arrays: [keyArray(ORACLE_OWNER_ARRAY, [OWNER])],
			})
			fx.reportUnconfirmed()
			const before = await pmTransfers(provider, pm.address)
			await fx.gk.runOnce()
			assert.equal((await pmTransfers(provider, pm.address)).length, before.length + 1)
			await provider.send('anvil_setBalance', [OWNER, '0x0'])
			const nonce = await provider.getTransactionCount(pm.address)
			await fx.restart().runOnce()
			assert.equal(await provider.getTransactionCount(pm.address), nonce)
			assert.equal((await pmTransfers(provider, pm.address)).length, before.length + 1)
			assert.equal(await provider.getBalance(OWNER), 0n)
		})

		const all = await pmTransfers(provider, pm.address)
		assertNoValueTo(all, CONTRACT)
		assertNoValueTo(all, LEAKED)
		assert.equal(await provider.getBalance(CONTRACT), 0n)
		assert.equal(await provider.getBalance(LEAKED), 0n)
		assert.ok(all.some((tx) => tx.to && getAddress(tx.to) === OWNER && tx.value === 1000n))
	} finally {
		await stop()
	}
})
