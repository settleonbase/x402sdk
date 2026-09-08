import { ethers } from 'ethers'
import BeamioUserCardArtifact from './ABI/BeamioUserCardArtifact.json'
import BeamioUserCardBeaconProxyArtifact from './ABI/BeamioUserCardBeaconProxyArtifact.json'
import { resolveConetUserCardBeaconAddress } from './chainAddresses'

export type BeamioUserCardInitializeParams = {
	uri: string
	currencyEnum: number
	pointsUnitPriceInCurrencyE6: bigint
	initialOwner: string
	gateway: string
	initialTierConfig: {
		/** Canonical semantic name; the ABI wire field remains qualificationMode for V20 compatibility. */
		tierQualificationMode?: number
		qualificationMode?: number
		tiers: Array<{ minUsdc6: bigint; attr: bigint; tierExpirySeconds: bigint; upgradeByBalance: boolean }>
		membershipFeeE6: bigint[]
		membershipDurationKind: number[]
	}
}

function userCardInterface(): ethers.Interface {
	const abi = (BeamioUserCardArtifact as { abi?: ethers.InterfaceAbi }).abi
	if (!Array.isArray(abi)) throw new Error('BeamioUserCard artifact missing abi')
	const iface = new ethers.Interface(abi)
	try {
		iface.getFunction('initialize')
	} catch {
		throw new Error(
			'BeamioUserCard artifact is missing initialize(); run npm run compile && node scripts/syncBeamioUserCardToX402sdk.mjs'
		)
	}
	return iface
}

/** Beacon proxy constructor data atomically initializes the card and all tier state. */
export function encodeBeamioUserCardInitializeCalldata(params: BeamioUserCardInitializeParams): string {
	const tierConfig = ethers.AbiCoder.defaultAbiCoder().encode(
		[
			'tuple(uint8 qualificationMode,tuple(uint256 minUsdc6,uint256 attr,uint256 tierExpirySeconds,bool upgradeByBalance)[] tiers,uint256[] membershipFeeE6,uint8[] membershipDurationKind)',
		],
		[params.initialTierConfig],
	)
	return userCardInterface().encodeFunctionData('initialize', [
		params.uri,
		params.currencyEnum,
		params.pointsUnitPriceInCurrencyE6,
		params.initialOwner,
		params.gateway,
		tierConfig,
	])
}

/**
 * Factory CREATE initCode for a BeaconProxy card (address-stable).
 * Used only when `CONET_USER_CARD_BEACON` is a non-zero address (P2).
 */
export async function buildBeamioUserCardBeaconProxyInitCode(
	params: BeamioUserCardInitializeParams,
	beaconAddress?: string
): Promise<string> {
	const resolved = beaconAddress?.trim()
		? ethers.getAddress(beaconAddress)
		: resolveConetUserCardBeaconAddress()
	if (!resolved) {
		throw new Error(
			'CONET_USER_CARD_BEACON is not configured. After P2 deploy set the beacon address; until then createCard uses CREATE initCode.'
		)
	}

	const artifact = BeamioUserCardBeaconProxyArtifact as {
		abi: ethers.InterfaceAbi
		bytecode: string
		linkReferences?: Record<string, unknown>
	}
	if (!artifact?.bytecode) {
		throw new Error(
			'BeamioUserCardBeaconProxy artifact missing bytecode; run npm run compile && node scripts/syncBeamioUserCardToX402sdk.mjs'
		)
	}
	if (artifact.linkReferences && Object.keys(artifact.linkReferences).length > 0) {
		throw new Error('BeamioUserCardBeaconProxy artifact unexpectedly has linkReferences')
	}

	const data = encodeBeamioUserCardInitializeCalldata(params)
	const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode)
	const deployTx = await factory.getDeployTransaction(resolved, data)
	const initCode = deployTx?.data
	if (!initCode) throw new Error('Failed to build BeamioUserCardBeaconProxy initCode')
	return initCode
}
