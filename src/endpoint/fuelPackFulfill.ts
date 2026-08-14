/**
 * After Base USDC x402 settle → GENESIS_NODE_BRIDGE_INITIATOR:
 * mint paid B-Units (mintForUsdcPurchase) + optional free bonus + Genesis Ket #0
 * to the merchant beneficiary (not the third-party payer).
 * Idempotent on USDC_tx. Occupies Settle_ConetPool only.
 */
import { ethers } from 'ethers'
import type { Response } from 'express'
import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import Colors from 'colors/safe'
import { logger } from '../logger'
import {
	CONET_BUINT,
	CONET_BUNIT_AIRDROP_ADDRESS,
	CONET_BUSINESS_START_KET,
} from '../chainAddresses'
import {
	ensureSettleContractPoolInitialized,
	hasIdleSettleConet,
	shiftSettleConet,
	unshiftSettleConet,
} from '../settleContractPool'
import { lookupFuelPack, fuelPackFreeBUnits6 } from '../fuelPackCatalog'

ensureSettleContractPoolInitialized()

const BUNIT_AIRDROP_MINT_ABI = [
	'function mintForUsdcPurchase(address to, uint256 usdcAmount, bytes32 baseTxHash) external',
] as const

const BUNIT_REWARD_ABI = ['function mintReward(address to, uint256 amount) external'] as const

const KET_MINT_ABI = [
	'function balanceOf(address account, uint256 id) view returns (uint256)',
	'function mint(address to, uint256 id, uint256 amount, bytes data) external',
] as const

const KET_TOKEN_ID = 0n

export type FuelPackFulfillPayload = {
	beneficiary: string
	payer: string
	USDC_tx: string
	usdcAmount6: string
	packId: string
	mintKet: boolean
	freeBUnits6: string
	res?: Response
}

type FuelPackFulfillRecord = {
	beneficiary: string
	payer: string
	USDC_tx: string
	usdcAmount6: string
	packId: string
	paidMintTxHash: string
	freeMintTxHash: string
	ketMintTxHash: string
	fulfilledAt: string
}

export const fuelPackFulfillPool: FuelPackFulfillPayload[] = []

function resolveFuelPackFulfillFile(): string {
	return (
		process.env.CONET_FUEL_PACK_FULFILL_FILE?.trim() ||
		path.join(homedir(), '.conet-fuel-pack-fulfill.json')
	)
}

function readFuelPackFulfillFile(): Record<string, FuelPackFulfillRecord> {
	const file = resolveFuelPackFulfillFile()
	if (!fs.existsSync(file)) return {}
	try {
		return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, FuelPackFulfillRecord>
	} catch {
		return {}
	}
}

function writeFuelPackFulfillRecord(record: FuelPackFulfillRecord): void {
	const file = resolveFuelPackFulfillFile()
	const all = readFuelPackFulfillFile()
	all[record.USDC_tx.toLowerCase()] = record
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, JSON.stringify(all, null, 2) + '\n', 'utf-8')
}

function lookupFuelPackFulfill(usdcTx: string): FuelPackFulfillRecord | null {
	const key = usdcTx.trim().toLowerCase()
	if (!key) return null
	return readFuelPackFulfillFile()[key] || null
}

export function kickFuelPackFulfillPoolPress(): void {
	void fuelPackFulfillProcess().catch((e: unknown) => {
		const msg = e instanceof Error ? e.message : String(e)
		logger(Colors.red('[fuelPackFulfillProcess] kick error:'), msg)
	})
}

function scheduleFuelPackFulfillPoolPress(): void {
	if (fuelPackFulfillPool.length === 0) return
	if (hasIdleSettleConet()) kickFuelPackFulfillPoolPress()
	else setTimeout(() => kickFuelPackFulfillPoolPress(), 3000)
}

export const fuelPackFulfillProcess = async () => {
	const obj = fuelPackFulfillPool.shift()
	if (!obj) return
	if (!hasIdleSettleConet()) {
		fuelPackFulfillPool.unshift(obj)
		return setTimeout(() => void fuelPackFulfillProcess(), 3000)
	}

	const usdcTx = String(obj.USDC_tx ?? '').trim()
	const SC = shiftSettleConet()
	if (!SC) {
		fuelPackFulfillPool.unshift(obj)
		return setTimeout(() => void fuelPackFulfillProcess(), 3000)
	}

	try {
		if (!/^0x[0-9a-fA-F]{64}$/.test(usdcTx)) {
			throw new Error('Invalid USDC_tx')
		}
		if (!ethers.isAddress(obj.beneficiary)) {
			throw new Error('Invalid beneficiary')
		}
		const usdcAmount6 = BigInt(String(obj.usdcAmount6 ?? '0'))
		if (usdcAmount6 <= 0n) {
			throw new Error('Invalid usdcAmount6')
		}

		const existing = lookupFuelPackFulfill(usdcTx)
		if (existing) {
			logger(
				Colors.cyan(
					`[fuelPackFulfill] idempotent hit USDC_tx=${usdcTx.slice(0, 12)}… paid=${existing.paidMintTxHash.slice(0, 12)}…`,
				),
			)
			if (obj.res && !obj.res.headersSent) {
				obj.res
					.status(200)
					.json({
						success: true,
						idempotent: true,
						beneficiary: existing.beneficiary,
						USDC_tx: existing.USDC_tx,
						paidMintTxHash: existing.paidMintTxHash,
						freeMintTxHash: existing.freeMintTxHash || undefined,
						ketMintTxHash: existing.ketMintTxHash || undefined,
					})
					.end()
			}
			return
		}

		const beneficiary = ethers.getAddress(obj.beneficiary)
		const pack = lookupFuelPack(obj.packId)
		const freeBUnits6 = pack
			? fuelPackFreeBUnits6(pack)
			: BigInt(String(obj.freeBUnits6 ?? '0') || '0')
		const mintKet = pack ? pack.firstTimeOnly === true : obj.mintKet === true

		const airdrop = new ethers.Contract(
			CONET_BUNIT_AIRDROP_ADDRESS,
			BUNIT_AIRDROP_MINT_ABI,
			SC.walletConet,
		)
		const paidTx = await airdrop.mintForUsdcPurchase(beneficiary, usdcAmount6, usdcTx)
		const paidReceipt = await paidTx.wait()
		if (paidReceipt?.status !== 1) {
			throw new Error('mintForUsdcPurchase reverted')
		}
		const paidMintTxHash = paidTx.hash as string

		let freeMintTxHash = ''
		if (freeBUnits6 > 0n) {
			try {
				const bunit = new ethers.Contract(CONET_BUINT, BUNIT_REWARD_ABI, SC.walletConet)
				const freeTx = await bunit.mintReward(beneficiary, freeBUnits6)
				const freeReceipt = await freeTx.wait()
				if (freeReceipt?.status === 1) {
					freeMintTxHash = freeTx.hash as string
				} else {
					logger(Colors.yellow('[fuelPackFulfill] mintReward status!=1; paid mint already confirmed'))
				}
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e)
				logger(Colors.yellow(`[fuelPackFulfill] mintReward skipped: ${msg}`))
			}
		}

		let ketMintTxHash = ''
		if (mintKet && CONET_BUSINESS_START_KET && ethers.isAddress(CONET_BUSINESS_START_KET)) {
			try {
				const ket = new ethers.Contract(CONET_BUSINESS_START_KET, KET_MINT_ABI, SC.walletConet)
				const bal = (await ket.balanceOf(beneficiary, KET_TOKEN_ID)) as bigint
				if (bal >= 1n) {
					logger(
						Colors.cyan(
							`[fuelPackFulfill] skip Ket mint; beneficiary already holds #0 (${beneficiary.slice(0, 10)}…)`,
						),
					)
				} else {
					const ketTx = await ket.mint(beneficiary, KET_TOKEN_ID, 1n, '0x')
					const ketReceipt = await ketTx.wait()
					if (ketReceipt?.status !== 1) {
						throw new Error('BusinessStartKet mint reverted')
					}
					ketMintTxHash = ketTx.hash as string
				}
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e)
				logger(Colors.red(`[fuelPackFulfill] Ket mint failed: ${msg}`))
				throw e
			}
		}

		const record: FuelPackFulfillRecord = {
			beneficiary,
			payer: ethers.isAddress(obj.payer) ? ethers.getAddress(obj.payer) : String(obj.payer ?? ''),
			USDC_tx: usdcTx,
			usdcAmount6: usdcAmount6.toString(),
			packId: String(obj.packId ?? ''),
			paidMintTxHash,
			freeMintTxHash,
			ketMintTxHash,
			fulfilledAt: new Date().toISOString(),
		}
		writeFuelPackFulfillRecord(record)

		logger(
			Colors.green(
				`[fuelPackFulfill] OK USDC_tx=${usdcTx.slice(0, 12)}… beneficiary=${beneficiary.slice(0, 10)}… pack=${record.packId || 'custom'} paid=${paidMintTxHash.slice(0, 12)}… ket=${ketMintTxHash ? ketMintTxHash.slice(0, 12) : 'none'}`,
			),
		)
		if (obj.res && !obj.res.headersSent) {
			obj.res
				.status(200)
				.json({
					success: true,
					beneficiary,
					USDC_tx: usdcTx,
					paidMintTxHash,
					freeMintTxHash: freeMintTxHash || undefined,
					ketMintTxHash: ketMintTxHash || undefined,
					packId: record.packId || undefined,
				})
				.end()
		}
	} catch (e: unknown) {
		const msg = (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? String(e)
		logger(Colors.red('[fuelPackFulfillProcess] failed:'), msg)
		if (obj.res && !obj.res.headersSent) {
			obj.res.status(400).json({ success: false, error: msg }).end()
		}
	} finally {
		unshiftSettleConet(SC)
		scheduleFuelPackFulfillPoolPress()
	}
}
