/** Tests for the startup configuration parsers and the redeem pin (round-4 F5). Pure functions, no I/O. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ethers } from 'ethers'
import {
	assertPinnedRedeem,
	DEFAULT_MAX_GAS_PRICE_WEI,
	gasLimitFromEnv,
	gasWaitForceFromEnv,
	maxGasWeiFromEnv,
	startupConfigLine,
} from './labStartupConfig'

const PINNED = '0x1111111111111111111111111111111111111111'

test('F5: max gas: unset gives the default with reason unset; a valid GWEI is env; a valid WEI wins', () => {
	const unset = maxGasWeiFromEnv(undefined, undefined)
	assert.equal(unset.value, DEFAULT_MAX_GAS_PRICE_WEI)
	assert.equal(unset.src, 'default')
	assert.equal(unset.reason, 'unset')
	const gwei = maxGasWeiFromEnv(undefined, '0.03')
	assert.equal(gwei.value, ethers.parseUnits('0.03', 'gwei'))
	assert.equal(gwei.src, 'env')
	assert.equal(gwei.name, 'CONET_LAB_MINING_POOL_CL_PAYOUT_MAX_GAS_PRICE_GWEI')
	const wei = maxGasWeiFromEnv('12345', '0.03')
	assert.equal(wei.value, 12345n)
	assert.equal(wei.name, 'CONET_LAB_MINING_POOL_CL_PAYOUT_MAX_GAS_PRICE_WEI')
})

test('F5: max gas: a rejected GWEI falls back to the default and says why (src=default, reason kept)', () => {
	const bad = maxGasWeiFromEnv(undefined, 'abc')
	assert.equal(bad.src, 'default')
	assert.equal(bad.value, DEFAULT_MAX_GAS_PRICE_WEI)
	assert.match(bad.reason, /rejected "abc"/)
	const zero = maxGasWeiFromEnv(undefined, '0')
	assert.equal(zero.src, 'default')
	const badWeiGoodGwei = maxGasWeiFromEnv('x', '0.03')
	assert.equal(badWeiGoodGwei.src, 'env')
	assert.match(badWeiGoodGwei.reason, /WEI rejected "x"/)
})

test('F5: gas wait: 30000 is the minimum; below it, or non-numeric, the default is used and the reason is kept', () => {
	assert.equal(gasWaitForceFromEnv(undefined).src, 'default')
	const ok = gasWaitForceFromEnv('300000')
	assert.equal(ok.value, 300_000)
	assert.equal(ok.src, 'env')
	assert.equal(gasWaitForceFromEnv('30000').src, 'env')
	const small = gasWaitForceFromEnv('29999')
	assert.equal(small.src, 'default')
	assert.equal(small.value, 300_000)
	assert.match(small.reason, /rejected "29999"/)
	assert.match(gasWaitForceFromEnv('abc').reason, /rejected "abc"/)
	assert.equal(gasWaitForceFromEnv('300000.7').value, 300_000)
})

test('F5: gas limit: minimum 100000, capped at 8000000; the cap is reported', () => {
	assert.equal(gasLimitFromEnv(undefined).value, 800_000)
	assert.equal(gasLimitFromEnv('800000').src, 'env')
	assert.equal(gasLimitFromEnv('99999').src, 'default')
	const capped = gasLimitFromEnv('9000000')
	assert.equal(capped.value, 8_000_000)
	assert.equal(capped.src, 'env')
	assert.match(capped.reason, /capped at 8000000/)
})

test('redeem pin: unset or equal passes; a different address refuses the start; an invalid address refuses', () => {
	assert.equal(assertPinnedRedeem(undefined, PINNED), ethers.getAddress(PINNED))
	assert.equal(assertPinnedRedeem(PINNED.toUpperCase().replace('0X', '0x'), PINNED), ethers.getAddress(PINNED))
	assert.throws(() => assertPinnedRedeem('0x2222222222222222222222222222222222222222', PINNED), /differs from the pinned Lab redeem/)
	assert.throws(() => assertPinnedRedeem('not-an-address', PINNED), /not a valid address/)
})

test('R5 F5: the startup log text shows each effective value with its source; a rejected value says src=default and why', () => {
	const set = startupConfigLine({
		CONET_LAB_MINING_POOL_CL_PAYOUT_MAX_GAS_PRICE_GWEI: '0.03',
		CONET_LAB_MINING_POOL_CL_PAYOUT_GAS_WAIT_FORCE_MS: '400000',
		CONET_LAB_MINING_POOL_CL_PAYOUT_GAS_LIMIT: '800000',
	})
	assert.match(set, /maxGasGwei=0\.03 src=env name=CONET_LAB_MINING_POOL_CL_PAYOUT_MAX_GAS_PRICE_GWEI reason="accepted"/)
	assert.match(set, /gasWaitForceMs=400000 src=env name=CONET_LAB_MINING_POOL_CL_PAYOUT_GAS_WAIT_FORCE_MS reason="accepted"/)
	assert.match(set, /gasLimit=800000 src=env name=CONET_LAB_MINING_POOL_CL_PAYOUT_GAS_LIMIT reason="accepted"/)
	const rejected = startupConfigLine({ CONET_LAB_MINING_POOL_CL_PAYOUT_GAS_WAIT_FORCE_MS: '29999' })
	assert.match(rejected, /gasWaitForceMs=300000 src=default name=default reason="rejected "29999" \(must be a number >= 30000 ms\)"/)
	const unset = startupConfigLine({})
	assert.match(unset, /maxGasGwei=0\.03 src=default name=default reason="unset"/)
})
