/**
 * 将卡登记 `metadata.tiers[]` 中的行与链上 `tiers(tierIndex)` 对齐。
 * 多个档可能在 JSON 里写了相同 minUsdc6，仅用 min 匹配会误选（如选到 Silver 而非真实档 2）；
 * 应用链上槽位 `index`、`tiers(i).attr` 与 NFT `attribute` 消歧。
 */
export type CardTierMetadataRow = {
	index?: number
	/** 卡登记 JSON / DB：字符串或大整数，与链上 tiers(i).minUsdc6 同精度 */
	minUsdc6?: string | number | null
	attr?: number
	name?: string
	description?: string
	image?: string
	backgroundColor?: string
}

function rowMatchesChainMin(row: CardTierMetadataRow, chainMinStr: string): boolean {
	if (row.minUsdc6 == null) return false
	const s = String(row.minUsdc6).trim()
	try {
		return BigInt(s === '' ? '0' : s) === BigInt(chainMinStr)
	} catch {
		return false
	}
}

function disambiguateTierRows(
	pool: CardTierMetadataRow[],
	tierIndexChain: number,
	primaryNftAttribute: string | null | undefined,
	chainAttrBn: bigint
): CardTierMetadataRow | null {
	if (pool.length === 0) return null
	if (pool.length === 1) return pool[0]!
	const byIdx = pool.find((r) => r.index === tierIndexChain)
	if (byIdx) return byIdx
	const attrStr = primaryNftAttribute?.trim() ?? ''
	if (attrStr !== '') {
		const n = Number.parseInt(attrStr, 10)
		if (Number.isFinite(n)) {
			const byNftAttr = pool.find((r) => r.attr === n)
			if (byNftAttr) return byNftAttr
		}
	}
	try {
		const byChainAttr = pool.find((r) => r.attr != null && BigInt(r.attr) === chainAttrBn)
		if (byChainAttr) return byChainAttr
	} catch {
		/* ignore */
	}
	return pool[0]!
}

/**
 * 在已知链上 `tiers(tierIndex)` 的 minUsdc6、attr 时，选取 metadata 行。
 * 若 minUsdc6 无匹配，回退：`metadata.index === tierIndex` → NFT attribute vs `metadata.attr` → 数组下标。
 */
export function pickTierMetadataRowForChainSlot(
	tiersRaw: CardTierMetadataRow[],
	tierIndexChain: number,
	chainMinStr: string,
	chainAttrBn: bigint,
	primaryNftAttribute?: string | null
): CardTierMetadataRow | null {
	if (!Array.isArray(tiersRaw) || tiersRaw.length === 0) return null

	const candidates = tiersRaw.filter((row) => rowMatchesChainMin(row, chainMinStr))
	const fromMin = disambiguateTierRows(candidates, tierIndexChain, primaryNftAttribute, chainAttrBn)
	if (fromMin) return fromMin

	const byExplicitIndex = tiersRaw.find((r) => r.index === tierIndexChain)
	if (byExplicitIndex) return byExplicitIndex

	const attrStr = primaryNftAttribute?.trim() ?? ''
	if (attrStr !== '') {
		const n = Number.parseInt(attrStr, 10)
		if (Number.isFinite(n)) {
			const byAttr = tiersRaw.find((r) => r.attr === n)
			if (byAttr) return byAttr
		}
	}

	return tiersRaw[tierIndexChain] ?? null
}
