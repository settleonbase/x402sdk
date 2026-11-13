// 日志脱敏（所有请求体、查询串、URL 写日志前必须经过这里）。
// 规则：按键名 + 按值模式（0x+64hex、PGP 私钥块、Beamio 私钥 armor）。不限制遍历深度，改用输出大小上限。
// 本文件不得 import 其它模块（测试与启动器需要直接加载）。

const REDACTED = '<redacted>'
const MAX_STRING = 2000
const MAX_NODES = 5000

/** 键名匹配：私钥、助记词、种子、口令、签名密钥、armor、以及短键 pk / k。 */
const SECRET_KEY_RE = /private|secret|mnemonic|seed|passphrase|passcode|signature_?key|armor|password|^pk$|^k$/i

/** 值模式：0x + 64 hex（私钥形态）、PGP 私钥块。 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
	/0x[0-9a-fA-F]{64}\b/g,
	/-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?(?:-----END PGP PRIVATE KEY BLOCK-----|$)/g,
]

const redactStringValue = (s: string): string => {
	let out = s
	for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, REDACTED)
	return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}...<truncated ${out.length - MAX_STRING} chars>` : out
}

/** 返回脱敏后的深拷贝（可安全传给 inspect / JSON.stringify）。完整遍历，超过节点上限后截断。 */
export const redactForLog = (value: unknown): unknown => {
	const seen = new WeakSet<object>()
	let nodes = 0
	const walk = (v: unknown, keyName: string | null): unknown => {
		if (v == null) return v
		if (keyName !== null && SECRET_KEY_RE.test(keyName)) return REDACTED
		if (typeof v === 'string') return redactStringValue(v)
		if (typeof v === 'bigint') return v.toString()
		if (typeof v !== 'object') return v
		if (seen.has(v as object)) return '[Circular]'
		if (++nodes > MAX_NODES) return '<truncated: node limit>'
		seen.add(v as object)
		if (Array.isArray(v)) return v.map((x) => walk(x, null))
		const out: Record<string, unknown> = {}
		for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, k)
		return out
	}
	return walk(value, null)
}

/** 脱敏并序列化为有上限的字符串（用于 JSON 日志）。 */
export const safeLogJson = (value: unknown, maxChars = 4000): string => {
	let s: string
	try {
		s = JSON.stringify(redactForLog(value), null, 2) ?? 'undefined'
	} catch {
		s = '<unserializable>'
	}
	return s.length > maxChars ? `${s.slice(0, maxChars)}...<truncated ${s.length - maxChars} chars>` : s
}

/** URL 或路径：查询串中的敏感参数与值模式全部替换。 */
export const redactUrlForLog = (url: string): string => {
	if (typeof url !== 'string') return String(url)
	const q = url.indexOf('?')
	const base = q >= 0 ? url.slice(0, q) : url
	let query = q >= 0 ? url.slice(q + 1) : ''
	const parts = query.split('&').map((pair) => {
		const eq = pair.indexOf('=')
		const k = decodeURIComponent((eq >= 0 ? pair.slice(0, eq) : pair).replace(/\+/g, ' '))
		if (SECRET_KEY_RE.test(k)) return `${eq >= 0 ? pair.slice(0, eq) : pair}=${REDACTED}`
		return redactStringValue(pair)
	})
	query = parts.join('&')
	return redactStringValue(base) + (q >= 0 ? `?${query}` : '')
}

/** 查询对象（req.query）脱敏。 */
export const redactQueryForLog = (query: unknown): unknown => redactForLog(query)
