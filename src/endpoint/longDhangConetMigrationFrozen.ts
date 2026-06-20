/**
 * LongDhang Base → CoNET migration: frozen on-chain snapshot (2026-06-20).
 *
 * Source: Base card 0x30d80cD71Fd1FFD346737b387dA11C7412363EFF
 * - totalSupply(0) = 550_000_000 (550.000000 pts) — matches sum of holders below
 * - getAdminListWithMetadata() sub-admins (owner excluded at migration time)
 *
 * Production migration uses this list directly — no Members directory / log scan at runtime.
 * Override with LONGDHANG_SNAPSHOT_USE_FROZEN=false only for dev replay against live Base.
 */

import { ethers } from 'ethers'
import { BASE_MAINNET_CHAIN_ID, CONET_MAINNET_CHAIN_ID } from '../chainAddresses'
import { resolveBeamioBaseHttpRpcUrl } from '../util'

export const LONGDHANG_OLD_BASE_CARD = '0x30d80cD71Fd1FFD346737b387dA11C7412363EFF'
export const LONGDHANG_OLD_CARD_OWNER = '0xA2d21FBd33F7D754D8d7A53fe2B4e5C39A008a1F'
export const LONGDHANG_OLD_BASE_CARD_DEPLOY_BLOCK = 46_475_352
/** Must match LONGDHANG_MIGRATION_VERSION in longDhangConetMigration.ts */
export const LONGDHANG_MIGRATION_VERSION = 'longdhang-conet-migration-v2-frozen'

/** Base Beamio AA factory observed on LongDhang old card at freeze time. */
export const LONGDHANG_FROZEN_BASE_AA_FACTORY = '0xe58F457Cd5674516400013E8d338054be556A730'

export const LONGDHANG_FROZEN_SNAPSHOT_AS_OF = '2026-06-20T00:00:00.000Z'

/** Base block head when holders / admins were captured. */
export const LONGDHANG_FROZEN_BASE_TO_BLOCK = 47_577_547

export type LongDhangFrozenHolder = {
	eoa: string
	oldBaseAA: string
	balanceE6: string
}

export type LongDhangFrozenTerminal = {
	posEoa: string
	/** Raw metadata JSON from Base getAdminListWithMetadata (normalized at use time). */
	metadataJson: string
	/** adminMintLimit unavailable on this card revision — use totalBalanceE6 fallback at registration. */
	mintLimitE6: string
}

/**
 * Five tokenId=0 holders on Base (all balances on AA; EOA inferred via AA owner()).
 * Total balanceE6 = 550_000_000.
 */
export const LONGDHANG_FROZEN_HOLDERS: readonly LongDhangFrozenHolder[] = [
	{
		eoa: '0x2eEA19340e371CC7cD6E922b10Ed7b2bCEf1eD25',
		oldBaseAA: '0xE65Da1fa74b04cbA3845c13ad51241fFD9bAF4C6',
		balanceE6: '111664200',
	},
	{
		eoa: '0xd504b638e370D2bE07bE3C00484F7b5b4521c83e',
		oldBaseAA: '0x1a8d96CDd805eF6B11A3809533183a899a40aB88',
		balanceE6: '110000000',
	},
	{
		eoa: '0xCd87505CdD18FB542c8d8797369611070E745Ec1',
		oldBaseAA: '0x4125F18296FB23C460FC5123a37d196A7CB9b3eC',
		balanceE6: '110000000',
	},
	{
		eoa: '0xd8a40b5f72991515252442397f08b73E9173E0ED',
		oldBaseAA: '0xA275160581D42F90853F2DaE1D7D151E78dB59a8',
		balanceE6: '110000000',
	},
	{
		eoa: '0xA2d21FBd33F7D754D8d7A53fe2B4e5C39A008a1F',
		oldBaseAA: '0xcAe725d08eD301CDC39Efa02Ab106C4e2d2016eF',
		balanceE6: '108335800',
	},
] as const

/** Sub-admin terminals from Base getAdminListWithMetadata (program-owner row excluded). */
export const LONGDHANG_FROZEN_TERMINALS: readonly LongDhangFrozenTerminal[] = [
	{
		posEoa: '0x7509FcE5091D59077f6FaBABCE0505D125F681b8',
		metadataJson:
			'{"deviceName":"POS LongDhang_POS_1","handle":"@LongDhang_POS_1","linkVariant":"modal","allowedTopupMethods":["cash","bankCard","usdc","cadd","airdrop"],"terminalOnboardingReloadUnlimited":true}',
		mintLimitE6: '550000000',
	},
	{
		posEoa: '0xEb8c507e4C6aaD4d78476745aD09B24e7CE09A55',
		metadataJson:
			'{"deviceName":"POS LongDhang_POS_11","handle":"@LongDhang_POS_11","linkVariant":"modal","allowedTopupMethods":["cash","bankCard","usdc","cadd","airdrop"],"terminalOnboardingReloadUnlimited":true}',
		mintLimitE6: '550000000',
	},
	{
		posEoa: '0x476104Bc120A6A45329dA0F74B921547C29B5807',
		metadataJson:
			'{"deviceName":"POS LongDhang_POS_0001","handle":"@LongDhang_POS_0001","linkVariant":"modal","allowedTopupMethods":["cash","bankCard","usdc","cadd","airdrop"],"terminalOnboardingReloadUnlimited":true}',
		mintLimitE6: '550000000',
	},
] as const

export const LONGDHANG_FROZEN_TOTAL_BALANCE_E6 = LONGDHANG_FROZEN_HOLDERS.reduce(
	(sum, h) => sum + BigInt(h.balanceE6),
	0n
).toString()

export function isLongDhangFrozenSnapshotEnabled(): boolean {
	return String(process.env.LONGDHANG_SNAPSHOT_USE_FROZEN ?? 'true').toLowerCase() !== 'false'
}

export function assertLongDhangFrozenHolderTotals(): void {
	const sum = LONGDHANG_FROZEN_HOLDERS.reduce((acc, h) => acc + BigInt(h.balanceE6), 0n)
	if (sum !== 550_000_000n) {
		throw new Error(`LongDhang frozen holders sum ${sum} != 550000000`)
	}
}

/** Stable payload slice used by stableSnapshotHash in longDhangConetMigration.ts */
export function longDhangFrozenSnapshotStablePayload() {
	assertLongDhangFrozenHolderTotals()
	return {
		version: LONGDHANG_MIGRATION_VERSION,
		oldBaseCard: ethers.getAddress(LONGDHANG_OLD_BASE_CARD),
		oldBaseCardOwner: ethers.getAddress(LONGDHANG_OLD_CARD_OWNER),
		baseChainId: BASE_MAINNET_CHAIN_ID,
		conetChainId: CONET_MAINNET_CHAIN_ID,
		oldBaseAaFactory: ethers.getAddress(LONGDHANG_FROZEN_BASE_AA_FACTORY),
		totalBalanceE6: LONGDHANG_FROZEN_TOTAL_BALANCE_E6,
		holders: [...LONGDHANG_FROZEN_HOLDERS]
			.map((h) => ({
				eoa: ethers.getAddress(h.eoa),
				oldBaseAA: ethers.getAddress(h.oldBaseAA),
				balanceE6: h.balanceE6,
			}))
			.sort((a, b) => a.eoa.localeCompare(b.eoa)),
	}
}

export function longDhangFrozenSnapshotScanMeta() {
	return {
		baseRpcUrl: resolveBeamioBaseHttpRpcUrl(),
		baseFromBlock: LONGDHANG_OLD_BASE_CARD_DEPLOY_BLOCK,
		baseToBlock: LONGDHANG_FROZEN_BASE_TO_BLOCK,
		generatedAt: LONGDHANG_FROZEN_SNAPSHOT_AS_OF,
	}
}
