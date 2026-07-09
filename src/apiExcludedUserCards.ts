import { ethers } from 'ethers'

/**
 * Beamio API / 资产扫描 / Discover 共用：须从用户可见结果中排除的 BeamioUserCard 地址。
 * 含已废弃的全局卡（产品层不再使用）：
 * - CashTrees 全局卡 `0xBCcfA50…`（旧 infrastructure card）
 * - CCSA 全局卡 `0x2032A363…`（旧 CCSA 概念）
 *
 * 单一事实来源：Cluster/Master latestCards、getWalletAssets、myCards；UI 经 GET /api/excludedUserCards 动态拉取，勿硬编码。
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
	/** LongDhang Base legacy program card — migrated to CoNET 0xc06055AEEd896F832e602a5876D2Dbe1CB365A8A */
	'0x30d80cd71fd1ffd346737b387da11c7412363eff',
	'0x507decd9f1c062ea02ba860e249bcebe1f062da4',
	'0xe8f57dc92ad09c79bede29a2803af9c5b3de6fe1',
	'0xef1140cf1376bd66b9367838f419a52d9c062309',
	'0x86398fcfbf51ed5fcca144ffe2155dac6724587d',
	'0xcfcc6ce088d5d1b0cda726fb2b401b55bd59125c',
	'0x15690c6898cf01d7a066e820ba9b6947b87adaf3',
	'0xae5a268e31beee7d44efb39617107838bac8d395',
	/** LongDhang CoNET migration test / duplicate merchant cards — hide from assets & Discover */
	'0xed8266dcfac4517d939994204ddfe00e9e46d557',
	'0xa97a3e1ec8bc7ac273a263a3da3dc38d52cdef5a',
	'0x79bcd7d25508df3d11944f110d645a140fc214d2',
	'0xbd951e8164907c1eebe2182c94dfaa9d33e5e149',
	'0x2d3e9a6605ee6bb0b922bc54c27c01dd956e3b7d',
	'0xbbc7d15988e2bf73ca5299e040091543b5eec54a',
	/** Merchant program cards — operator blacklist */
	'0x48b0e8c3cdc0cf80b6239283cff3d1de16501f3b',
	'0x52af5f5e7c136cc1bd596d64cb44eb7f5c9d2d6c',
	/** Silent Pass CoNET program card — operator blacklist (top-up BM_CallFailed / hide from Discover & assets) */
	'0x703ca8bad6a1266afc077a5b9f3de0461f5560ff',
	/** @deprecated Base-era global default merchant card (CoNET-only migration; bytecode on Base only) */
	'0xa756f2e27a332d6be2d399da543e3ce4c8455f14',
	/** CoNET factory default card — hidden; client-visible merchants are explicit program cards only */
	'0xa5c727d11d04bebc095bd814c6530c4e77fd6662',
	/** Base-legacy beamio_cards (CoNET migration — no CoNET bytecode). Sync: scripts/syncBeamioCardsToApiExcludeBlacklist.mjs */
	'0x01eb483248f68a41c3b2178af0f3a55497743a5b',
	'0x04300e4f1753fca3c66dc64d9778c81da6d6ffd7',
	'0x043cd44e9876ab77da580d204b96b6eb7958ba0c',
	'0x044135ab15f53ee8637e801fbccfebe7f1935076',
	'0x0722a93120d23ccb7f8e79cf65a3316502d54125',
	'0x0d468febf7dfcb7402ee70cbe69ca537b4697801',
	'0x0de9cc2b9a3d0252fdaa5c7de6b9c884045050ba',
	'0x11741f8dda532249d47e953a20bd02121cba62d2',
	'0x11e27ff064cb3d5eb36b28e139322b27bdae1760',
	'0x168947275f15adc722ce7078513b6d54244e6e19',
	'0x1829fa7dfe1a4afbea40978eb57dbb7d6237381d',
	'0x1f3d92f2ec922e215776874c0f0676b205e436ae',
	'0x2634ef3a121bfe1beecfb16e439f648dad8805ba',
	'0x2dda7bdb7ed74ae35fe333f44b3ee1357fb029a2',
	'0x2fbaf8a1e282488dc5e487ac2c736cd46a6ee5b4',
	'0x3068730f8c1bdb86aab8e81d01fbadbbfca4738a',
	'0x3078e28b556b9ca3a1cb37e1659773944a37a0da',
	'0x389dc4551f36be7b2f1096ebe9a61101956ab8aa',
	'0x3b33f5a7430631da975efb08b8c96605169e9325',
	'0x3e51fd2661c8d169fe2f24a2c8e3feb5c533392f',
	'0x3ff189c20b3821363e65bf79ee2117f9c8a486ee',
	'0x4210e2954653b83f159eb089825c545f9dbcbf16',
	'0x4504c5f3d02ba762be8e10419ad44ea0c069fdbf',
	'0x4bfe8a61ddaccab8d61534f4d755c90bae692825',
	'0x523b7c9252218d2973106e98ced49f3ac1e0fdf7',
	'0x56ed7e93632309552e1f6aca3b3ec616078ed66f',
	'0x57ec121b288f6c434376ffc9253d0624d8ea57e6',
	'0x5be125a007eda134c24d17d2bbb3f92ad6dfa596',
	'0x64d7f67f9412b02e334c7edfb28d943923e51863',
	'0x66b57dc57f71c9e9baaee7059a930dcaeca6f00b',
	'0x66be7ec7111145becdfc2b5aa63143d6be1e3dd4',
	'0x68522629d1d59cb1bef8db38bcf790948cd3fec8',
	'0x6f6a6b0808c3e2530f37b3f459a7a64c833a54f2',
	'0x7110f0436f7f0d67ae808a71597adca2505cfa6b',
	'0x719c3728a92e4de23d2084c2ebfe4ca4a357a702',
	'0x737e94e03585b17618d3873270b1d3bfe55ce20a',
	'0x74f35741ad8bc75d873a8d7d140ae5ffb529ac0f',
	'0x7a0f3af1a0a32068c8ae494ea9adfbdae15e79c2',
	'0x7cd467e658205b3875f6b65e68bea9d54f30c0db',
	'0x82dd923bb70136e1ada3610ad5759e2af03b1f2b',
	'0x94caf8d998e8bfe5a3af8bb81391438718718e22',
	'0x97a1453254a7d0b4bfa5f9b402047ce49deed9c9',
	'0x99b407eb62f7810d7872c03db2de90ecbf548872',
	'0x9e5bb4a9c2207aafdfaad94966acde91f8fa02c1',
	'0xa022aefa7fd8282a316e566064b843415b2d0943',
	'0xa0943da06f5170241229a2c8b5f3ec9e0f8ede7d',
	'0xa6d5140c61db45726d65061b89236fb17e969aa3',
	'0xa929035b7c1abce92b4df4f571cdd8b44a725663',
	'0xb952a4c273b199e96c5358ca90b2ba7e30c7ead7',
	'0xbb4030d652c086875fad0978cc8c4a89bfd10a92',
	'0xbe8cdf345c54313f0027b0d0a81d6ba45fe9f23c',
	'0xc754bdf90311693991359e7c03dcbdb168fd3082',
	'0xc91247a8c481f46b6d8f6d59b69ad2cf22fd6023',
	'0xcb68793468c64bd269ee4ae4cec352307b8df222',
	'0xcdd07c64a8475c5d09d07bdbf11201ed63b39095',
	'0xcf6c3411820e15243cc61147956cbb48139a3543',
	'0xd1833d6937b5b4aa83a13d1e8251a8858263e910',
	'0xd4b5da83c997aadb8eb63aa2e81ce0539db9f6da',
	'0xd5b5e2995b0529c2b70350ce1f4fa6dd241febf3',
	'0xd6cb9fb8c37fb72063b385b0e89d9b9860e2756d',
	'0xd7b919302e26aefe59c584fd3b7a28b41585f4d0',
	'0xe8d4caae6cc972ef199085d6c101c041a4c71d60',
	'0xe8e146e7752906db36c2aaa5bf699284ee3582b4',
	'0xeb32fe9295b8650080d8683b39290c893e7b1f64',
	'0xf221b366d53eabc49a24917dad81ad9737e354bd',
	'0xf72360847f269e6d9ea5127596e79e8f800c79a6',
	'0xfb0281cf1b665a0356c42699bb42a14c17f633a9',
	'0xff63359112c1429ee1a24c1f759db5332e0b675f',
	/** END Base-legacy beamio_cards auto-sync */
])

/** Merchant-initiated / DB-backed excludes (merged with static set at runtime). */
const DYNAMIC_API_EXCLUDED_USER_CARD_ADDRESSES: Set<string> = new Set()

export function registerDynamicApiExcludedUserCard(raw: unknown): boolean {
	const lower = normalizeUserCardAddressLower(raw)
	if (!lower) return false
	DYNAMIC_API_EXCLUDED_USER_CARD_ADDRESSES.add(lower)
	return true
}

export function setDynamicApiExcludedUserCards(lowers: Iterable<string>): void {
	DYNAMIC_API_EXCLUDED_USER_CARD_ADDRESSES.clear()
	for (const raw of lowers) {
		const lower = normalizeUserCardAddressLower(raw)
		if (lower) DYNAMIC_API_EXCLUDED_USER_CARD_ADDRESSES.add(lower)
	}
}

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
	if (lower == null) return false
	return API_EXCLUDED_USER_CARD_ADDRESSES.has(lower) || DYNAMIC_API_EXCLUDED_USER_CARD_ADDRESSES.has(lower)
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

/** Cluster `GET /api/excludedUserCards` — UI 动态拉取，勿在客户端硬编码维护。 */
export function listApiExcludedUserCardAddressesChecksum(): string[] {
	const merged = new Set<string>([...API_EXCLUDED_USER_CARD_ADDRESSES, ...DYNAMIC_API_EXCLUDED_USER_CARD_ADDRESSES])
	return [...merged].map((lower) => ethers.getAddress(lower))
}
