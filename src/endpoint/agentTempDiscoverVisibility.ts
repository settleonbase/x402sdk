/**
 * Discover public lists omit a merchant card while its recorded owner is still
 * an agent temp EOA that has not been handed to a merchant.
 *
 * Chain read (CoNET BeamioAgentReferrerRegistry):
 *   agentOfTemp(owner) != 0 && tempHandedOff(owner) == false
 *
 * Two policies share one reader:
 * - omitCardsOwnedByUnhandedAgentTemp (latestCards / couponDiscoverFilter, unchanged): a failed read keeps the owner
 *   visible (fail-open).
 * - omitCardsOwnedByUnhandedAgentTempFailClosed (GET /api/cardsByCategory): an owner whose state cannot be read is
 *   unknown and is not shown, unless this process read the owner as visible within AGENT_TEMP_VISIBLE_VERDICT_TTL_MS.
 *   A failed read never counts as "confirmed shown".
 */
import { ethers } from 'ethers'
import { CONET_AGENT_REFERRER_REGISTRY, CONET_MULTICALL3 } from '../chainAddresses'
import { providerForUserCardChain } from '../beamioUserCardChain'

const REGISTRY_IFACE = new ethers.Interface([
	'function agentOfTemp(address) view returns (address)',
	'function tempHandedOff(address) view returns (bool)',
])

const MULTICALL_IFACE = new ethers.Interface([
	'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[])',
])

const OWNERS_PER_CALL = 80

/** 每个 owner 的链上判定：visible 可展示；hidden 未移交 agent temp；unknown 读取失败或无法解码。 */
export type AgentTempVerdict = 'visible' | 'hidden' | 'unknown'

/** 仅 fail-closed 策略使用：经本进程成功读取为 visible 的 owner 的有效期（毫秒）。 */
export const AGENT_TEMP_VISIBLE_VERDICT_TTL_MS = 10 * 60 * 1000

function decodeAddress(success: boolean, data: string): string | null {
	if (!success) return null
	const hex = String(data ?? '')
	if (!hex.startsWith('0x') || hex.length < 66) return null
	try {
		const decoded = REGISTRY_IFACE.decodeFunctionResult('agentOfTemp', hex)
		const addr = String(decoded[0] ?? '')
		return ethers.isAddress(addr) ? ethers.getAddress(addr) : null
	} catch {
		return null
	}
}

function decodeBool(success: boolean, data: string): boolean | null {
	if (!success) return null
	const hex = String(data ?? '')
	if (!hex.startsWith('0x') || hex.length < 66) return null
	try {
		const decoded = REGISTRY_IFACE.decodeFunctionResult('tempHandedOff', hex)
		return Boolean(decoded[0])
	} catch {
		return null
	}
}

/**
 * 读取一组 owner 的链上判定，键为小写地址。
 * 整批失败（异常、返回长度不符）时返回 `null`；单个 owner 的子调用失败或无法解码时该 owner 为 `unknown`。
 */
async function readAgentTempVerdicts(owners: string[]): Promise<Map<string, AgentTempVerdict> | null> {
	const unique: string[] = []
	const seen = new Set<string>()
	for (const raw of owners) {
		const trimmed = String(raw ?? '').trim()
		if (!trimmed || !ethers.isAddress(trimmed)) continue
		const checksum = ethers.getAddress(trimmed)
		const key = checksum.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		unique.push(checksum)
	}
	const verdicts = new Map<string, AgentTempVerdict>()
	if (unique.length === 0) return verdicts

	try {
		const provider = providerForUserCardChain('conet')
		const multicall = new ethers.Contract(CONET_MULTICALL3, MULTICALL_IFACE, provider)
		for (let offset = 0; offset < unique.length; offset += OWNERS_PER_CALL) {
			const slice = unique.slice(offset, offset + OWNERS_PER_CALL)
			const calls = slice.flatMap((owner) => [
				{
					target: CONET_AGENT_REFERRER_REGISTRY,
					allowFailure: true,
					callData: REGISTRY_IFACE.encodeFunctionData('agentOfTemp', [owner]),
				},
				{
					target: CONET_AGENT_REFERRER_REGISTRY,
					allowFailure: true,
					callData: REGISTRY_IFACE.encodeFunctionData('tempHandedOff', [owner]),
				},
			])
			const raw = (await multicall.aggregate3.staticCall(calls)) as Array<{
				success: boolean
				returnData: string
			}>
			if (!Array.isArray(raw) || raw.length !== calls.length) {
				return null
			}
			for (let i = 0; i < slice.length; i++) {
				const key = slice[i].toLowerCase()
				const agent = decodeAddress(raw[i * 2].success, raw[i * 2].returnData)
				const handedOff = decodeBool(raw[i * 2 + 1].success, raw[i * 2 + 1].returnData)
				if (agent === null) {
					verdicts.set(key, 'unknown')
				} else if (agent === ethers.ZeroAddress) {
					verdicts.set(key, 'visible')
				} else if (handedOff === null) {
					verdicts.set(key, 'unknown')
				} else {
					verdicts.set(key, handedOff ? 'visible' : 'hidden')
				}
			}
		}
		return verdicts
	} catch {
		return null
	}
}

/**
 * Owners confirmed still sitting on an agent temp that has not been handed off (fail-open reading).
 * `null` means the whole read failed; callers must not treat that as "hide everyone".
 */
export async function unhandedAgentTempOwners(owners: string[]): Promise<Set<string> | null> {
	const verdicts = await readAgentTempVerdicts(owners)
	if (!verdicts) return null
	const hidden = new Set<string>()
	for (const [key, verdict] of verdicts) {
		if (verdict === 'hidden') hidden.add(key)
	}
	return hidden
}

/** latestCards / couponDiscoverFilter 使用：读失败或单个 owner 无法判定时保留该卡（fail-open，行为不变）。 */
export async function omitCardsOwnedByUnhandedAgentTemp<T extends { cardOwner?: string | null }>(
	cards: T[],
): Promise<T[]> {
	const hidden = await unhandedAgentTempOwners(cards.map((card) => String(card.cardOwner ?? '')))
	if (!hidden || hidden.size === 0) return cards
	return cards.filter((card) => {
		const owner = String(card.cardOwner ?? '').trim()
		if (!owner || !ethers.isAddress(owner)) return true
		return !hidden.has(ethers.getAddress(owner).toLowerCase())
	})
}

/** 仅 fail-closed 策略的已验证可见缓存：小写 owner → 过期时间（毫秒时间戳）。 */
const verifiedVisibleUntil = new Map<string, number>()

/** 测试与运维诊断用：清空已验证可见缓存。 */
export function clearAgentTempVisibleVerdictCache(): void {
	verifiedVisibleUntil.clear()
}

export type FailClosedOmitOptions = {
	/** 当前时间（毫秒），默认 Date.now；测试注入以验证过期。 */
	now?: () => number
}

/**
 * GET /api/cardsByCategory 使用（fail-closed）。每张卡的判定：
 * - 链上读到 visible：展示，并记录到已验证可见缓存（有效期 AGENT_TEMP_VISIBLE_VERDICT_TTL_MS）；
 * - 链上读到 hidden：不展示，并删除该 owner 的已验证缓存；
 * - unknown（整批读取失败、单个子调用失败、owner 地址无效）：仅当该 owner 在有效期内被本进程读为 visible 时展示，否则不展示。
 * 读取失败本身不构成"已确认可展示"。
 */
export async function omitCardsOwnedByUnhandedAgentTempFailClosed<T extends { cardOwner?: string | null }>(
	cards: T[],
	opts: FailClosedOmitOptions = {},
): Promise<T[]> {
	const now = opts.now ?? Date.now
	const keyOf = (card: T): string | null => {
		const owner = String(card.cardOwner ?? '').trim()
		if (!owner || !ethers.isAddress(owner)) return null
		return ethers.getAddress(owner).toLowerCase()
	}
	const verdicts = await readAgentTempVerdicts(cards.map((card) => String(card.cardOwner ?? '')))
	const at = now()
	const decide = (key: string): boolean => {
		const verdict: AgentTempVerdict = verdicts?.get(key) ?? 'unknown'
		if (verdict === 'visible') {
			verifiedVisibleUntil.set(key, at + AGENT_TEMP_VISIBLE_VERDICT_TTL_MS)
			return true
		}
		if (verdict === 'hidden') {
			verifiedVisibleUntil.delete(key)
			return false
		}
		const until = verifiedVisibleUntil.get(key)
		return until !== undefined && at < until
	}
	return cards.filter((card) => {
		const key = keyOf(card)
		if (!key) return false
		return decide(key)
	})
}
