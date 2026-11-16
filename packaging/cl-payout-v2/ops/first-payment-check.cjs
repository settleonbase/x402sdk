'use strict'
// 首笔付款验收（只读 RPC，不签名，不发送）。
// 用法：RPC_URL=<http(s) RPC> [VDR_PROXY=<期望代理地址>] NODE_PATH=<依赖目录> node first-payment-check.cjs <0x 交易哈希>
// 输出 JSON。全部检查通过退出码 0；未通过 1；输入或 RPC 错误 2。RPC_URL 不打印。
const { ethers } = require('ethers')
function fail(msg, code = 2) { console.error('ERROR ' + msg); process.exit(code) }
const RPC = process.env.RPC_URL || ''
const txHash = process.argv[2] || ''
if (!/^https?:\/\//.test(RPC)) fail('RPC_URL must be http(s); value not printed')
if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) fail('usage: RPC_URL=... node first-payment-check.cjs <0x tx hash>')
async function rpc(method, params) {
	const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
	if (!res.ok) fail(`RPC ${method} HTTP ${res.status}`)
	const j = await res.json()
	if (j.error) fail(`RPC ${method} error: ${j.error.message}`)
	return j.result
}
const SETTLE = new ethers.Interface(['function settleNodeRewards(uint256[] guardianIds, uint256[] amounts, bytes32[] eventKeys)'])
const EVT = new ethers.Interface(['event NodeRewardSettled(uint256 indexed guardianId, address indexed beneficiary, uint256 amount, bytes32 indexed eventKey)'])
const VIEW = new ethers.Interface(['function consumedRewardEventKey(bytes32) view returns (bool)', 'function totalRewardPaid() view returns (uint256)'])
;(async () => {
	const tx = await rpc('eth_getTransactionByHash', [txHash])
	if (!tx) fail('transaction not found', 1)
	const rc = await rpc('eth_getTransactionReceipt', [txHash])
	if (!rc) fail('receipt not found (not mined)', 1)
	const block = BigInt(rc.blockNumber)
	const dec = SETTLE.decodeFunctionData('settleNodeRewards', tx.input)
	const inKeys = dec[2].map((k) => k.toLowerCase())
	const inAmounts = dec[1].map((x) => BigInt(x))
	const inputSum = inAmounts.reduce((a, b) => a + b, 0n)
	const proxy = tx.to.toLowerCase()
	const evs = rc.logs.filter((l) => l.address.toLowerCase() === proxy && l.topics[0] === EVT.getEvent('NodeRewardSettled').topicHash)
		.map((l) => { const p = EVT.parseLog({ topics: l.topics, data: l.data }); return { key: p.args.eventKey.toLowerCase(), amount: p.args.amount } })
	const evSum = evs.reduce((a, e) => a + e.amount, 0n)
	const evKeySet = [...new Set(evs.map((e) => e.key))].sort()
	const inKeySet = [...new Set(inKeys)].sort()
	const consumed = {}
	for (const k of inKeys) {
		const data = VIEW.encodeFunctionData('consumedRewardEventKey', [k])
		const r = await rpc('eth_call', [{ to: tx.to, data }, 'latest'])
		consumed[k] = VIEW.decodeFunctionResult('consumedRewardEventKey', r)[0] === true
	}
	const total = async (tag) => VIEW.decodeFunctionResult('totalRewardPaid', await rpc('eth_call', [{ to: tx.to, data: VIEW.encodeFunctionData('totalRewardPaid', []) }, tag]))[0]
	const before = await total('0x' + (block - 1n).toString(16))
	const after = await total('0x' + block.toString(16))
	const delta = after - before
	const gasUsed = BigInt(rc.gasUsed)
	const egp = BigInt(rc.effectiveGasPrice)
	const checks = {
		receiptStatusIs1: BigInt(rc.status) === 1n,
		proxyIsExpected: process.env.VDR_PROXY ? proxy === process.env.VDR_PROXY.toLowerCase() : 'not-provided',
		keySetEqualsEventKeySet: JSON.stringify(inKeySet) === JSON.stringify(evKeySet),
		allKeysConsumedOnChain: Object.values(consumed).every(Boolean),
		amountsMatchInput: evSum === inputSum,
		totalRewardPaidDeltaEqualsEvents: delta === evSum,
	}
	const pass = Object.values(checks).every((v) => v === true || v === 'not-provided')
	const out = {
		txHash, status: Number(rc.status), blockNumber: Number(block), proxy: tx.to,
		gasUsed: gasUsed.toString(), effectiveGasPriceGwei: ethers.formatUnits(egp, 'gwei'),
		feeCNET: ethers.formatEther(gasUsed * egp), keys: inKeys.length, events: evs.length,
		inputSumWei: inputSum.toString(), eventSumWei: evSum.toString(),
		totalRewardPaidBeforeWei: before.toString(), totalRewardPaidAfterWei: after.toString(), deltaWei: delta.toString(),
		checks, pass,
	}
	console.log(JSON.stringify(out, null, 2))
	process.exit(pass ? 0 : 1)
})().catch((e) => fail(e.message || String(e)))
