/**
 * Direct tests of the pool money rules (labPoolMoney.ts) plus source ratchets on the call sites, so a mutation of a rule dies WITHOUT relying on e2e scheduling (review r3: three mutants of the
 * balance guard survived in the reviewer's run).
 *   U1 parseReserveWei table     U2 poolAvailableWei table (each term counts, never negative)     U3 readBalanceStrict (an error is an error, a bad value is an error)
 *   R1 the pool pass reads the balance strictly and passes BOTH other-money terms     R2 the reserve is validated at start before anything is converted     R3 no balance read is swallowed
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { batchFits, parseReserveWei, poolAvailableWei, readBalanceStrict, RESERVE_ENV } from './labPoolMoney'

test('U1: reserve parsing - only a plain non-negative decimal integer; unset, blank and every other shape refuse', () => {
	assert.equal(parseReserveWei('0'), 0n)
	assert.equal(parseReserveWei('1'), 1n)
	assert.equal(parseReserveWei('100000000000000000000'), 100000000000000000000n)
	assert.equal(parseReserveWei('  42  '), 42n, 'surrounding blanks are trimmed')
	assert.equal(parseReserveWei('007'), 7n)
	assert.equal(parseReserveWei('9'.repeat(40)), BigInt('9'.repeat(40)))
	for (const bad of [undefined, '', '   ', '-1', '-0', '+1', '1.5', '1.', '.5', '0x10', '0b1', '1e18', '1E3', 'abc', '1 2', '1_000', '１２', '١٢', 'Infinity', 'NaN', '0x', '1\n2', '--1', '1n'])
		assert.throws(() => parseReserveWei(bad), /RESERVE|MIN_VDR_BALANCE_RESERVE_WEI/, `value ${JSON.stringify(bad)} must refuse`)
	assert.throws(() => parseReserveWei(undefined), /no default/)
	assert.throws(() => parseReserveWei('-1'), /non-negative integer/)
	assert.equal(RESERVE_ENV, 'CONET_LAB_MINING_POOL_CL_PAYOUT_MIN_VDR_BALANCE_RESERVE_WEI')
})

test('U2: available = balance - reserve - committed slots - other claims; each term counts; never negative; exact boundaries', () => {
	assert.equal(poolAvailableWei(100n, 0n, 0n, 0n), 100n)
	assert.equal(poolAvailableWei(100n, 10n, 0n, 0n), 90n, 'the reserve counts')
	assert.equal(poolAvailableWei(100n, 0n, 30n, 0n), 70n, 'committed slots count')
	assert.equal(poolAvailableWei(100n, 0n, 0n, 25n), 75n, 'other wallets\' claims count')
	assert.equal(poolAvailableWei(100n, 10n, 30n, 25n), 35n)
	assert.equal(poolAvailableWei(100n, 0n, 60n, 40n), 0n, 'exactly spent')
	assert.equal(poolAvailableWei(100n, 0n, 60n, 41n), 0n, 'over-held is 0, not negative')
	assert.equal(poolAvailableWei(0n, 0n, 0n, 0n), 0n)
	assert.equal(poolAvailableWei(5n, 10n, 0n, 0n), 0n, 'balance below the reserve')
	// the terms are independent: moving amount between slots and claims does not change the result
	assert.equal(poolAvailableWei(100n, 0n, 20n, 20n), poolAvailableWei(100n, 0n, 40n, 0n))
	assert.equal(poolAvailableWei(100n, 0n, 20n, 20n), poolAvailableWei(100n, 0n, 0n, 40n))
})

test('U3: a failed balance read is an error, never a number', async () => {
	await assert.rejects(readBalanceStrict(() => Promise.reject(new Error('rpc 500'))), /rpc 500/)
	await assert.rejects(readBalanceStrict(() => Promise.resolve(undefined as unknown as bigint)), /non-negative bigint/)
	await assert.rejects(readBalanceStrict(() => Promise.resolve(null as unknown as bigint)), /non-negative bigint/)
	await assert.rejects(readBalanceStrict(() => Promise.resolve(-1n)), /non-negative bigint/)
	await assert.rejects(readBalanceStrict(() => Promise.resolve(Number.MAX_SAFE_INTEGER as unknown as bigint)), /non-negative bigint/)
	assert.equal(await readBalanceStrict(() => Promise.resolve(7n)), 7n)
	assert.equal(await readBalanceStrict(() => Promise.resolve(0n)), 0n)
})

test('U4: a batch fits when its total does not exceed what may be spent: exactly equal is allowed, one wei more is refused', () => {
	assert.equal(batchFits(100n, 100n), true, 'equal is allowed')
	assert.equal(batchFits(99n, 100n), true)
	assert.equal(batchFits(101n, 100n), false, 'one wei over is refused')
	assert.equal(batchFits(1n, 0n), false)
	assert.equal(batchFits(0n, 0n), true)
	// through the whole chain: balance exactly equal to the batch (reserve 0, nothing held) passes; one wei short does not
	assert.equal(batchFits(60n, poolAvailableWei(60n, 0n, 0n, 0n)), true)
	assert.equal(batchFits(60n, poolAvailableWei(59n, 0n, 0n, 0n)), false)
	assert.equal(batchFits(60n, poolAvailableWei(120n, 0n, 30n, 30n)), true, 'exactly what is left after the others')
	assert.equal(batchFits(60n, poolAvailableWei(119n, 0n, 30n, 30n)), false)
})

const SRC = fs.readFileSync(path.join(__dirname, 'validatorLabMiningPoolClPayoutReporter.ts'), 'utf8')
const MONEY_SRC = fs.readFileSync(path.join(__dirname, 'labPoolMoney.ts'), 'utf8')
const passBody = (): string => {
	const a = SRC.indexOf('async function poolWalletPassBody')
	assert.ok(a > 0, 'poolWalletPassBody exists')
	const b = SRC.indexOf('\n}\n', a)
	return SRC.slice(a, b)
}

test('R1: the pool pass reads the balance strictly and subtracts BOTH the committed slots and the other wallets\' claims through poolAvailableWei', () => {
	const body = passBody()
	assert.match(body, /readBalanceStrict\(\(\) => provider\.getBalance\(redeemAddr\)\)/)
	assert.match(body, /const slotsWei = session\.core\.slotsAmountWei\(\)/)
	assert.match(body, /const claimsWei = hub\.claimedAmountExcept\(w\.id\)/)
	assert.match(body, /poolAvailableWei\(balance, resolveMinVdrBalanceReserveWei\(\), slotsWei, claimsWei\)/)
	// the refusal compares the batch with that figure
	assert.match(body, /if \(!batchFits\(liveTotal, available\)\)/)
	// the claim happens before the balance read and is released only in the finally
	assert.ok(body.indexOf('hub.claim(') < body.indexOf('readBalanceStrict('))
	assert.ok(body.indexOf('hub.releaseClaim(') > body.indexOf('submitWithdrawBatchDurably'))
	// the claim is released in the finally that wraps everything after it (a leaked claim would refuse every later pass for ever)
	assert.match(body, /\} finally \{\s*\n\s*hub\.releaseClaim\(w\.id\)[^\n]*\n\s*\}\s*\n\s*\} catch \(e: unknown\) \{\s*\n\s*logger\([^\n]*pass error/)
	assert.equal([...body.matchAll(/hub\.releaseClaim\(/g)].length, 1, 'one release, in the finally')
})

test('R2: the reserve is validated at the start, before the legacy slot is migrated or the state converted; its source is the strict parser', () => {
	const a = SRC.indexOf('function planPools(')
	const b = SRC.indexOf('\n}\n', a)
	const plan = SRC.slice(a, b)
	assert.ok(plan.indexOf('resolveMinVdrBalanceReserveWei()') > 0, 'planPools validates the reserve')
	assert.ok(plan.indexOf('resolveMinVdrBalanceReserveWei()') < plan.indexOf('for (const [w] of core.slotEntries())'), 'before the pooled slots are inspected')
	assert.ok(plan.indexOf('resolveMinVdrBalanceReserveWei()') < plan.indexOf('core.getInFlight()'), 'before the legacy record is looked at')
	assert.ok(plan.indexOf('resolveMinVdrBalanceReserveWei()') > plan.indexOf('loadPoolConfig('), 'only in pool mode (after the pool file is loaded)')
	assert.match(SRC, /const resolveMinVdrBalanceReserveWei = \(\): bigint => parseReserveWei\(process\.env\[RESERVE_ENV\]\)/)
	assert.match(MONEY_SRC, /if \(!\/\^\\d\+\$\/\.test\(raw\)\) throw/)
	assert.match(SRC, /config minVdrBalanceReserveWei=\$\{resolveMinVdrBalanceReserveWei\(\)\}/)
})

test('R3: no balance read in the reporter swallows its error', () => {
	for (const m of SRC.matchAll(/getBalance\([^)]*\)([^\n]*)/g)) assert.ok(!/\.catch\(|\?\?|\|\|/.test(m[1] ?? ''), `getBalance followed by a swallow: ${m[0]}`)
	assert.ok(!/readBalanceStrict\([^\n]*\)\s*\.catch/.test(SRC))
	assert.ok(!/\.catch\(/.test(MONEY_SRC.slice(MONEY_SRC.indexOf('export async function readBalanceStrict'))))
	assert.ok(!/try\s*{/.test(MONEY_SRC.slice(MONEY_SRC.indexOf('export async function readBalanceStrict'))))
})
