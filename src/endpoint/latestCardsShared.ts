import { ethers } from 'ethers'
import type { BeamioLatestCardItem } from '../db'

/**
 * latestCards / last-N 发卡列表：Cluster 与 Master 共用排除集（与 SilentPassUI、Alliance USER_CARD_DISPLAY_EXCLUDED 对齐）。
 */
export const LATEST_CARDS_EXCLUDED = new Set([
	'0x02bae511632354584b198951b42ec73bacbc4e98',
	'0xf99018dffdb0c5657c93ca14db2900cebe1168a7',
	'0xa86a8406b06bd6c332b4b380a0eaced822218eff',
	'0xc0f1c74fb95100a97b532be53b266a54f41db615',
	'0xecc5bdff6716847e45363befd3506b1d539c02d5',
	'0x90ae2212ee70aca8671ab7f5238c828d13c6dea7',
	'0x4879171d6c4693eaedcd8f448a785a31b2146e64',
	'0x82b333da5c723da6e98fefecd96cb1ca304c6125',
	'0x9d098fa94d559b8cb223b9760e8bac3d07617c78',
	'0x926deadb97d8badd1221060840b5a1cf46711a86',
	'0x709dae38d65a87289597ee79cb0d5d251a282e59',
	'0x536cab27c6488202fd86bae0581f143c725f5b4d',
	'0xb87058b44c881020fd529e7e34a158f05bc4c28a',
	'0x82cee96db45933fe4b71d36fa8904508f929027c',
	'0xf0ce0ae91f74f67893e00307cabea8c058939f03',
	'0xb7644ddb12656f4854dc746464af47d33c206f0e',
	'0x0fb5032915c5473b6ef40d878c3c701641f90ec8',
	'0x407e9974a927af2860780645997778be7b0e8e23',
	'0xea7b248cfcd457c4884371c55ae5afb0f428c483',
	'0xe1666f0309529df18e7986064a337c981baea178',
	'0x4cc2e5a596791cb71e34d7b3177e60f6ab3f73ed',
	'0xcdab59228695bbf2137d56382395f854267194e1',
	'0x3957724e39e3db4f9f5fb263dd18e73fe8a67581',
	'0x4cb611a14b1441d36183f125503f2c72af5b8fc8',
	'0xda36bd32418cac424dbffd07617094d1884e629c',
	'0x63a6251a51939f6c47ba0ceff5984e5c9f031605',
	'0x48952f9ea1231b59e5c5fa1a99bc657b122cfdfd',
	'0xb8a42181adc9bb81b6ccc1f2198be95105cfd969',
	'0x70399f0854f32553d7fe14a43fd6ab925d39c0b4',
	'0xfb4d0546b90a8f353f7c479392a1ba40a1185b9d',
	'0x4c66b36ba059b2f05ef3d5f383c67533f19c6219',
	'0x9cda8477c9f03b8759ac64e21941e578908fd750',
])

/**
 * Discover / `GET /api/latestCards`：遗留商家（`created_at` 早于分界）仅保留该 EOA `card_owner`；分界起新注册不参加过滤。
 * 须与 `src/SilentPassUI/src/pages/Vouchers/Market.tsx` 中 `DISCOVER_*` 常量保持一致。
 */
export const DISCOVER_NEW_MERCHANTS_UNFILTERED_SINCE_MS = Date.parse('2026-05-14T00:00:00.000Z')
const DISCOVER_LEGACY_ALLOWED_CARD_OWNER_LOWER = ethers.getAddress(
	'0xda2c9e028d7df4338763e1e14b081ae7316b803a',
).toLowerCase()

function discoverLatestCardCreatedAtMs(iso: string | null | undefined): number | null {
	if (iso == null || typeof iso !== 'string') return null
	const t = Date.parse(iso.trim())
	return Number.isFinite(t) ? t : null
}

/** Apply after `LATEST_CARDS_EXCLUDED` + enrichment. */
export function filterLatestCardsByDiscoverMerchantPolicy(cards: BeamioLatestCardItem[]): BeamioLatestCardItem[] {
	return cards.filter((c) => {
		const createdMs = discoverLatestCardCreatedAtMs(c.createdAt)
		if (createdMs != null && createdMs >= DISCOVER_NEW_MERCHANTS_UNFILTERED_SINCE_MS) return true
		const owner = (c.cardOwner || '').trim()
		if (!owner || !ethers.isAddress(owner)) return false
		return ethers.getAddress(owner).toLowerCase() === DISCOVER_LEGACY_ALLOWED_CARD_OWNER_LOWER
	})
}
