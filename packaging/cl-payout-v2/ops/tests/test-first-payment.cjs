'use strict'
// 本地测试：用模拟 JSON-RPC 服务器检查 first-payment-check.cjs。正例通过；三个反例各自失败。
// 依赖：NODE_PATH 指向含 ethers 的依赖目录。子进程异步启动，避免阻塞模拟服务器。
const http = require('node:http')
const { spawn } = require('node:child_process')
const path = require('node:path')
const { ethers } = require('ethers')
const SETTLE = new ethers.Interface(['function settleNodeRewards(uint256[] guardianIds, uint256[] amounts, bytes32[] eventKeys)'])
const EVT = new ethers.Interface(['event NodeRewardSettled(uint256 indexed guardianId, address indexed beneficiary, uint256 amount, bytes32 indexed eventKey)'])
const VIEW = new ethers.Interface(['function consumedRewardEventKey(bytes32) view returns (bool)', 'function totalRewardPaid() view returns (uint256)'])
const PROXY = '0xc71e246DD78B37C2fABc905D340932F28F503433'
const TX = '0x' + 'ab'.repeat(32)
const KEYS = ['0x' + '11'.repeat(32), '0x' + '22'.repeat(32)]
const AMOUNTS = [100n, 250n]
const BLOCK = 2187238
function scenario(mode) {
	const input = SETTLE.encodeFunctionData('settleNodeRewards', [[1n, 2n], AMOUNTS, KEYS])
	const logs = KEYS.map((k, i) => {
		const ev = EVT.encodeEventLog(EVT.getEvent('NodeRewardSettled'), [BigInt(i + 1), '0x' + '33'.repeat(20), AMOUNTS[i], k])
		return { address: PROXY, topics: ev.topics, data: ev.data }
	})
	return {
		tx: { hash: TX, to: PROXY, input },
		rc: { status: mode === 'status0' ? '0x0' : '0x1', blockNumber: '0x' + BLOCK.toString(16), gasUsed: '0x' + (517774).toString(16), effectiveGasPrice: '0x' + (1000000000n).toString(16), logs },
		consumed: mode !== 'notconsumed',
		before: 1000n,
		after: mode === 'delta' ? 1300n : 1350n,
	}
}
function serve(sc) {
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			let body = ''
			req.on('data', (c) => (body += c))
			req.on('end', () => {
				const { id, method, params } = JSON.parse(body)
				let result = null
				if (method === 'eth_getTransactionByHash') result = sc.tx
				else if (method === 'eth_getTransactionReceipt') result = sc.rc
				else if (method === 'eth_call') {
					const sel = params[0].data.slice(0, 10)
					if (sel === VIEW.getFunction('consumedRewardEventKey').selector) result = VIEW.encodeFunctionResult('consumedRewardEventKey', [sc.consumed])
					else if (sel === VIEW.getFunction('totalRewardPaid').selector) {
						result = VIEW.encodeFunctionResult('totalRewardPaid', [params[1] === '0x' + (BLOCK - 1).toString(16) ? sc.before : sc.after])
					}
				}
				res.setHeader('content-type', 'application/json')
				res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
			})
		})
		server.listen(0, '127.0.0.1', () => resolve(server))
	})
}
const script = path.join(__dirname, '..', 'first-payment-check.cjs')
function runChild(url) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [script, TX], { env: { ...process.env, RPC_URL: url, VDR_PROXY: PROXY } })
		child.on('close', (code) => resolve(code))
	})
}
async function run(name, mode, wantCode) {
	const server = await serve(scenario(mode))
	const code = await runChild(`http://127.0.0.1:${server.address().port}`)
	server.close()
	const ok = code === wantCode
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: exit=${code} (want ${wantCode})`)
	return ok
}
;(async () => {
	const results = [
		await run('positive: first payment matches events, consumed keys and totalRewardPaid delta', 'ok', 0),
		await run('negative: receipt status 0', 'status0', 1),
		await run('negative: a settled key is not consumed on chain', 'notconsumed', 1),
		await run('negative: totalRewardPaid delta differs from events', 'delta', 1),
	]
	const pass = results.filter(Boolean).length
	console.log(`SUMMARY pass=${pass} fail=${results.length - pass}`)
	process.exit(pass === results.length ? 0 : 1)
})()
