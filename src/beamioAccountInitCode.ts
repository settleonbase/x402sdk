import { ContractFactory, type InterfaceAbi } from 'ethers'
import BeamioAccountArtifact from './ABI/BeamioAccountArtifact.json'

/** ERC-4337 v0.7 EntryPoint on Base / 与 BeamioFactoryPaymasterV07.ENTRY_POINT 一致 */
export const BEAMIO_ACCOUNT_ENTRY_POINT_V07 =
	'0x0000000071727De22E5E9d8BAf0edAc6f37da032' as const

/**
 * 生成 BeamioAccount 的部署 initCode（constructor(EntryPoint) + bytecode），
 * 与链上 BeamioFactoryPaymasterV07._initCode() 使用的编码一致；用于 CREATE2 地址预测、UserOp.initCode 等。
 */
export async function buildBeamioAccountInitCode(
	entryPoint: string = BEAMIO_ACCOUNT_ENTRY_POINT_V07
): Promise<string> {
	if (!entryPoint.startsWith('0x') || entryPoint.length !== 42) {
		throw new Error('buildBeamioAccountInitCode: invalid entryPoint address')
	}
	const art = BeamioAccountArtifact as { abi: InterfaceAbi; bytecode: string }
	if (!art?.bytecode) {
		throw new Error(
			'BeamioAccountArtifact missing bytecode — run BeamioContract: npm run compile && node scripts/syncBeamioAccountToX402sdk.mjs'
		)
	}
	const factory = new ContractFactory(art.abi, art.bytecode)
	const deployTx = await factory.getDeployTransaction(entryPoint)
	const data = deployTx?.data
	if (!data || typeof data !== 'string') {
		throw new Error('Failed to build BeamioAccount initCode')
	}
	return data
}
