// 接线顺序守卫（只读源码文本，不加载 MemberCard / beamioServer / beamioMaster，避免顶层副作用）。
// 作用：防止有人把门禁挪到广播之后、恢复旧的 items/默认卡选卡或 EOA 回退。它不替代运行时测试，
// 运行时的拒绝语义见 chargeRelayGate.test.ts 与 chargeRelayOrder.test.ts。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const MC = readFileSync(new URL('../MemberCard.ts', import.meta.url), 'utf8')
const BS = readFileSync(new URL('./beamioServer.ts', import.meta.url), 'utf8')

const slice = (src: string, start: string, end: string): string => {
	const a = src.indexOf(start)
	assert.ok(a >= 0, `start marker found: ${start.slice(0, 60)}`)
	const b = src.indexOf(end, a + start.length)
	assert.ok(b > a, `end marker found: ${end.slice(0, 60)}`)
	return src.slice(a, b)
}
const at = (src: string, needle: string, from = 0): number => {
	const i = src.indexOf(needle, from)
	assert.ok(i >= 0, `needle present: ${needle.slice(0, 70)}`)
	return i
}

const master = slice(MC, 'export const OpenContainerRelayProcess = async () => {', '\n/** NFC Container 记账：字符串金额')

test('Master order: gate → relay context → payee rewrite → pre-broadcast recheck → broadcast → 200 → post-broadcast fee', () => {
	const iGate = at(master, 'const chargeGate = await gateChargeRelay(')
	const iReject = at(master, 'if (!chargeGate.ok) {', iGate)
	const iRelayCtx = at(master, 'const relayCtx = await merchantCardRelayContext(SC, relayCardSeed)', iGate)
	const iAaFactory = at(master, 'let relayAaFactoryAddr: string | null = chargeGate.aaFactory', iGate)
	const iRewrite = at(master, 'if (chargeGate.hasNonCcsaErc1155 && relayCardSeed) {', iGate)
	const iRecheck = at(master, 'await recheckBindingBeforeBroadcast(chargeGate.cardAddress', iGate)
	const iBroadcast = at(master, 'const tx = await FactoryWithRelay.relayHandleOps([txOp], beneficiary', iGate)
	const i200 = at(master, 'obj.res.status(200).json({', iBroadcast)
	const iFee = at(master, 'const feePayerEOA = chargeGate.feeConsumer', iBroadcast)
	const iPush = at(master, 'beamioTransferIndexerAccountingPool.push({', iBroadcast)
	assert.ok(iGate < iReject && iReject < iRelayCtx, 'rejection returns before the relay context')
	assert.ok(iRelayCtx < iAaFactory && iAaFactory < iRewrite && iRewrite < iRecheck, 'context and rewrite come before the recheck')
	assert.ok(iRecheck < iBroadcast, 'recheck before broadcast')
	assert.ok(iBroadcast < i200 && i200 < iFee && iFee < iPush, 'fee confirmed pre-broadcast; 200 after receipt; accounting after')
})

test('Master: nothing signs, broadcasts, answers 200 or queues accounting before the gate', () => {
	const iGate = at(master, 'const chargeGate = await gateChargeRelay(')
	const before = master.slice(0, iGate)
	for (const forbidden of ['relayHandleOps(', 'obj.res.status(200)', 'beamioTransferIndexerAccountingPool.push(', 'signTypedData', 'wallet.sendTransaction']) {
		assert.equal(before.includes(forbidden), false, `no ${forbidden} before the gate`)
	}
})

test('Master: the old selection and EOA fallback are gone from the OpenContainer path', () => {
	for (const gone of [
		'resolveChargeFeePayerCardFromOpenContainerItems',
		'feePayerPickOpen',
		'fallback EOA for consume',
		'erc1155CardAddr',
		'const relayCardSeed = erc1155CardAddr',
	]) {
		assert.equal(master.includes(gone), false, `${gone} removed`)
	}
})

test('Master: relay seed, AA factory, payee rewrite and fee card come from the one verified verdict', () => {
	assert.ok(master.includes('const merchantCardNorm = chargeGate.cardAddress'))
	assert.ok(master.includes('const relayCardSeed = merchantCardNorm'))
	assert.ok(master.includes('const feePayerCard = chargeGate.cardAddress'))
	assert.ok(master.includes('const feeBUnits6 = chargeGate.feeBUnits6'))
})

test('Master: a post-broadcast failure is logged as CHARGE_FEE_PENDING and never replayed', () => {
	assert.ok(master.includes('[CHARGE_FEE_PENDING]'))
	assert.equal(/relayHandleOps\(\[txOp\][\s\S]*?catch[\s\S]*?relayHandleOps\(\[txOp\]/.test(master), false, 'no second broadcast in a catch')
})

test('Cluster: admission runs before queueing, the fee precheck and forwarding; forwarded card is the verified card', () => {
	const route = slice(BS, "router.post('/AAtoEOA', async (req, res) => {", '\n\t\tconst preCheck = AAtoEOAPreCheck(')
	const iAdm = at(route, 'const chargeAdmission = await admitChargeRequest(')
	const iReject = at(route, 'if (!chargeAdmission.ok) {', iAdm)
	const iAaRead = at(route, 'const merchantCardRaw = chargeAdmission.cardAddress', iAdm)
	const iPre = at(route, 'OpenContainerRelayPreCheckBUnitFee(body.openContainerPayload, body.currency ?? [], body.currencyAmount ?? [], chargeAdmission.cardAddress)', iAdm)
	const iForward = at(route, 'server OpenContainer pre-check OK, forwarding', iAdm)
	assert.ok(iAdm < iReject && iReject < iAaRead && iAaRead < iPre && iPre < iForward, 'admission → rejection → card use → fee precheck → forward')
	const fwd = route.slice(iForward, iForward + 1500)
	assert.ok(fwd.includes('merchantCardAddress: chargeAdmission.cardAddress,'), 'forward uses the verified card')
	assert.equal(fwd.includes('merchantCardAddress: body.merchantCardAddress,'), false, 'forward never uses the raw body value')
	assert.ok(route.slice(iAdm, iForward).includes('res.status(chargeAdmission.status)'), 'a rejection returns the admission status')
})

test('Cluster precheck function no longer derives the fee card from items', () => {
	const fn = slice(MC, 'export const OpenContainerRelayPreCheckBUnitFee = async (', '\n}\n')
	assert.equal(fn.includes('resolveChargeFeePayerCardFromOpenContainerItems'), false)
	assert.ok(fn.includes('verifyChargeFeePayer('))
})
