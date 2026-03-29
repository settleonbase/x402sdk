/**
 * 将卡登记 `metadata.tiers[]` 中的行与链上 `tierIndexOrMax` / NFT `attribute` 对齐。
 *
 * 1. **按槽位** `tierIndex`（`index === tier` 或数组下标）命中一行后，若该行有 `attr` 且与 NFT `attribute` 不一致，**弃用**（常见：登记里 index 与链上 tiers(i) 错位）。
 * 2. 若 NFT `attribute` 在 JSON 中**唯一**命中一行 `tiers[].attr`，用该行。
 * 3. 再用 `tiers(tierIndex).minUsdc6` 筛选并消歧。
 * 4. 最后任取 `attr` 匹配的第一行。
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

/** 与链上 attributes[tokenId]、登记 tiers[].attr 一致时才接受「按槽位」选中的行。 */
function rowAttrConsistentWithNft(row: CardTierMetadataRow, primaryNftAttribute?: string | null): boolean {
	const attrStr = primaryNftAttribute?.trim() ?? ''
	if (attrStr === '') return true
	const n = Number.parseInt(attrStr, 10)
	if (!Number.isFinite(n)) return true
	if (row.attr == null) return true
	return row.attr === n
}

/** 与 getUIDAssets 旧版 pickCardMetadataTierRow 一致：显式 index 优先，否则用数组下标。 */
function pickTierRowByStrictIndex(tiersRaw: CardTierMetadataRow[], tierIndexChain: number): CardTierMetadataRow | null {
	const byKey = tiersRaw.find((x, i) => (x.index != null ? x.index : i) === tierIndexChain)
	if (byKey) return byKey
	return tiersRaw[tierIndexChain] ?? null
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

function parseNftAttrNum(primaryNftAttribute?: string | null): number | null {
	const attrStr = primaryNftAttribute?.trim() ?? ''
	if (attrStr === '') return null
	const n = Number.parseInt(attrStr, 10)
	return Number.isFinite(n) ? n : null
}

/**
 * @param chainMinStr / chainAttrBn 来自链上 `tiers(tierIndex)`，用于 minUsdc6 回退路径。
 */
export function pickTierMetadataRowForChainSlot(
	tiersRaw: CardTierMetadataRow[],
	tierIndexChain: number,
	chainMinStr: string,
	chainAttrBn: bigint,
	primaryNftAttribute?: string | null
): CardTierMetadataRow | null {
	if (!Array.isArray(tiersRaw) || tiersRaw.length === 0) return null

	const byIndexFirst = pickTierRowByStrictIndex(tiersRaw, tierIndexChain)
	if (byIndexFirst && rowAttrConsistentWithNft(byIndexFirst, primaryNftAttribute)) return byIndexFirst

	const attrNum = parseNftAttrNum(primaryNftAttribute)
	if (attrNum != null) {
		const byAttrUnique = tiersRaw.filter((r) => r.attr === attrNum)
		if (byAttrUnique.length === 1) return byAttrUnique[0]!
	}

	const candidates = tiersRaw.filter((row) => rowMatchesChainMin(row, chainMinStr))
	const fromMin = disambiguateTierRows(candidates, tierIndexChain, primaryNftAttribute, chainAttrBn)
	if (fromMin) return fromMin

	if (attrNum != null) {
		const byAttr = tiersRaw.find((r) => r.attr === attrNum)
		if (byAttr) return byAttr
	}

	return null
}
