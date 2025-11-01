type IMasterSetup = {
	settle_admin: string
	settle_u1: string
	base_endpoint: string
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