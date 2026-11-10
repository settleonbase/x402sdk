import { readFileSync } from 'node:fs'
import { FunctionFragment, Interface, TypedDataEncoder, getAddress, id, isAddress, type TypedDataDomain, type TypedDataField } from 'ethers'
import { canonicalHash } from './canonical'
import { denied } from './errors'

/**
 * Policy file (JSON, root-owned). Shape:
 * { version: 1, clients: { <clientName>: { tokenSha256?, arrays: { <keyArray>: ArrayGrant } } } }
 * A client name is the CN of its mTLS certificate (or the name bound to a unix socket).
 */
export type ArgRule = {
	eq?: string | number | boolean
	/** '@compromised' = leaked-address list; '@registry' = any address the signer derived. */
	in?: '@compromised' | '@registry' | string[]
	/** Inclusive length bounds. Only ABI arrays can satisfy them. */
	minItems?: number
	maxItems?: number
}

export type CallRule = {
	to: string
	/** Human-readable signatures, e.g. "updateInfo(uint256,uint256,uint256)". */
	selectors: string[]
	maxGas?: number
	maxValueWei?: string
	/** Constraints by argument index ("0", "1", ...). */
	args?: Record<string, ArgRule>
	/** These ABI array arguments must decode to the same length. */
	equalArrays?: number[]
}

/**
 * A typed-data grant is closed unless it fixes the domain name, version, and type
 * tree. chainId + verifyingContract + primaryType alone is not an authorization.
 */
export type TypedDataRule = {
	chainId: number
	verifyingContract: string
	primaryType: string
	domainName: string
	domainVersion: string
	types: Record<string, TypedDataField[]>
}

export type ArrayGrant = {
	chains: number[]
	allow: CallRule[]
	typedData?: TypedDataRule[]
	rate?: { perMinute?: number; perDay?: number }
	/** Per chain id; transactions are refused when the network price is higher. */
	maxGasPriceGwei?: Record<string, number>
	/** In-flight transactions per key (default 1). */
	maxInflightPerKey?: number
	/** Per chain id, per key, per UTC day, in wei (gasUsed × price). */
	dailyGasBudgetWei?: Record<string, string>
	/** eth_signTransaction (caller owns the nonce). Off by default. */
	allowSignOnly?: boolean
	/** personal_sign. Off by default. */
	allowPersonalSign?: boolean
}

export type ClientPolicy = { disabled?: boolean; tokenSha256?: string; arrays: Record<string, ArrayGrant> }
export type PolicyFile = { version: 1; clients: Record<string, ClientPolicy> }

type CompiledRule = CallRule & { toLc: string; fragments: Map<string, FunctionFragment> }
type CompiledGrant = ArrayGrant & { compiled: CompiledRule[] }

export type CallCheck = {
	client: string
	array: string
	chainId: number
	to: string
	data: string
	value: bigint
	gasLimit?: bigint
}

export type CallDecision = { grant: ArrayGrant; method: string; args: string[]; maxGas?: number }

export class Policy {
	readonly hash: string
	private grants = new Map<string, Map<string, CompiledGrant>>()

	constructor(readonly file: PolicyFile) {
		if (file.version !== 1 || !file.clients) throw new Error('policy: version 1 with clients required')
		assertKnown('policy', file, ['version', 'clients'])
		for (const [client, cp] of Object.entries(file.clients)) {
			const m = new Map<string, CompiledGrant>()
			assertKnown(`clients.${client}`, cp, ['disabled', 'tokenSha256', 'arrays'])
			for (const [array, g] of Object.entries(cp.arrays ?? {})) {
				assertGrant(client, array, g)
				const compiled = (g.allow ?? []).map((r) => compileRule(client, array, r))
				assertNoOverlap(client, array, compiled)
				m.set(array, { ...g, compiled })
			}
			this.grants.set(client, m)
		}
		this.hash = canonicalHash(file)
	}

	static load(path: string): Policy {
		return new Policy(JSON.parse(readFileSync(path, 'utf8')) as PolicyFile)
	}

	clients(): string[] {
		return Object.keys(this.file.clients)
	}

	client(name: string): ClientPolicy | undefined {
		return this.file.clients[name]
	}

	arraysOf(client: string): string[] {
		return [...(this.grants.get(client)?.keys() ?? [])]
	}

	grant(client: string, array: string, chainId?: number): ArrayGrant {
		const g = this.grants.get(client)?.get(array)
		if (!g) throw denied(`client ${client} has no grant for key array ${array}`)
		if (chainId !== undefined && !g.chains.includes(chainId)) throw denied(`chain ${chainId} not allowed for ${array}`)
		return g
	}

	checkCall(req: CallCheck, lists: { compromised: Set<string>; registry: Set<string> }): CallDecision {
		const g = this.grant(req.client, req.array, req.chainId) as CompiledGrant
		if (!isAddress(req.to)) throw denied('to must be an address (contract creation not allowed)')
		const toLc = req.to.toLowerCase()
		const selector = (req.data ?? '0x').slice(0, 10).toLowerCase()
		if (selector.length !== 10) throw denied('plain transfers are not allowed; calldata required')
		for (const rule of g.compiled) {
			if (rule.toLc !== toLc) continue
			const frag = rule.fragments.get(selector)
			if (!frag) continue
			const maxValue = BigInt(rule.maxValueWei ?? '0')
			if (req.value > maxValue) throw denied(`value above ${maxValue} wei`)
			if (rule.maxGas !== undefined && req.gasLimit !== undefined && req.gasLimit > BigInt(rule.maxGas)) {
				throw denied(`gasLimit above policy max ${rule.maxGas}`)
			}
			let decoded: readonly unknown[]
			try {
				decoded = Interface.from([frag]).decodeFunctionData(frag, req.data)
			} catch {
				throw denied(`calldata does not decode as ${frag.format('sighash')}`)
			}
			for (const [idx, ar] of Object.entries(rule.args ?? {})) {
				checkArg(frag, Number(idx), decoded[Number(idx)], ar, lists)
			}
			if (rule.equalArrays) enforceEqualArrays(frag, decoded, rule.equalArrays)
			return { grant: g, method: frag.format('sighash'), args: decoded.map((v) => summarize(v)), maxGas: rule.maxGas }
		}
		throw denied(`call ${selector} to ${req.to} not in policy for ${req.client}/${req.array}`)
	}

	/**
	 * Authorize EIP-712 only against a compiled schema. `primaryType` must be the
	 * root derived from `types`; a caller-supplied name cannot select a different type.
	 */
	checkTypedData(
		client: string,
		array: string,
		domain: TypedDataDomain,
		types: Record<string, TypedDataField[]>,
		primaryType: string,
		message: Record<string, unknown>,
	): ArrayGrant {
		const chainId = domain.chainId === undefined || domain.chainId === null ? NaN : Number(domain.chainId)
		const g = this.grant(client, array, chainId)
		let derived: string
		try {
			derived = TypedDataEncoder.getPrimaryType(types)
		} catch {
			throw denied('typed data types do not define a single root')
		}
		if (primaryType !== derived) throw denied('primaryType does not match the type definition')
		const vc = typeof domain.verifyingContract === 'string' ? domain.verifyingContract.toLowerCase() : ''
		const rule = (g.typedData ?? []).find(
			(r) => r.chainId === chainId && r.verifyingContract.toLowerCase() === vc && r.primaryType === derived,
		)
		if (!rule) throw denied(`typed data ${derived} for ${vc} on ${chainId} not in policy`)
		if (domain.name !== rule.domainName || domain.version !== rule.domainVersion) {
			throw denied('typed data domain name or version does not match policy')
		}
		if (canonicalTypes(types) !== canonicalTypes(rule.types)) throw denied('typed data types do not match policy')
		const fields = rule.types[rule.primaryType] ?? []
		const names = fields.map((f) => f.name)
		const keys = Object.keys(message)
		if (keys.length !== names.length || names.some((n) => !Object.prototype.hasOwnProperty.call(message, n))) {
			throw denied('typed data message fields do not match the approved type')
		}
		const now = BigInt(Math.floor(Date.now() / 1000))
		for (const field of fields) {
			if (field.type !== 'uint256' || (field.name !== 'deadline' && field.name !== 'validBefore')) continue
			let value: bigint
			try {
				value = BigInt(message[field.name] as string | number | bigint)
			} catch {
				throw denied(`typed data ${field.name} is not an integer`)
			}
			if (value <= now) throw denied(`typed data ${field.name} is expired`)
		}
		return g
	}
}

function assertKnown(path: string, obj: object, allowed: readonly string[]): void {
	for (const key of Object.keys(obj)) {
		if (!allowed.includes(key)) throw new Error(`policy ${path}: unknown field ${key}`)
	}
}

function assertGrant(client: string, array: string, g: ArrayGrant): void {
	const where = `${client}/${array}`
	assertKnown(where, g, [
		'chains',
		'allow',
		'typedData',
		'rate',
		'maxGasPriceGwei',
		'maxInflightPerKey',
		'dailyGasBudgetWei',
		'allowSignOnly',
		'allowPersonalSign',
	])
	if (!Array.isArray(g.chains) || g.chains.length === 0) throw new Error(`policy ${where}: chains required`)
	if (g.rate) assertKnown(`${where}.rate`, g.rate, ['perMinute', 'perDay'])
	for (const rule of g.typedData ?? []) compileTypedDataRule(where, g.chains, rule)
}

function compileTypedDataRule(where: string, chains: number[], rule: TypedDataRule): void {
	assertKnown(`${where}.typedData`, rule, ['chainId', 'verifyingContract', 'primaryType', 'domainName', 'domainVersion', 'types'])
	if (!chains.includes(rule.chainId)) throw new Error(`policy ${where}: typed data chain ${rule.chainId} is not in grant chains`)
	if (!isAddress(rule.verifyingContract)) throw new Error(`policy ${where}: typed data verifyingContract is not an address`)
	if (!rule.domainName || !rule.domainVersion || !rule.types || !rule.primaryType) {
		throw new Error(`policy ${where}: typed data authorization is closed until domainName, domainVersion, and types are fixed`)
	}
	let derived: string
	try {
		derived = TypedDataEncoder.getPrimaryType(rule.types)
	} catch {
		throw new Error(`policy ${where}: typed data types do not define a single root`)
	}
	if (rule.primaryType !== derived) {
		throw new Error(`policy ${where}: typed data primaryType must be the root type ${derived}`)
	}
	for (const [typeName, fields] of Object.entries(rule.types)) {
		if (!Array.isArray(fields) || fields.length === 0) throw new Error(`policy ${where}: typed data type ${typeName} has no fields`)
		for (const field of fields) {
			assertKnown(`${where}.typedData.types.${typeName}`, field, ['name', 'type'])
			if (!field.name || !field.type) throw new Error(`policy ${where}: typed data field is incomplete`)
		}
	}
}

function assertNoOverlap(client: string, array: string, rules: CompiledRule[]): void {
	const seen = new Set<string>()
	for (const rule of rules) {
		for (const [selector, frag] of rule.fragments) {
			const key = `${rule.toLc}:${selector}`
			if (seen.has(key)) {
				throw new Error(`policy ${client}/${array}: overlapping rule for ${rule.to} ${frag.format('sighash')}`)
			}
			seen.add(key)
		}
	}
}

function canonicalTypes(types: Record<string, TypedDataField[]>): string {
	const names = Object.keys(types).sort()
	return JSON.stringify(names.map((name) => [name, types[name]!.map((field) => [field.name, field.type])]))
}

function compileRule(client: string, array: string, r: CallRule): CompiledRule {
	const where = `${client}/${array}`
	assertKnown(`${where}.allow`, r, ['to', 'selectors', 'maxGas', 'maxValueWei', 'args', 'equalArrays'])
	if (!isAddress(r.to)) throw new Error(`policy ${where}: bad to ${r.to}`)
	const fragments = new Map<string, FunctionFragment>()
	for (const sig of r.selectors ?? []) {
		const frag = FunctionFragment.from(sig.startsWith('function ') ? sig : `function ${sig}`)
		const selector = id(frag.format('sighash')).slice(0, 10)
		if (fragments.has(selector)) throw new Error(`policy ${where}: duplicate selector ${frag.format('sighash')}`)
		fragments.set(selector, frag)
	}
	if (fragments.size === 0) throw new Error(`policy ${where}: rule for ${r.to} has no selectors`)
	for (const [idx, ar] of Object.entries(r.args ?? {})) {
		assertKnown(`${where}.args.${idx}`, ar, ['eq', 'in', 'minItems', 'maxItems'])
		if (!/^\d+$/.test(idx)) throw new Error(`policy ${where}: arg index ${idx} is not an integer`)
		const n = Number(idx)
		assertItemBounds(where, idx, ar)
		for (const frag of fragments.values()) {
			if (n >= frag.inputs.length) {
				throw new Error(`policy ${where}: arg index ${idx} out of range for ${frag.format('sighash')}`)
			}
			if ((ar.minItems !== undefined || ar.maxItems !== undefined) && !isArrayInput(frag, n)) {
				throw new Error(`policy ${where}: arg ${idx} length rule is not an array in ${frag.format('sighash')}`)
			}
		}
	}
	if (r.equalArrays !== undefined) assertEqualArrays(where, r.equalArrays, fragments)
	return { ...r, to: getAddress(r.to), toLc: r.to.toLowerCase(), fragments }
}

function checkArg(
	frag: FunctionFragment,
	idx: number,
	value: unknown,
	rule: ArgRule,
	lists: { compromised: Set<string>; registry: Set<string> },
): void {
	const name = `${frag.name} arg ${idx}`
	if (rule.eq !== undefined) {
		const want = String(rule.eq).toLowerCase()
		if (String(value).toLowerCase() !== want) throw denied(`${name} must equal ${rule.eq}`)
	}
	if (rule.in !== undefined) {
		const v = String(value).toLowerCase()
		const set =
			rule.in === '@compromised'
				? lists.compromised
				: rule.in === '@registry'
					? lists.registry
					: new Set(rule.in.map((x) => x.toLowerCase()))
		if (!set.has(v)) throw denied(`${name} not in ${Array.isArray(rule.in) ? 'allowed list' : rule.in}`)
	}
	if (rule.minItems !== undefined || rule.maxItems !== undefined) {
		const count = arrayItemCount(value)
		if (count === undefined) throw denied(`${name} must be an array`)
		if (rule.minItems !== undefined && count < rule.minItems) throw denied(`${name} length ${count} is below ${rule.minItems}`)
		if (rule.maxItems !== undefined && count > rule.maxItems) throw denied(`${name} length ${count} is above ${rule.maxItems}`)
	}
}

function arrayItemCount(value: unknown): number | undefined {
	if (typeof value === 'string' || value == null) return undefined
	if (Array.isArray(value)) return value.length
	if (typeof value === 'object' && typeof (value as { length?: unknown }).length === 'number') {
		return (value as { length: number }).length
	}
	return undefined
}

function enforceEqualArrays(frag: FunctionFragment, decoded: readonly unknown[], indexes: readonly number[]): void {
	const counts = indexes.map((idx) => {
		const count = arrayItemCount(decoded[idx])
		if (count === undefined) throw denied(`${frag.name} arg ${idx} must be an array`)
		return count
	})
	if (new Set(counts).size !== 1) throw denied(`${frag.name} array arguments must have the same length`)
}

function assertItemBounds(where: string, idx: string, rule: ArgRule): void {
	for (const [name, value] of [['minItems', rule.minItems], ['maxItems', rule.maxItems]] as const) {
		if (value === undefined) continue
		if (!Number.isSafeInteger(value) || value < 0) throw new Error(`policy ${where}: arg ${idx} ${name} must be a non-negative integer`)
	}
	if (rule.minItems !== undefined && rule.maxItems !== undefined && rule.minItems > rule.maxItems) {
		throw new Error(`policy ${where}: arg ${idx} minItems is above maxItems`)
	}
}

function isArrayInput(frag: FunctionFragment, idx: number): boolean {
	return frag.inputs[idx]?.baseType === 'array'
}

function assertEqualArrays(where: string, indexes: number[], fragments: Map<string, FunctionFragment>): void {
	if (!Array.isArray(indexes) || indexes.length < 2) throw new Error(`policy ${where}: equalArrays needs at least two indexes`)
	if (new Set(indexes).size !== indexes.length) throw new Error(`policy ${where}: equalArrays indexes must be unique`)
	for (const idx of indexes) {
		if (!Number.isSafeInteger(idx) || idx < 0) throw new Error(`policy ${where}: equalArrays index ${idx} is not an integer`)
		for (const frag of fragments.values()) {
			if (idx >= frag.inputs.length || !isArrayInput(frag, idx)) {
				throw new Error(`policy ${where}: equalArrays index ${idx} is not an array in ${frag.format('sighash')}`)
			}
		}
	}
}

function summarize(v: unknown): string {
	const s = typeof v === 'bigint' ? v.toString() : String(v)
	return s.length > 80 ? `${s.slice(0, 77)}...` : s
}
