/**
 * Discover public lists omit a merchant card while its recorded owner is still
 * an agent temp EOA that has not been handed to a merchant.
 *
 * Chain read (CoNET BeamioAgentReferrerRegistry):
 *   agentOfTemp(owner) != 0 && tempHandedOff(owner) == false
 *
 * A failed registry read is untrusted: those owners stay in the list.
 * Handoff (`tempHandedOff`) or an owner that is not a registered temp makes the card eligible again.
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
 * Owners confirmed still sitting on an agent temp that has not been handed off.
 * `null` means the registry read failed; callers must not treat that as "hide everyone".
 */
export async function unhandedAgentTempOwners(owners: string[]): Promise<Set<string> | null> {
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
	if (unique.length === 0) return new Set()

	try {
		const provider = providerForUserCardChain('conet')
		const multicall = new ethers.Contract(CONET_MULTICALL3, MULTICALL_IFACE, provider)
		const hidden = new Set<string>()
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
				const agent = decodeAddress(raw[i * 2].success, raw[i * 2].returnData)
				const handedOff = decodeBool(raw[i * 2 + 1].success, raw[i * 2 + 1].returnData)
				if (!agent || agent === ethers.ZeroAddress || handedOff !== false) continue
				hidden.add(slice[i].toLowerCase())
			}
		}
		return hidden
	} catch {
		return null
	}
}

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
