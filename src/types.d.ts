type IMasterSetup = {
	settle_admin: string
	settle_u1: string
	base_endpoint: string
	base: {
		CDP_API_KEY_ID: string
		CDP_API_KEY_SECRET: string
	}
	settle_contractAdmin: string[]
	event_endpoint: string
	testPri: string
	coinbase: {
		"CDP_API_KEY_ID": string
		"CDP_API_KEY_SECRET":string
	}
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

type x402SettleResponse = {
	network: string
	payer: string
	success: boolean
	transaction: string
}

type x402Response = {
	timestamp: string
	network: string
	payer: string
	success: boolean
	USDC_tx?: string
	SETTLE_tx?: string
}

type payload = {
	
		signature: string
		authorization: {
			from: string
			to: string
			value: string
			validAfter: string
			validBefore: string
			nonce: string
		}

	
}

type x402paymentHeader = {
	x402Version: number
	scheme: 'exact',
	network: string
	payload: payload
}


type facilitatorsPoolType = {
	from: string
	value: string
	validAfter: string
	validBefore: string
	nonce: string
	signature: string
	res: any
	isSettle: boolean
}

type facilitatorsPayLinkPoolType = {
	from: string
	to: string
	value: string
	validAfter: string
	validBefore: string
	nonce: string
	signature: string
	res: any
	linkHash?: string
	note?: string
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

interface nodeInfo {
	region: string
	ip_addr: string
	armoredPublicKey: string
	nftNumber: number
	domain: string
	lastEposh?: number
    owner?: string
}


interface beamioAccount {
	accountName: string
	image: string
	darkTheme: boolean
	isUSDCFaucet: boolean
	isETHFaucet: boolean
	initialLoading: boolean
	firstName: string
	lastName: string
}