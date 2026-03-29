/**
 * 将卡登记 `metadata.tiers[]` 中的行与链上 `tierIndexOrMax` 对齐。
 *
 * **优先**用链上槽位 `tierIndex`：`metadata.tiers[].index === tierIndex`，否则数组下标 `tierIndex`（与 registerCard 默认一致）。
 * **仅当**上述无法得到一行时，再回退用 `tiers(tierIndex).minUsdc6` 在 JSON 中筛选并用 `index` / `attr` 消歧。
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

/**
 * @param chainMinStr / chainAttrBn 仅在「按 tierIndex 找不到行」时使用（需与链上 tiers(tierIndex) 一致）。
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
	if (byIndexFirst) return byIndexFirst

	const candidates = tiersRaw.filter((row) => rowMatchesChainMin(row, chainMinStr))
	const fromMin = disambiguateTierRows(candidates, tierIndexChain, primaryNftAttribute, chainAttrBn)
	if (fromMin) return fromMin

	const attrStr = primaryNftAttribute?.trim() ?? ''
	if (attrStr !== '') {
		const n = Number.parseInt(attrStr, 10)
		if (Number.isFinite(n)) {
			const byAttr = tiersRaw.find((r) => r.attr === n)
			if (byAttr) return byAttr
		}
	}

	return null
}
