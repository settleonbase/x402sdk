import dns from 'node:dns/promises'
import net from 'node:net'

function isBlockedIpv4(ip: string): boolean {
	const p = ip.split('.').map((x) => Number(x))
	if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
	if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true
	if (p[0] === 169 && p[1] === 254) return true
	if (p[0] === 192 && p[1] === 168) return true
	if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true
	if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true
	return false
}

export function isBlockedIp(ip: string): boolean {
	const v = net.isIP(ip)
	if (v === 4) return isBlockedIpv4(ip)
	if (v === 6) {
		const n = ip.toLowerCase()
		if (n === '::1' || n === '::') return true
		if (n.startsWith('fe80:')) return true
		if (n.startsWith('fc') || n.startsWith('fd')) return true
		if (n.startsWith('::ffff:')) {
			const v4 = n.slice('::ffff:'.length)
			if (net.isIP(v4) === 4) return isBlockedIpv4(v4)
		}
		return false
	}
	return true
}

export function hostnameBlocked(host: string): boolean {
	const h = host.trim().toLowerCase().replace(/\.+$/, '')
	if (!h) return true
	if (h === 'localhost' || h === 'metadata.google.internal') return true
	if (h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
	if (net.isIP(h) && isBlockedIp(h)) return true
	return false
}

export function parsePublicHttpUrl(raw: string): URL | null {
	let s = raw.trim()
	if (!s) return null
	if (!/^https?:\/\//i.test(s)) s = `https://${s}`
	let u: URL
	try {
		u = new URL(s)
	} catch {
		return null
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
	if (u.username || u.password) return null
	if (hostnameBlocked(u.hostname)) return null
	return u
}

export async function assertPublicHost(url: URL): Promise<boolean> {
	if (hostnameBlocked(url.hostname)) return false
	if (net.isIP(url.hostname)) return !isBlockedIp(url.hostname)
	try {
		const records = await dns.lookup(url.hostname, { all: true, verbatim: true })
		if (!records.length) return false
		return records.every((r) => !isBlockedIp(r.address))
	} catch {
		return false
	}
}
