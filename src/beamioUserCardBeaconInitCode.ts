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

/** EIP-1167-style proxy constructor `data` = `initialize(uri, currency, priceE6, owner, gateway)`. */
export function encodeBeamioUserCardInitializeCalldata(params: BeamioUserCardInitializeParams): string {
	return userCardInterface().encodeFunctionData('initialize', [
		params.uri,
		params.currencyEnum,
		params.pointsUnitPriceInCurrencyE6,
		params.initialOwner,
		params.gateway,
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
