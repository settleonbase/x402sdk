import { ethers } from 'ethers'
import { CONET_RPC_URL, CONET_USDC, USDC_BASE } from './chainAddresses'

const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://base-rpc.conet.network'

export type UsdcChain = 'base' | 'conet'

export type UsdcPaymentRef = {
	paymentRef: string
	chain: UsdcChain
	token: string
	payer: string
	recipient: string
	amount6: string
	authorizationNonce?: string | null
	signatureHash?: string | null
	requestHash?: string | null
}

export type ConfirmedUsdcTransfer = {
	chain: UsdcChain
	token: string
	txHash: string
	blockNumber: number
	from: string
	to: string
	amount6: string
}

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)')

function normalizeHash(value: string): string {
	if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('Invalid transaction hash')
	return value.toLowerCase()
}

function normalizeAddress(value: string): string {
	return ethers.getAddress(value).toLowerCase()
}

export function usdcTokenForChain(chain: UsdcChain): string {
	return ethers.getAddress(chain === 'base' ? USDC_BASE : CONET_USDC)
}

export function providerForUsdcChain(chain: UsdcChain): ethers.JsonRpcProvider {
	return new ethers.JsonRpcProvider(chain === 'base' ? BASE_RPC_URL : CONET_RPC_URL)
}

export function buildUsdcPaymentRef(params: {
	chain: UsdcChain
	token?: string
	payer: string
	recipient: string
	amount6: string | bigint
	authorizationNonce?: string | null
	signature?: string | null
	requestHash?: string | null
}): UsdcPaymentRef {
	const token = ethers.getAddress(params.token ?? usdcTokenForChain(params.chain))
	const payer = normalizeAddress(params.payer)
	const recipient = normalizeAddress(params.recipient)
	const amount6 = BigInt(params.amount6).toString()
	const authorizationNonce = params.authorizationNonce
		? normalizeHash(params.authorizationNonce)
		: null
	const signatureHash = params.signature
		? ethers.keccak256(params.signature as `0x${string}`)
		: null
	const requestHash = params.requestHash?.trim() || null
	const identity = [
		params.chain,
		token.toLowerCase(),
		payer,
		recipient,
		amount6,
		authorizationNonce ?? '',
		signatureHash ?? '',
		requestHash ?? '',
	].join('|')
	return {
		paymentRef: ethers.keccak256(ethers.toUtf8Bytes(`beamio-usdc-payment:v1|${identity}`)),
		chain: params.chain,
		token,
		payer,
		recipient,
		amount6,
		authorizationNonce,
		signatureHash,
		requestHash,
	}
}

/**
 * Confirms the actual ERC-20 transfer. A successful relay response or tx hash
 * alone is not sufficient to mint credits or fulfill a gift.
 */
export async function confirmUsdcTransfer(params: {
	chain: UsdcChain
	txHash: string
	expectedToken?: string
	expectedFrom: string
	expectedTo: string
	expectedAmount6: string | bigint
}): Promise<ConfirmedUsdcTransfer> {
	const txHash = normalizeHash(params.txHash)
	const provider = providerForUsdcChain(params.chain)
	const receipt = await provider.waitForTransaction(txHash, 1, 60_000)
	if (!receipt || receipt.status !== 1) throw new Error(`USDC transaction is not confirmed: ${txHash}`)
	const token = normalizeAddress(params.expectedToken ?? usdcTokenForChain(params.chain))
	const expectedFrom = normalizeAddress(params.expectedFrom)
	const expectedTo = normalizeAddress(params.expectedTo)
	const expectedAmount = BigInt(params.expectedAmount6).toString()
	let matched: ConfirmedUsdcTransfer | undefined
	for (const log of receipt.logs) {
		if (log.address.toLowerCase() !== token || log.topics[0] !== TRANSFER_TOPIC) continue
		if (log.topics.length < 3 || !log.topics[1] || !log.topics[2]) continue
		const from = normalizeAddress(ethers.dataSlice(log.topics[1], 12))
		const to = normalizeAddress(ethers.dataSlice(log.topics[2], 12))
		const amount = BigInt(log.data).toString()
		if (from === expectedFrom && to === expectedTo && amount === expectedAmount) {
			matched = {
				chain: params.chain,
				token: ethers.getAddress(token),
				txHash,
				blockNumber: receipt.blockNumber,
				from: ethers.getAddress(from),
				to: ethers.getAddress(to),
				amount6: amount,
			}
			break
		}
	}
	if (!matched) {
		throw new Error(`Confirmed receipt has no matching USDC Transfer: ${txHash}`)
	}
	return matched
}
