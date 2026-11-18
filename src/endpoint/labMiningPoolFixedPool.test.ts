/**
 * Unit tests for the fixed Lab mining pool payee (B-4). No socket is opened: the pool check must
 * refuse before any signer lookup or connection. Node built-ins and ethers only.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ethers } from 'ethers'
import {
	LAB_MINING_POOL_FIXED,
	assertFixedLabMiningPool,
	buildLabWithdrawNativeSignerTx,
	resolveFixedLabMiningPool,
	sendConfiguredLabWithdrawNative,
} from './labMiningPoolPayoutSigner'

const OTHER_POOL = '0x1111111111111111111111111111111111111111'
const REDEEM = '0x2222222222222222222222222222222222222222'
const KEY = '0x' + '11'.repeat(32)

test('B-4: the fixed pool is the checksummed deployments value', () => {
	assert.equal(LAB_MINING_POOL_FIXED, '0x32bE583C8e778FFfC5107BF34820c2B225336201')
	assert.equal(assertFixedLabMiningPool(LAB_MINING_POOL_FIXED.toLowerCase()), LAB_MINING_POOL_FIXED, 'any letter case is accepted')
})

test('B-4: buildLabWithdrawNativeSignerTx refuses any other pool and encodes only the fixed one', () => {
	assert.throws(
		() => buildLabWithdrawNativeSignerTx({ keyArray: 'lab_mining_pool_payout', redeem: REDEEM, pool: OTHER_POOL, amount: 1n, eventKeys: [KEY], gasLimit: 800000 }),
		/refuses pool 0x1111.*only the fixed Lab mining pool/
	)
	assert.throws(
		() => buildLabWithdrawNativeSignerTx({ keyArray: 'lab_mining_pool_payout', redeem: REDEEM, pool: 'not-an-address', amount: 1n, eventKeys: [KEY], gasLimit: 800000 }),
		/not a valid address/
	)
	const tx = buildLabWithdrawNativeSignerTx({
		keyArray: 'lab_mining_pool_payout',
		redeem: REDEEM,
		pool: LAB_MINING_POOL_FIXED.toLowerCase(),
		amount: 5n,
		eventKeys: [KEY],
		gasLimit: 800000,
	})
	const decoded = new ethers.Interface(['function withdrawNative(address to, uint256 amount)']).decodeFunctionData('withdrawNative', tx.data)
	assert.equal(decoded[0], LAB_MINING_POOL_FIXED)
	assert.equal(decoded[1], 5n)
})

test('B-4: sendConfiguredLabWithdrawNative refuses a non-fixed pool before any signer lookup', async () => {
	const env = {
		CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_SOCKET: '/nonexistent/lab-payout.sock',
		CONET_LAB_MINING_POOL_CL_PAYOUT_KEY_ARRAY: 'lab_mining_pool_payout',
	}
	await assert.rejects(
		sendConfiguredLabWithdrawNative({ redeem: REDEEM, pool: OTHER_POOL, amount: 1n, eventKeys: [KEY], gasLimit: 800000, env }),
		/refuses pool 0x1111/,
		'the pool check must run before the socket is touched'
	)
})

test('B-4: the manifest and env may only restate the fixed pool', () => {
	assert.equal(resolveFixedLabMiningPool({}), LAB_MINING_POOL_FIXED)
	assert.equal(resolveFixedLabMiningPool({ manifestPool: LAB_MINING_POOL_FIXED.toLowerCase(), envPool: '' }), LAB_MINING_POOL_FIXED)
	assert.throws(() => resolveFixedLabMiningPool({ manifestPool: OTHER_POOL }), /manifest miningPool: lab withdrawNative refuses pool/)
	assert.throws(() => resolveFixedLabMiningPool({ envPool: OTHER_POOL }), /CONET_LAB_MINING_POOL_ADDRESS: lab withdrawNative refuses pool/)
})
