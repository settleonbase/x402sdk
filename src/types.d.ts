type IMasterSetup = {
	settle_admin: string
	settle_u1: string
	base_endpoint: string
	base: {
		CDP_API_KEY_ID: string
		CDP_API_KEY_SECRET: string
	}
	settle_contractAdmin: string
}

/**
 *      address from,
		uint256 usdcAmount,
		uint256 validAfter,
		uint256 validBefore,
		bytes32 nonce,
		uint8 v,
		bytes32 r,
		bytes32 s
 */

type IEIP3009depositWithUSDCAuthorization = {
	address: string
	usdcAmount: string
	validAfter: number
	validBefore: number
	nonce: string
	v: number
	r: string
	s: string
}

type airDrop = {
	wallet: string
	settle: string
}

type reflashData = {
	hash: string
	wallet: string
	SETTLE: string
	USDC: string
	timestmp: string
}

type ISettleEvent = {
	from: string
	amount: string
	SETTLTAmount:string
	txHash: string
}

// ============================================
// EIP-712 typedData
// ============================================
type EIP712 = {
	types: string
	primaryType: string
	domain: {
		chainId: number
		name: string
		verifyingContract: string
		version: string
	}
	message: {
		from: string
		to:string
		value: string
		validAfter: number
		validBefore: number
		nonce: string
	}
}


type body402 = {
	EIP712: EIP712
	sig: string
}

type SignatureComponents = {
	v: number
	r: string
	s: string
	recoveredAddress: string
	isValid: boolean
}