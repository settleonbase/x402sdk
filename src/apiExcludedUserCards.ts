import { ethers } from 'ethers'

/**
 * Beamio API / 资产扫描 / Discover 共用：须从用户可见结果中排除的 BeamioUserCard 地址。
 * 含已废弃的全局卡（产品层不再使用）：
 * - CashTrees 全局卡 `0xBCcfA50…`（旧 infrastructure card）
 * - CCSA 全局卡 `0x2032A363…`（旧 CCSA 概念）
 *
 * 单一事实来源：Cluster/Master latestCards、getWalletAssets、myCards、SilentPassUI display exclude 须与此对齐。
 */
export const API_EXCLUDED_USER_CARD_ADDRESSES: ReadonlySet<string> = new Set([
	'0xbccfa50d2a5917c7a8662177f5f4b7a175787270',
	'0x2032a363bb2cf331142391fc0dad21d6504922c7',
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
	'0x5c5376edabbf0f0bd52d5f7a93828606a5051694',
	'0xeacd6cb7e9e5b2a2652ad65840997aab37b828e1',
	'0x7334a7c7fe867538018fcc4cea8b266e47600911',
])

/** @deprecated 旧全局 CCSA 卡；API/客户端不得扫描或展示。见 apiExcludedUserCards.ts */
export const DEPRECATED_LEGACY_CCSA_CARD_LOWER = '0x2032a363bb2cf331142391fc0dad21d6504922c7'

/** @deprecated 旧全局卡常量名；新代码请用 isApiExcludedUserCard，勿再引入 infrastructure card 语义。 */
export const DEPRECATED_LEGACY_GLOBAL_USER_CARD_LOWER =
	'0xbccfa50d2a5917c7a8662177f5f4b7a175787270'

export function normalizeUserCardAddressLower(raw: unknown): string | null {
	if (raw == null || typeof raw !== 'string') return null
	const t = raw.trim()
	if (!t || !ethers.isAddress(t)) return null
	return ethers.getAddress(t).toLowerCase()
}

export function isApiExcludedUserCard(raw: unknown): boolean {
	const lower = normalizeUserCardAddressLower(raw)
	return lower != null && API_EXCLUDED_USER_CARD_ADDRESSES.has(lower)
}

export function filterApiExcludedUserCardAddresses(addresses: string[]): string[] {
	const out: string[] = []
	const seen = new Set<string>()
	for (const raw of addresses) {
		const lower = normalizeUserCardAddressLower(raw)
		if (!lower || isApiExcludedUserCard(lower) || seen.has(lower)) continue
		seen.add(lower)
		out.push(ethers.getAddress(raw.trim()))
	}
	return out
}

export function filterApiExcludedCardRows<T extends { cardAddress?: string }>(rows: T[]): T[] {
	return rows.filter((row) => !isApiExcludedUserCard(row.cardAddress))
}
