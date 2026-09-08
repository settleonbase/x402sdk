import { inflateRawSync } from 'node:zlib'

export const ONBOARDING_LOOKUP_MAX_FILES = 3
export const ONBOARDING_LOOKUP_MAX_FILE_BYTES = Math.floor(1.5 * 1024 * 1024)
export const ONBOARDING_LOOKUP_MAX_TOTAL_BYTES = Math.floor(3.5 * 1024 * 1024)
export const ONBOARDING_LOOKUP_MAX_DOCX_TEXT = 24_000

const MAX_DOCX_UNCOMPRESSED = 512 * 1024
const CD_SIG = 0x02014b50
const LH_SIG = 0x04034b50
const EOCD_SIG = 0x06054b50

export type OnboardingLookupFileKind = 'pdf' | 'jpeg' | 'png' | 'gif' | 'webp' | 'docx'

export type ParsedOnboardingLookupFile = {
	filename: string
	kind: OnboardingLookupFileKind
	geminiMime: string
	base64: string
	byteLength: number
	text?: string
}

export type OnboardingLookupFilesError =
	| 'file_too_many'
	| 'file_too_large'
	| 'file_unsupported'
	| 'file_invalid'
	| 'file_legacy_word'

type ParseOk = { files: ParsedOnboardingLookupFile[] }
type ParseErr = { error: OnboardingLookupFilesError }

const GEMINI_MIME: Record<OnboardingLookupFileKind, string> = {
	pdf: 'application/pdf',
	jpeg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif',
	webp: 'image/webp',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

function clip(s: string, n: number): string {
	return s.length <= n ? s : s.slice(0, n)
}

function safeFilename(raw: string): string {
	const base = clip(raw.trim().replace(/[/\\]+/g, '_'), 120)
	return base || 'attachment'
}

function decodeBase64(raw: string): Buffer | null {
	const s = raw.trim().replace(/\s+/g, '')
	if (!s || s.length > ONBOARDING_LOOKUP_MAX_FILE_BYTES * 2) return null
	if (!/^[A-Za-z0-9+/]+=*$/.test(s)) return null
	try {
		const buf = Buffer.from(s, 'base64')
		if (!buf.length) return null
		return buf
	} catch {
		return null
	}
}

function startsWith(buf: Buffer, bytes: number[]): boolean {
	if (buf.length < bytes.length) return false
	for (let i = 0; i < bytes.length; i++) {
		if (buf[i] !== bytes[i]) return false
	}
	return true
}

function sniffKind(buf: Buffer): OnboardingLookupFileKind | 'ole' | null {
	if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0])) return 'ole'
	if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === '%PDF') return 'pdf'
	if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpeg'
	if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
	if (buf.length >= 6) {
		const gif = buf.subarray(0, 6).toString('ascii')
		if (gif === 'GIF87a' || gif === 'GIF89a') return 'gif'
	}
	if (
		buf.length >= 12 &&
		buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
		buf.subarray(8, 12).toString('ascii') === 'WEBP'
	) {
		return 'webp'
	}
	if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4b, 0x05, 0x06])) {
		return 'docx'
	}
	return null
}

function findEocd(buf: Buffer): number {
	const min = Math.max(0, buf.length - 22 - 65535)
	for (let i = buf.length - 22; i >= min; i--) {
		if (buf.readUInt32LE(i) === EOCD_SIG) return i
	}
	return -1
}

function extractZipEntry(buf: Buffer, wantName: string): Buffer | null {
	const eocd = findEocd(buf)
	if (eocd < 0 || eocd + 22 > buf.length) return null
	const entries = buf.readUInt16LE(eocd + 10)
	const cdSize = buf.readUInt32LE(eocd + 12)
	const cdOffset = buf.readUInt32LE(eocd + 16)
	if (!entries || cdOffset + cdSize > buf.length) return null
	let p = cdOffset
	for (let i = 0; i < entries; i++) {
		if (p + 46 > buf.length) return null
		if (buf.readUInt32LE(p) !== CD_SIG) return null
		const method = buf.readUInt16LE(p + 10)
		const compSize = buf.readUInt32LE(p + 20)
		const uncompSize = buf.readUInt32LE(p + 24)
		const fnLen = buf.readUInt16LE(p + 28)
		const extraLen = buf.readUInt16LE(p + 30)
		const commentLen = buf.readUInt16LE(p + 32)
		const localOff = buf.readUInt32LE(p + 42)
		if (p + 46 + fnLen > buf.length) return null
		const name = buf.subarray(p + 46, p + 46 + fnLen).toString('utf8')
		if (name === wantName) {
			if (localOff + 30 > buf.length) return null
			if (buf.readUInt32LE(localOff) !== LH_SIG) return null
			const lfn = buf.readUInt16LE(localOff + 26)
			const lextra = buf.readUInt16LE(localOff + 28)
			const dataStart = localOff + 30 + lfn + lextra
			if (dataStart + compSize > buf.length) return null
			const data = buf.subarray(dataStart, dataStart + compSize)
			const cap = Math.min(uncompSize || MAX_DOCX_UNCOMPRESSED, MAX_DOCX_UNCOMPRESSED)
			if (method === 0) {
				return data.length > cap ? data.subarray(0, cap) : Buffer.from(data)
			}
			if (method === 8) {
				try {
					return inflateRawSync(data, { maxOutputLength: cap })
				} catch {
					return null
				}
			}
			return null
		}
		p += 46 + fnLen + extraLen + commentLen
	}
	return null
}

function stripDocxXml(xml: string): string {
	const text = xml
		.replace(/<w:tab\b[^>]*\/>/gi, '\t')
		.replace(/<w:br\b[^>]*\/>/gi, '\n')
		.replace(/<\/w:p>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
	return clip(text, ONBOARDING_LOOKUP_MAX_DOCX_TEXT)
}

export function extractDocxPlainText(buf: Buffer): string | null {
	const xmlBuf = extractZipEntry(buf, 'word/document.xml')
	if (!xmlBuf) return null
	return stripDocxXml(xmlBuf.toString('utf8'))
}

function parseOne(raw: unknown): ParseErr | { file: ParsedOnboardingLookupFile } {
	if (!raw || typeof raw !== 'object') return { error: 'file_invalid' }
	const o = raw as Record<string, unknown>
	const filename = safeFilename(String(o.filename ?? ''))
	const dataBase64 = String(o.dataBase64 ?? '')
	const buf = decodeBase64(dataBase64)
	if (!buf) return { error: 'file_invalid' }
	if (buf.length > ONBOARDING_LOOKUP_MAX_FILE_BYTES) return { error: 'file_too_large' }
	const sniffed = sniffKind(buf)
	if (sniffed === 'ole') return { error: 'file_legacy_word' }
	if (!sniffed) return { error: 'file_unsupported' }
	if (sniffed === 'docx') {
		const text = extractDocxPlainText(buf)
		if (text == null) return { error: 'file_unsupported' }
		if (!text.trim()) return { error: 'file_invalid' }
		return {
			file: {
				filename,
				kind: 'docx',
				geminiMime: GEMINI_MIME.docx,
				base64: buf.toString('base64'),
				byteLength: buf.length,
				text,
			},
		}
	}
	return {
		file: {
			filename,
			kind: sniffed,
			geminiMime: GEMINI_MIME[sniffed],
			base64: buf.toString('base64'),
			byteLength: buf.length,
		},
	}
}

export function parseOnboardingLookupFiles(raw: unknown): ParseOk | ParseErr {
	if (raw == null) return { files: [] }
	if (!Array.isArray(raw)) return { error: 'file_invalid' }
	if (raw.length > ONBOARDING_LOOKUP_MAX_FILES) return { error: 'file_too_many' }
	const files: ParsedOnboardingLookupFile[] = []
	let total = 0
	for (const item of raw) {
		const one = parseOne(item)
		if ('error' in one) return one
		total += one.file.byteLength
		if (total > ONBOARDING_LOOKUP_MAX_TOTAL_BYTES) return { error: 'file_too_large' }
		files.push(one.file)
	}
	return { files }
}

export function summarizeOnboardingLookupFiles(files: ParsedOnboardingLookupFile[]): string {
	if (!files.length) return 'files=0'
	return files.map((f) => `${f.kind}:${f.byteLength}:${clip(f.filename, 40)}`).join('|')
}
