import type { BeamioUserCardChainKey } from './beamioUserCardChain'

/** Smart Wallet 转账资产（与 SilentPassUI `AaMultisigTransferAssetId` 对齐）。 */
export type AaTransferAssetId =
	| 'cnet'
	| 'usdc'
	| 'gb_paid'
	| 'buint_paid'
	| 'base_eth'
	| 'base_usdc'

export function parseAaTransferAssetId(raw: unknown): AaTransferAssetId | null {
	const s = typeof raw === 'string' ? raw.trim() : ''
	switch (s) {
		case 'cnet':
		case 'usdc':
		case 'gb_paid':
		case 'buint_paid':
		case 'base_eth':
		case 'base_usdc':
			return s
		default:
			return null
	}
}

export function relayChainForTransferAsset(asset: AaTransferAssetId): BeamioUserCardChainKey {
	if (asset === 'base_eth' || asset === 'base_usdc') return 'base'
	return 'conet'
}

export function parseAaUserOpRelayChain(raw: unknown): BeamioUserCardChainKey | null {
	if (raw === 'conet' || raw === 'base') return raw
	return null
}

/** UserOp relay 链：以客户端声明的 transferAsset 为主；relayChain 为显式备选。禁止靠 getCode 猜链。 */
export function resolveAaUserOpRelayChainFromRequest(input: {
	transferAsset?: unknown
	relayChain?: unknown
}):
	| { ok: true; chain: BeamioUserCardChainKey; transferAsset?: AaTransferAssetId }
	| { ok: false; error: string } {
	const asset = parseAaTransferAssetId(input.transferAsset)
	if (asset) {
		return { ok: true, chain: relayChainForTransferAsset(asset), transferAsset: asset }
	}
	const chain = parseAaUserOpRelayChain(input.relayChain)
	if (chain) {
		return { ok: true, chain }
	}
	return {
		ok: false,
		error:
			'transferAsset or relayChain is required for UserOp relay (e.g. transferAsset=cnet or relayChain=base). Server does not infer chain from bytecode.',
	}
}
