#!/usr/bin/env node
/**
 * P0 / P4 / P5 role-replacement plan: every contract role held by a leaked key (CoNET and Base).
 * Does NOT hold keys and never broadcasts to a public network.
 *
 *   plan      read chain state, print every step: signer, contract, call, calldata, gas, cost
 *   unsigned  write unsigned txs (nonce, gas, fees filled) for the user's key-rotation session
 *             to sign offline and broadcast right after topping up the leaked keys
 *   fork-run  execute all steps on a LOCAL anvil fork via impersonation (rehearsal only)
 *
 * node dist/p0/p0Plan.js <mode> --cold 0x.. --epoch-new 0x.. --airdrop-new 0x..[,0x..]
 *      [--oracle-owner 0x..] [--settle-new 0x..[,0x..]] [--rpc URL] [--base-rpc URL] [--chain conet|base]
 *      [--through p0|p4|p5] [--out file.json]
 * fork-run needs --chain: it runs that chain's steps against a local anvil fork given by --rpc.
 */
import { writeFileSync } from 'node:fs'
import { Contract, Interface, JsonRpcProvider, formatEther, getAddress, parseUnits, toBeHex } from 'ethers'

export const CONET_CHAIN_ID = 224422
export const BASE_CHAIN_ID = 8453
export const CONTRACTS = {
	chatIndexRegistry: '0x1511Caa71081C84d8a591490D1b83879088EED72',
	gbDepinAirdrop: '0x62bcc59cC36C737E8AfBb0914F840d12cd33025f',
	epochMiningInfo: '0x648f1a17269627C3d465fEa40b3C229f7CacE5cA',
	gbToken: '0xC3EF02DaE632b4C10abB66e07d92a387c10838D8',
	/** Chat public-key directory. Flat adminList, no owner, not upgradeable; deployed by 0x87cA. */
	addressPGP: '0x684b0ac760cEE9c9b85de36d69746420648Cf9e2',
	/** DepinGbSettlement1155, UUPS proxy (upgrade = onlyAdmin); itself a GB admin. */
	depinGbSettlement1155: '0x06cf5bF56DF3E327FB30214E001A67456aaBB287',
	/** DeveloperTokenFxRegistry, UUPS proxy (upgrade = onlyAdmin); itself a GB admin. */
	developerTokenFxRegistry: '0x3B00a3F7341C0449e7a3D6e466f85F6F39dFf6e0',
	/** First GBDepinAirdrop (retired); owner and admins are leaked keys; still a GB admin. */
	gbDepinAirdropOld: '0xBBd504a88dB1EA143A1D3a83E331F979dD3A5e44',
	/** AccountRegistry V1 (Beamio accounts, recovery blobs). Flat admin list like AddressPGP. */
	accountRegistryV1: '0xfFDc8d2021A41F4638Cb3eCf58B5155383EE9f6d',
	/** BeamioOracle (Ownable, single owner; updateRatesBatch = onlyOwner). Same address on Base. */
	beamioOracle: '0x77CB8358c5a37aB7190b0A2C7EaA7fEeDCF11008',
	/** Beamio task indexer diamond: owner sets admins; ANY admin can diamondCut (upgrade). */
	indexerDiamond: '0x6113fE738489c0aB64B4606Ce333aD29b44ED0C4',
	/** BUnitAirdropV2, UUPS proxy (upgrade = onlyOwner; admins set by owner). */
	bunitAirdropV2: '0x305f90A7f38289219BA1b4be98CB5b47e7b15Ac2',
	/** BeamioAgentReferrerRegistry, UUPS proxy (upgrade = onlyAdmin, any admin adds admins). */
	agentReferrer: '0x40f1B57280f9195AfEf2B4433CEc8f79d4b58b9A',
	/** BeamioUserCardFactoryPaymasterV07 on CoNET (single owner, isPaymaster set by owner). */
	cardFactory: '0xfA52a0CcC96C19cF4b6Ea864615F6d52BD0774FB',
	/** BeamioFactoryPaymasterV07 (AA factory, single admin, payMasters; same address on Base). */
	aaFactory: '0x869B31C87ABd9bFB858F5183Ef6021b28ED225E2',
	aaFactoryV2: '0xE9577cFd00A00E97D26854243B6AB4B11D5E907f',
	/** GuardianNodesInfoV6 node table: flat adminList, no events, not upgradeable. */
	guardianNodes: '0xBC6b53065b5647261396d002bDBA0d3396E0722f',
} as const

/** Base contracts holding leaked roles (same addresses as on CoNET, deployed with CREATE2). */
export const BASE_CONTRACTS = {
	gbToken: '0xC3EF02DaE632b4C10abB66e07d92a387c10838D8',
	beamioOracle: '0x77CB8358c5a37aB7190b0A2C7EaA7fEeDCF11008',
	cardFactory: '0xF2864210577359AcaE448D2B116031a0c5EE1016',
	aaFactory: '0x869B31C87ABd9bFB858F5183Ef6021b28ED225E2',
} as const

/** Leaked 2026-10-28 and holding roles on these contracts (public RPC, 2026-11-05). */
export const LEAKED = {
	master: '0x87cAeD4e51C36a2C2ece3Aaf4ddaC9693d2405E1', // settle_contractAdmin[0], GENESIS initiator; owner/admin everywhere
	settle1: '0x678F3570F9173373bB75e7544fcF383153aDAF4C',
	settle2: '0x24103Ea5eA17aBFfDA8b2904acCA679C798b3695',
	settle3: '0x66BAb8A64764e659Fa7FF41D19aDFbb7b956CED2',
	epochManagre: getAddress('0x4a3aad1ddf82aff2b3969d45b157d34c72b2efc8'),
	/**
	 * SI node wallet, a DepinGbSettlement1155 admin. It holds spendable CNET, so it can act
	 * without a top-up: treat as leaked.
	 */
	siNode6bF3: '0x6bF3Aa7261e21Be5Fc781Ac09F9475c8A34AfEea',
} as const

/** The four settle_contractAdmin keys. */
const SETTLE4 = [LEAKED.master, LEAKED.settle1, LEAKED.settle2, LEAKED.settle3] as const

/**
 * AddressPGP admins found on chain (2026-11-05, public RPC): every tx sender of an admin-only event
 * since deployment (block 31806) plus the leaked list, each confirmed with adminList(). All are
 * operator key-file hot wallets swept on 11-04. The contract emits no admin-change event, so an admin
 * that never wrote anything cannot be found this way: `plan` re-checks these, nothing more.
 */
export const PGP_ADMINS = {
	/** settle_contractAdmin keys (deployer + 3). Not used for user registration. Removed in P0. */
	settle: [LEAKED.master, LEAKED.settle1, LEAKED.settle2, LEAKED.settle3],
	/** Registration wallets (addPublicPGPByAdmin) idle since 2026-10-29 or earlier. */
	registrationIdle: [
		'0x2d1D98a96a4C7E1680e43d20F43796264bfdF9E6',
		'0x99BcBb0f4a0BF72c2d8A2E5FDD0ad3B7dAe40302',
		'0xee73178EE888363C84713434D1570749eaeB880d',
		'0x4a0B9B510f0E7395745fdbB8D96b2e2576960b95',
		'0x8AcB8D56f68F28c0Aa5Ab292513f5fAA7ec6126f',
		'0x9D54ccb9C0a7B836aE8de49fAE1573A024a347Ab',
		'0x4a083ae4CdE5C1A621Ef711DF4cc18cad092561d',
	],
	/** Registration wallets the API used last (up to 2026-11-04 11:38 UTC). Removed last. */
	registrationActive: [
		'0xB272bC809dd8A96294f337aDED3f9602cac0E3B0',
		'0x068759bCfd929fb17258aF372c30eE6CD277B872',
		'0x6add8012d4DDb7dA736Ab713FdA13ef3827a05bf',
	],
} as const

const ABI = new Interface([
	'function transferOwnership(address)',
	'function owner() view returns (address)',
	'function addAdmin(address)',
	'function removeAdmin(address)',
	'function removeGbSettler(address)',
	'function admins(address) view returns (bool)',
	'function gbSettlers(address) view returns (bool)',
	'function changeAddressInAdminlist(address,bool)',
	'function adminList(address) view returns (bool)',
	'function isAdmin(address) view returns (bool)',
	'function admin() view returns (address)',
	'function transferOwner(address)',
	'function transferAdmin(address)',
	'function setAdmin(address,bool)',
	'function changePaymasterStatus(address,bool)',
	'function isPaymaster(address) view returns (bool)',
	'function isPayMaster(address) view returns (bool)',
	'function addPayMaster(address)',
	'function removePayMaster(address)',
	'function setPayMaster(address,bool)',
])

export type Step = {
	id: string
	phase: 'P0' | 'P3' | 'P4' | 'P5'
	chainId: number
	signer: string
	signerLabel: string
	contract: string
	contractLabel: string
	call: string
	data: string
	/** Gas limit used in unsigned txs (measured on a fork ×~1.5, rounded up). */
	gasLimit: bigint
	/** Read-only check that tells whether the step is already done. */
	done: (p: JsonRpcProvider) => Promise<boolean>
	note?: string
}

const read = (p: JsonRpcProvider, to: string) => new Contract(to, ABI, p)

/**
 * Steps in broadcast order. P0 is one burst per chain: the leaked keys first hand COLD a seat on
 * every contract (they need a gas top-up right before, and the attacker holds the same keys, so
 * every signed tx goes out at once), then COLD revokes every leaked seat it can. Contracts with a
 * flat admin list (AddressPGP, AccountRegistry V1) keep the registration wallets until P5, so on
 * those COLD is only one admin among many until then.
 */
export function buildSteps(cold: string, epochNew: string, airdropNew: string[], oracleOwner: string = cold, settleNew: string[] = []): Step[] {
	const C = CONTRACTS
	const B = BASE_CONTRACTS
	const L = LEAKED
	const s: Step[] = []
	const add = (x: Omit<Step, 'data' | 'chainId'> & { chainId?: number; fn: string; args: unknown[] }) => {
		const { fn, args, chainId, ...rest } = x
		s.push({ ...rest, chainId: chainId ?? CONET_CHAIN_ID, data: ABI.encodeFunctionData(fn, args) })
	}
	const admins = (to: string) => (p: JsonRpcProvider, a: string) => read(p, to).admins!(a) as Promise<boolean>
	const isOwner = async (p: JsonRpcProvider, to: string, who: string) => getAddress(await read(p, to).owner!()) === getAddress(who)
	const m = `0x87cA (leaked)`

	// ---- P0, CoNET, leaked keys: a COLD seat everywhere. Upgradeable GB admins first.
	add({
		id: 'depin.addAdmin(COLD)', phase: 'P0', signer: L.master, signerLabel: `${m}; 0x6bF3 also works and already has gas`, contract: C.depinGbSettlement1155, contractLabel: 'DepinGbSettlement1155 (UUPS, GB admin)',
		call: `addAdmin(${cold})`, fn: 'addAdmin', args: [cold], gasLimit: 80_000n,
		done: (p) => admins(C.depinGbSettlement1155)(p, cold),
		note: 'any of its 5 admins can upgradeToAndCall today; first in the burst',
	})
	add({
		id: 'fxreg.addAdmin(COLD)', phase: 'P0', signer: L.master, signerLabel: m, contract: C.developerTokenFxRegistry, contractLabel: 'DeveloperTokenFxRegistry (UUPS, GB admin)',
		call: `addAdmin(${cold})`, fn: 'addAdmin', args: [cold], gasLimit: 80_000n,
		done: (p) => admins(C.developerTokenFxRegistry)(p, cold),
	})
	add({
		id: 'gb.addAdmin(COLD)', phase: 'P0', signer: L.master, signerLabel: m, contract: C.gbToken, contractLabel: 'GBToken (UUPS)',
		call: `addAdmin(${cold})`, fn: 'addAdmin', args: [cold], gasLimit: 80_000n,
		done: (p) => admins(C.gbToken)(p, cold),
	})
	add({
		id: 'gba.transferOwnership', phase: 'P0', signer: L.master, signerLabel: `${m} owner`, contract: C.gbDepinAirdrop, contractLabel: 'GBDepinAirdrop',
		call: `transferOwnership(${cold})`, fn: 'transferOwnership', args: [cold], gasLimit: 60_000n,
		done: (p) => isOwner(p, C.gbDepinAirdrop, cold),
		note: 'one-step transfer: check COLD letter by letter before signing',
	})
	add({
		id: 'chat.addAdmin(COLD)', phase: 'P0', signer: L.master, signerLabel: m, contract: C.chatIndexRegistry, contractLabel: 'ChatIndexRegistry',
		call: `addAdmin(${cold})`, fn: 'addAdmin', args: [cold], gasLimit: 80_000n,
		done: (p) => admins(C.chatIndexRegistry)(p, cold),
	})
	add({
		id: 'pgp.add(COLD)', phase: 'P0', signer: L.master, signerLabel: `${m}, deployer`, contract: C.addressPGP, contractLabel: 'AddressPGP',
		call: `changeAddressInAdminlist(${cold}, true)`, fn: 'changeAddressInAdminlist', args: [cold, true], gasLimit: 80_000n,
		done: async (p) => Boolean(await read(p, C.addressPGP).adminList!(cold)),
		note: 'flat admin list: until P5 is done any remaining leaked admin can remove COLD again',
	})
	add({
		id: 'v1.add(COLD)', phase: 'P0', signer: L.master, signerLabel: `${m}, deployer`, contract: C.accountRegistryV1, contractLabel: 'AccountRegistry V1',
		call: `changeAddressInAdminlist(${cold}, true)`, fn: 'changeAddressInAdminlist', args: [cold, true], gasLimit: 80_000n,
		done: async (p) => Boolean(await read(p, C.accountRegistryV1).isAdmin!(cold)),
		note: 'flat admin list, same 14 wallets as AddressPGP: COLD is not in control until P5',
	})
	add({
		id: 'oracle.transferOwnership', phase: 'P0', signer: L.master, signerLabel: `${m} owner`, contract: C.beamioOracle, contractLabel: 'BeamioOracle',
		call: `transferOwnership(${oracleOwner})`, fn: 'transferOwnership', args: [oracleOwner], gasLimit: 60_000n,
		done: (p) => isOwner(p, C.beamioOracle, oracleOwner),
		note: 'one-step; the new owner is the only key that can call updateRatesBatch',
	})
	add({
		id: 'epoch.add(NEW)', phase: 'P0', signer: L.epochManagre, signerLabel: '0x4A3A (leaked epochManagre; 0x87cA works too)', contract: C.epochMiningInfo, contractLabel: 'epoch_mining_info',
		call: `changeAddressInAdminlist(${epochNew}, true)`, fn: 'changeAddressInAdminlist', args: [epochNew, true], gasLimit: 80_000n,
		done: async (p) => Boolean(await read(p, C.epochMiningInfo).adminList!(epochNew)),
		note: 'NEW = wallet-signer epochManagre[0]; the daemon removes the leaked admins itself afterwards (P3)',
	})

	// Second batch (settle-pool contracts): owner / admin seats held by 0x87cA.
	add({
		id: 'diamond.transferOwnership', phase: 'P0', signer: L.master, signerLabel: `${m} owner`, contract: C.indexerDiamond, contractLabel: 'Indexer diamond (any admin can diamondCut)',
		call: `transferOwnership(${cold})`, fn: 'transferOwnership', args: [cold], gasLimit: 60_000n,
		done: (p) => isOwner(p, C.indexerDiamond, cold),
	})
	add({
		id: 'bunit2.transferOwnership', phase: 'P0', signer: L.master, signerLabel: `${m} owner`, contract: C.bunitAirdropV2, contractLabel: 'BUnitAirdropV2 (UUPS, onlyOwner upgrade)',
		call: `transferOwnership(${cold})`, fn: 'transferOwnership', args: [cold], gasLimit: 60_000n,
		done: (p) => isOwner(p, C.bunitAirdropV2, cold),
	})
	add({
		id: 'agentRef.addAdmin(COLD)', phase: 'P0', signer: L.master, signerLabel: m, contract: C.agentReferrer, contractLabel: 'AgentReferrerRegistry (UUPS, onlyAdmin upgrade)',
		call: `addAdmin(${cold})`, fn: 'addAdmin', args: [cold], gasLimit: 80_000n,
		done: (p) => admins(C.agentReferrer)(p, cold),
	})
	add({
		id: 'cardFactory.transferOwner', phase: 'P0', signer: L.master, signerLabel: `${m} owner`, contract: C.cardFactory, contractLabel: 'UserCard factory (CoNET)',
		call: `transferOwner(${cold})`, fn: 'transferOwner', args: [cold], gasLimit: 60_000n,
		done: (p) => isOwner(p, C.cardFactory, cold),
	})
	for (const [idp, to, label] of [['aaFactory', C.aaFactory, 'AA factory (CoNET)'], ['aaFactoryV2', C.aaFactoryV2, 'AA factory V2 (CoNET)']] as const) {
		add({
			id: `${idp}.transferAdmin`, phase: 'P0', signer: L.master, signerLabel: `${m} admin`, contract: to, contractLabel: label,
			call: `transferAdmin(${cold})`, fn: 'transferAdmin', args: [cold], gasLimit: 60_000n,
			done: async (p) => getAddress(await read(p, to).admin!()) === getAddress(cold),
			note: 'payMasters are swapped in P5 (the contract refuses to remove its last payMaster)',
		})
	}
	add({
		id: 'guardian.add(COLD)', phase: 'P0', signer: L.master, signerLabel: m, contract: C.guardianNodes, contractLabel: 'GuardianNodesInfoV6 (node table)',
		call: `changeAddressInAdminlist(${cold}, true)`, fn: 'changeAddressInAdminlist', args: [cold, true], gasLimit: 80_000n,
		done: async (p) => Boolean(await read(p, C.guardianNodes).adminList!(cold)),
		note: 'flat list: all leaked admins are removed in the same burst',
	})

	// ---- P0, CoNET, COLD: revoke every leaked seat it can.
	const revoke = (idp: string, to: string, label: string, list: readonly string[], fn: 'removeAdmin' | 'removeGbSettler', check: (p: JsonRpcProvider, a: string) => Promise<boolean>, chainId?: number) => {
		for (const bad of list) {
			add({
				id: `${idp}.${fn}(${bad.slice(0, 6)})`, phase: 'P0', chainId, signer: cold, signerLabel: 'COLD', contract: to, contractLabel: label,
				call: `${fn}(${bad})`, fn, args: [bad], gasLimit: 60_000n,
				done: async (p) => !(await check(p, bad)),
			})
		}
	}
	revoke('depin', C.depinGbSettlement1155, 'DepinGbSettlement1155', [...SETTLE4, L.siNode6bF3], 'removeAdmin', admins(C.depinGbSettlement1155))
	revoke('fxreg', C.developerTokenFxRegistry, 'DeveloperTokenFxRegistry', SETTLE4, 'removeAdmin', admins(C.developerTokenFxRegistry))
	revoke('gb', C.gbToken, 'GBToken', [L.master, C.gbDepinAirdropOld], 'removeAdmin', admins(C.gbToken))
	// GBDepinAirdrop: owner-gated, so leaked admins cannot fight back. Airdrop is down anyway (no gas),
	// so revoking now loses nothing; P4 only adds the signer's key.
	revoke('gba', C.gbDepinAirdrop, 'GBDepinAirdrop', SETTLE4, 'removeAdmin', admins(C.gbDepinAirdrop))
	revoke('gba', C.gbDepinAirdrop, 'GBDepinAirdrop', SETTLE4, 'removeGbSettler', (p, a) => read(p, C.gbDepinAirdrop).gbSettlers!(a) as Promise<boolean>)
	revoke('chat', C.chatIndexRegistry, 'ChatIndexRegistry', [L.master], 'removeAdmin', admins(C.chatIndexRegistry))
	const allLeakedRegs = [...PGP_ADMINS.registrationIdle, ...PGP_ADMINS.registrationActive]
	const diamondAdmin = (p: JsonRpcProvider, a: string) => read(p, C.indexerDiamond).isAdmin!(a) as Promise<boolean>
	for (const bad of [...SETTLE4, ...allLeakedRegs]) {
		add({
			id: `diamond.setAdmin(${bad.slice(0, 6)},false)`, phase: 'P0', signer: cold, signerLabel: 'COLD', contract: C.indexerDiamond, contractLabel: 'Indexer diamond',
			call: `setAdmin(${bad}, false)`, fn: 'setAdmin', args: [bad, false], gasLimit: 60_000n,
			done: async (p) => !(await diamondAdmin(p, bad)),
		})
	}
	revoke('bunit2', C.bunitAirdropV2, 'BUnitAirdropV2', [...SETTLE4, ...allLeakedRegs], 'removeAdmin', admins(C.bunitAirdropV2))
	revoke('agentRef', C.agentReferrer, 'AgentReferrerRegistry', [L.master], 'removeAdmin', admins(C.agentReferrer))
	const cardPm = (to: string) => (p: JsonRpcProvider, a: string) => read(p, to).isPaymaster!(a) as Promise<boolean>
	const unpay = (idp: string, to: string, label: string, list: readonly string[], chainId?: number) => {
		for (const bad of list) {
			add({
				id: `${idp}.changePaymasterStatus(${bad.slice(0, 6)},false)`, phase: 'P0', chainId, signer: cold, signerLabel: 'COLD', contract: to, contractLabel: label,
				call: `changePaymasterStatus(${bad}, false)`, fn: 'changePaymasterStatus', args: [bad, false], gasLimit: 60_000n,
				done: async (p) => !(await cardPm(to)(p, bad)),
			})
		}
	}
	unpay('cardFactory', C.cardFactory, 'UserCard factory (CoNET)', SETTLE4)
	const guardianAdmin = (p: JsonRpcProvider, a: string) => read(p, C.guardianNodes).adminList!(a) as Promise<boolean>
	for (const bad of [...SETTLE4, ...allLeakedRegs, L.epochManagre]) {
		add({
			id: `guardian.remove(${bad.slice(0, 6)})`, phase: 'P0', signer: cold, signerLabel: 'COLD', contract: C.guardianNodes, contractLabel: 'GuardianNodesInfoV6',
			call: `changeAddressInAdminlist(${bad}, false)`, fn: 'changeAddressInAdminlist', args: [bad, false], gasLimit: 60_000n,
			done: async (p) => !(await guardianAdmin(p, bad)),
			note: bad === '0xee73178EE888363C84713434D1570749eaeB880d' ? 'SI wallet: node-table writes stop until a signer key is granted (P5)' : undefined,
		})
	}
	const flat = (idp: string, to: string, label: string, list: readonly string[], phase: 'P0' | 'P5', viewFn: 'adminList' | 'isAdmin', activeNote?: readonly string[]) => {
		for (const bad of list) {
			const active = activeNote?.includes(bad)
			add({
				id: `${idp}.remove(${bad.slice(0, 6)})`, phase, signer: cold, signerLabel: active ? 'COLD (after the API stops using it)' : 'COLD', contract: to, contractLabel: label,
				call: `changeAddressInAdminlist(${bad}, false)`, fn: 'changeAddressInAdminlist', args: [bad, false], gasLimit: 60_000n,
				done: async (p) => !(await read(p, to)[viewFn]!(bad)),
				note: active ? 'admin registration through this wallet stops' : undefined,
			})
		}
	}
	flat('pgp', C.addressPGP, 'AddressPGP', PGP_ADMINS.settle, 'P0', 'adminList')
	flat('v1', C.accountRegistryV1, 'AccountRegistry V1', PGP_ADMINS.settle, 'P0', 'isAdmin')

	// ---- P0, Base: 0x87cA needs a Base ETH top-up first.
	add({
		id: 'base.gb.addAdmin(COLD)', phase: 'P0', chainId: BASE_CHAIN_ID, signer: L.master, signerLabel: `${m}, Base`, contract: B.gbToken, contractLabel: 'GBToken on Base (UUPS)',
		call: `addAdmin(${cold})`, fn: 'addAdmin', args: [cold], gasLimit: 80_000n,
		done: (p) => admins(B.gbToken)(p, cold),
	})
	add({
		id: 'base.oracle.transferOwnership', phase: 'P0', chainId: BASE_CHAIN_ID, signer: L.master, signerLabel: `${m} owner, Base`, contract: B.beamioOracle, contractLabel: 'BeamioOracle on Base',
		call: `transferOwnership(${oracleOwner})`, fn: 'transferOwnership', args: [oracleOwner], gasLimit: 60_000n,
		done: (p) => isOwner(p, B.beamioOracle, oracleOwner),
	})
	add({
		id: 'base.cardFactory.transferOwner', phase: 'P0', chainId: BASE_CHAIN_ID, signer: L.master, signerLabel: `${m} owner, Base`, contract: B.cardFactory, contractLabel: 'UserCard factory (Base)',
		call: `transferOwner(${cold})`, fn: 'transferOwner', args: [cold], gasLimit: 60_000n,
		done: (p) => isOwner(p, B.cardFactory, cold),
	})
	add({
		id: 'base.aaFactory.transferAdmin', phase: 'P0', chainId: BASE_CHAIN_ID, signer: L.master, signerLabel: `${m} admin, Base`, contract: B.aaFactory, contractLabel: 'AA factory (Base)',
		call: `transferAdmin(${cold})`, fn: 'transferAdmin', args: [cold], gasLimit: 60_000n,
		done: async (p) => getAddress(await read(p, B.aaFactory).admin!()) === getAddress(cold),
	})
	unpay('base.cardFactory', B.cardFactory, 'UserCard factory (Base)', SETTLE4, BASE_CHAIN_ID)
	revoke('base.gb', B.gbToken, 'GBToken on Base', [L.master], 'removeAdmin', admins(B.gbToken), BASE_CHAIN_ID)

	// ---- P3: done by the CoNET-DL daemon through wallet-signer (listed for completeness).
	for (const bad of [L.epochManagre, L.master]) {
		add({
			id: `epoch.remove(${bad.slice(0, 6)})`, phase: 'P3', signer: epochNew, signerLabel: 'NEW epochManagre (daemon, automatic)', contract: C.epochMiningInfo, contractLabel: 'epoch_mining_info',
			call: `changeAddressInAdminlist(${bad}, false)`, fn: 'changeAddressInAdminlist', args: [bad, false], gasLimit: 60_000n,
			done: async (p) => !(await read(p, C.epochMiningInfo).adminList!(bad)),
		})
	}
	// ---- P4: COLD grants the signer's airdrop key (the leaked ones are already gone in P0).
	for (const a of airdropNew) {
		add({
			id: `gba.addAdmin(${a.slice(0, 6)})`, phase: 'P4', signer: cold, signerLabel: 'COLD', contract: C.gbDepinAirdrop, contractLabel: 'GBDepinAirdrop',
			call: `addAdmin(${a})`, fn: 'addAdmin', args: [a], gasLimit: 80_000n,
			done: (p) => admins(C.gbDepinAirdrop)(p, a),
		})
	}
	// ---- P5: registration wallets on the two flat lists, once registration runs on a non-leaked key
	// (signer array or addPublicPGPBySig). Idle ones first, active ones last.
	const regs = [...PGP_ADMINS.registrationIdle, ...PGP_ADMINS.registrationActive]
	flat('pgp', C.addressPGP, 'AddressPGP', regs, 'P5', 'adminList', PGP_ADMINS.registrationActive)
	flat('v1', C.accountRegistryV1, 'AccountRegistry V1', regs, 'P5', 'isAdmin', PGP_ADMINS.registrationActive)
	// ---- P5: the signer's settle_contractAdmin keys (settleNew) get the relayer seats, then the
	// leaked payMasters go (the AA factories keep at least one payMaster at all times).
	for (const n of settleNew) {
		const g = (id: string, to: string, label: string, fn: string, args: unknown[], done: (p: JsonRpcProvider) => Promise<boolean>, chainId?: number) =>
			add({ id: `${id}(${n.slice(0, 6)})`, phase: 'P5', chainId, signer: cold, signerLabel: 'COLD', contract: to, contractLabel: label, call: `${fn}(${args.join(', ')})`, fn, args, gasLimit: 80_000n, done })
		g('diamond.setAdmin', C.indexerDiamond, 'Indexer diamond', 'setAdmin', [n, true], (p) => diamondAdmin(p, n))
		g('bunit2.addAdmin', C.bunitAirdropV2, 'BUnitAirdropV2', 'addAdmin', [n], (p) => admins(C.bunitAirdropV2)(p, n))
		g('guardian.add', C.guardianNodes, 'GuardianNodesInfoV6', 'changeAddressInAdminlist', [n, true], (p) => guardianAdmin(p, n))
		g('cardFactory.pay', C.cardFactory, 'UserCard factory (CoNET)', 'changePaymasterStatus', [n, true], (p) => cardPm(C.cardFactory)(p, n))
		g('base.cardFactory.pay', B.cardFactory, 'UserCard factory (Base)', 'changePaymasterStatus', [n, true], (p) => cardPm(B.cardFactory)(p, n), BASE_CHAIN_ID)
		for (const [id, to, label, chainId] of [['aaFactory.addPayMaster', C.aaFactory, 'AA factory (CoNET)', CONET_CHAIN_ID], ['base.aaFactory.addPayMaster', B.aaFactory, 'AA factory (Base)', BASE_CHAIN_ID]] as const) {
			g(id, to, label, 'addPayMaster', [n], async (p) => Boolean(await read(p, to).isPayMaster!(n)), chainId)
		}
		// BeamioFactoryInstitutionalV2 uses setPayMaster(pm, bool) instead.
		g('aaFactoryV2.setPayMaster', C.aaFactoryV2, 'AA factory V2 (CoNET)', 'setPayMaster', [n, true], async (p) => Boolean(await read(p, C.aaFactoryV2).isPayMaster!(n)))
	}
	if (settleNew.length > 0) {
		for (const bad of SETTLE4) {
			add({
				id: `aaFactoryV2.setPayMaster(${bad.slice(0, 6)},false)`, phase: 'P5', signer: cold, signerLabel: 'COLD', contract: C.aaFactoryV2, contractLabel: 'AA factory V2 (CoNET)',
				call: `setPayMaster(${bad}, false)`, fn: 'setPayMaster', args: [bad, false], gasLimit: 80_000n,
				done: async (p) => !(await read(p, C.aaFactoryV2).isPayMaster!(bad)),
			})
		}
		for (const [idp, to, label, chainId, list] of [['aaFactory', C.aaFactory, 'AA factory (CoNET)', CONET_CHAIN_ID, [...SETTLE4, ...allLeakedRegs]], ['base.aaFactory', B.aaFactory, 'AA factory (Base)', BASE_CHAIN_ID, [...SETTLE4, ...allLeakedRegs]]] as const) {
			for (const bad of list) {
				add({
					id: `${idp}.removePayMaster(${bad.slice(0, 6)})`, phase: 'P5', chainId, signer: cold, signerLabel: 'COLD', contract: to, contractLabel: label,
					call: `removePayMaster(${bad})`, fn: 'removePayMaster', args: [bad], gasLimit: 80_000n,
					done: async (p) => !(await read(p, to).isPayMaster!(bad)),
				})
			}
		}
	}
	return s
}

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(name)
	return i >= 0 ? process.argv[i + 1] : undefined
}

async function isLocalAnvil(p: JsonRpcProvider, url: string): Promise<boolean> {
	const host = new URL(url).hostname
	if (host !== '127.0.0.1' && host !== 'localhost') return false
	const v = String(await p.send('web3_clientVersion', []))
	return v.toLowerCase().includes('anvil')
}

/** Receipt by direct polling: ethers' waitForTransaction can hang after evm_revert (cached block number). */
async function receiptOf(p: JsonRpcProvider, hash: string): Promise<{ status: number; gasUsed: bigint } | null> {
	for (let i = 0; i < 100; i++) {
		const r = (await p.send('eth_getTransactionReceipt', [hash])) as { status: string; gasUsed: string } | null
		if (r) return { status: Number(r.status), gasUsed: BigInt(r.gasUsed) }
		await new Promise((res) => setTimeout(res, 200))
	}
	return null
}

export async function forkRun(p: JsonRpcProvider, steps: Step[], log: (s: string) => void): Promise<Record<string, bigint>> {
	const used: Record<string, bigint> = {}
	for (const st of steps) {
		if (await st.done(p)) {
			log(`skip ${st.id} (already done)`)
			continue
		}
		await p.send('anvil_setBalance', [st.signer, toBeHex(10n ** 18n)])
		await p.send('anvil_impersonateAccount', [st.signer])
		const hash = (await p.send('eth_sendTransaction', [{ from: st.signer, to: st.contract, data: st.data, gas: toBeHex(st.gasLimit) }])) as string
		const r = await receiptOf(p, hash)
		await p.send('anvil_stopImpersonatingAccount', [st.signer])
		if (!r || r.status !== 1) throw new Error(`${st.id} reverted on fork`)
		if (!(await st.done(p))) throw new Error(`${st.id} mined but check still false`)
		used[st.id] = r.gasUsed
		log(`ok   ${st.id} gasUsed=${r.gasUsed}`)
	}
	return used
}

async function main(): Promise<void> {
	const mode = process.argv[2] ?? 'plan'
	const rpc = arg('--rpc') ?? 'https://publicrpc.conet.network'
	const baseRpc = arg('--base-rpc') ?? 'https://mainnet.base.org'
	const cold = getAddress(arg('--cold') ?? '')
	const epochNew = getAddress(arg('--epoch-new') ?? '')
	const airdropNew = (arg('--airdrop-new') ?? '').split(',').filter(Boolean).map((a) => getAddress(a))
	const oracleOwner = getAddress(arg('--oracle-owner') ?? cold)
	const settleNew = (arg('--settle-new') ?? '').split(',').filter(Boolean).map((a) => getAddress(a))
	const through = arg('--through') ?? 'p5'
	const chainArg = arg('--chain')
	const chains = chainArg === undefined ? [CONET_CHAIN_ID, BASE_CHAIN_ID] : chainArg === 'conet' ? [CONET_CHAIN_ID] : chainArg === 'base' ? [BASE_CHAIN_ID] : null
	if (!chains) throw new Error('--chain must be conet or base')
	const providers = new Map<number, JsonRpcProvider>()
	// With --chain base, --rpc points at the Base node (fork-run against a Base anvil fork).
	const urlFor = (c: number) => (c === CONET_CHAIN_ID ? rpc : chainArg === 'base' ? rpc : baseRpc)
	const prov = (c: number) => {
		let p = providers.get(c)
		if (!p) providers.set(c, (p = new JsonRpcProvider(urlFor(c), c, { staticNetwork: true, batchMaxCount: 1 })))
		return p
	}
	const all = buildSteps(cold, epochNew, airdropNew, oracleOwner, settleNew)
	const upTo = { p0: ['P0'], p4: ['P0', 'P3', 'P4'], p5: ['P0', 'P3', 'P4', 'P5'] }[through]
	if (!upTo) throw new Error('--through must be p0, p4 or p5')
	const steps = all.filter((s) => upTo.includes(s.phase) && chains.includes(s.chainId))
	const price = new Map<number, bigint>()
	for (const c of chains) price.set(c, (await prov(c).getFeeData()).gasPrice ?? 0n)

	if (mode === 'plan') {
		const rows = []
		for (const st of steps) {
			const p = prov(st.chainId)
			rows.push({
				phase: st.phase,
				chainId: st.chainId,
				id: st.id,
				done: await st.done(p),
				signer: `${st.signerLabel} ${st.signer}`,
				contract: `${st.contractLabel} ${st.contract}`,
				call: st.call,
				data: st.data,
				gasLimit: st.gasLimit.toString(),
				maxCostAtCurrentPrice: formatEther(st.gasLimit * price.get(st.chainId)!),
				note: st.note,
			})
		}
		const lists: Record<string, Record<string, boolean>> = {}
		if (chains.includes(CONET_CHAIN_ID)) {
			const p = prov(CONET_CHAIN_ID)
			const flatAll = [cold, ...PGP_ADMINS.settle, ...PGP_ADMINS.registrationIdle, ...PGP_ADMINS.registrationActive]
			lists.addressPgp = {}
			lists.accountRegistryV1 = {}
			for (const a of flatAll) {
				lists.addressPgp[a] = Boolean(await read(p, CONTRACTS.addressPGP).adminList!(a))
				lists.accountRegistryV1[a] = Boolean(await read(p, CONTRACTS.accountRegistryV1).isAdmin!(a))
			}
		}
		const out = { rpc, baseRpc: chains.includes(BASE_CHAIN_ID) ? urlFor(BASE_CHAIN_ID) : undefined, gasPriceWei: Object.fromEntries([...price].map(([k, v]) => [k, v.toString()])), cold, oracleOwner, epochNew, airdropNew, steps: rows, flatAdminLists: lists }
		console.log(JSON.stringify(out, null, 2))
		if (arg('--out')) writeFileSync(arg('--out')!, JSON.stringify(out, null, 2))
		return
	}
	if (mode === 'unsigned') {
		// EIP-1559 with a generous tip: leaked-key txs must land in the next block (the attacker
		// can replace a pending tx at the same nonce). Defaults per chain; override with flags.
		const fees: Record<number, { maxFee: bigint; tip: bigint }> = {
			[CONET_CHAIN_ID]: { maxFee: parseUnits(arg('--max-fee-gwei') ?? '5', 'gwei'), tip: parseUnits(arg('--tip-gwei') ?? '2', 'gwei') },
			[BASE_CHAIN_ID]: { maxFee: parseUnits(arg('--base-max-fee-gwei') ?? '0.5', 'gwei'), tip: parseUnits(arg('--base-tip-gwei') ?? '0.1', 'gwei') },
		}
		const nonces = new Map<string, number>()
		const txs = []
		for (const st of steps.filter((x) => x.phase !== 'P3')) {
			const p = prov(st.chainId)
			if (await st.done(p)) continue
			const k = `${st.chainId}:${st.signer}`
			if (!nonces.has(k)) nonces.set(k, await p.getTransactionCount(st.signer, 'pending'))
			const nonce = nonces.get(k)!
			nonces.set(k, nonce + 1)
			const f = fees[st.chainId]!
			txs.push({ id: st.id, phase: st.phase, signer: st.signer, tx: { type: 2, chainId: st.chainId, nonce, to: st.contract, data: st.data, value: '0', gasLimit: st.gasLimit.toString(), maxFeePerGas: f.maxFee.toString(), maxPriorityFeePerGas: f.tip.toString() } })
		}
		const need = new Map<string, bigint>()
		for (const t of txs) {
			const k = `${t.tx.chainId}:${t.signer}`
			need.set(k, (need.get(k) ?? 0n) + BigInt(t.tx.gasLimit) * BigInt(t.tx.maxFeePerGas))
		}
		const topup = Object.fromEntries([...need].map(([k, v]) => [k, formatEther(v)]))
		const out = { note: 'sign with the matching key, broadcast in order; P0 leaked-key txs immediately after the top-up (key = chainId:signer)', topUpNeeded: topup, txs }
		console.log(JSON.stringify(out, null, 2))
		if (arg('--out')) writeFileSync(arg('--out')!, JSON.stringify(out, null, 2))
		return
	}
	if (mode === 'fork-run') {
		if (chains.length !== 1) throw new Error('fork-run needs --chain conet|base')
		const p = prov(chains[0]!)
		if (!(await isLocalAnvil(p, rpc))) throw new Error('fork-run only runs against a local anvil fork')
		const used = await forkRun(p, steps, (s) => console.log(s))
		console.log(JSON.stringify(Object.fromEntries(Object.entries(used).map(([k, v]) => [k, v.toString()])), null, 2))
		return
	}
	throw new Error(`unknown mode ${mode}`)
}

if (require.main === module) {
	main().catch((e: unknown) => {
		console.error(e instanceof Error ? e.message : String(e))
		process.exit(1)
	})
}
