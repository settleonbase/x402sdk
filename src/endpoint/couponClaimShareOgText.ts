import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(__filename)

export type OgTextLayer = {
	text: string
	x: number
	/** SVG/canvas text baseline Y */
	y: number
	fontSize: number
	fontWeight: 400 | 600 | 800
	color: string
	align: 'left' | 'center'
	maxWidth?: number
}

type OgFontFaceSpec = {
	pkg: string
	file: string
	/** CSS family name used in ctx.font stack */
	family: string
}

/**
 * Noto Sans per-script faces. Skia resolves glyphs by trying each family in OG_FONT_STACK order.
 * Covers Latin/European, CJK, Arabic, Hebrew, Thai, Devanagari (Hindi), Cyrillic, Greek, Vietnamese.
 */
const OG_FONT_FACES: readonly OgFontFaceSpec[] = [
	{ pkg: '@fontsource/noto-sans', file: 'noto-sans-latin-400-normal.woff', family: 'Noto Sans' },
	{ pkg: '@fontsource/noto-sans', file: 'noto-sans-latin-600-normal.woff', family: 'Noto Sans' },
	{ pkg: '@fontsource/noto-sans', file: 'noto-sans-latin-700-normal.woff', family: 'Noto Sans' },
	{ pkg: '@fontsource/noto-sans', file: 'noto-sans-latin-ext-400-normal.woff', family: 'Noto Sans' },
	{ pkg: '@fontsource/noto-sans', file: 'noto-sans-latin-ext-600-normal.woff', family: 'Noto Sans' },
	{ pkg: '@fontsource/noto-sans', file: 'noto-sans-latin-ext-700-normal.woff', family: 'Noto Sans' },
	{ pkg: '@fontsource/noto-sans', file: 'noto-sans-cyrillic-400-normal.woff', family: 'Noto Sans' },
	{ pkg: '@fontsource/noto-sans', file: 'noto-sans-cyrillic-600-normal.woff', family: 'Noto Sans' },
	{ pkg: '@fontsource/noto-sans', file: 'noto-sans-cyrillic-700-normal.woff', family: 'Noto Sans' },
	{ pkg: '@fontsource/noto-sans', file: 'noto-sans-cyrillic-ext-400-normal.woff', family: 'Noto Sans' },
	{ pkg: '@fontsource/noto-sans', file: 'noto-sans-cyrillic-ext-600-normal.woff', family: 'Noto Sans' },
	{ pkg: '@fontsource/noto-sans', file: 'noto-sans-cyrillic-ext-700-normal.woff', family: 'Noto Sans' },
	{ pkg: '@fontsource/noto-sans', file: 'noto-sans-greek-400-normal.woff', family: 'Noto Sans' },
	{ pkg: '@fontsource/noto-sans', file: 'noto-sans-greek-600-normal.woff', family: 'Noto Sans' },
	{ pkg: '@fontsource/noto-sans', file: 'noto-sans-greek-700-normal.woff', family: 'Noto Sans' },
	{ pkg: '@fontsource/noto-sans', file: 'noto-sans-vietnamese-400-normal.woff', family: 'Noto Sans' },
	{ pkg: '@fontsource/noto-sans', file: 'noto-sans-vietnamese-600-normal.woff', family: 'Noto Sans' },
	{ pkg: '@fontsource/noto-sans', file: 'noto-sans-vietnamese-700-normal.woff', family: 'Noto Sans' },
	{ pkg: '@fontsource/noto-sans-sc', file: 'noto-sans-sc-chinese-simplified-400-normal.woff', family: 'Noto Sans SC' },
	{ pkg: '@fontsource/noto-sans-sc', file: 'noto-sans-sc-chinese-simplified-600-normal.woff', family: 'Noto Sans SC' },
	{ pkg: '@fontsource/noto-sans-sc', file: 'noto-sans-sc-chinese-simplified-700-normal.woff', family: 'Noto Sans SC' },
	{ pkg: '@fontsource/noto-sans-tc', file: 'noto-sans-tc-chinese-traditional-400-normal.woff', family: 'Noto Sans TC' },
	{ pkg: '@fontsource/noto-sans-tc', file: 'noto-sans-tc-chinese-traditional-600-normal.woff', family: 'Noto Sans TC' },
	{ pkg: '@fontsource/noto-sans-tc', file: 'noto-sans-tc-chinese-traditional-700-normal.woff', family: 'Noto Sans TC' },
	{ pkg: '@fontsource/noto-sans-jp', file: 'noto-sans-jp-japanese-400-normal.woff', family: 'Noto Sans JP' },
	{ pkg: '@fontsource/noto-sans-jp', file: 'noto-sans-jp-japanese-600-normal.woff', family: 'Noto Sans JP' },
	{ pkg: '@fontsource/noto-sans-jp', file: 'noto-sans-jp-japanese-700-normal.woff', family: 'Noto Sans JP' },
	{ pkg: '@fontsource/noto-sans-kr', file: 'noto-sans-kr-korean-400-normal.woff', family: 'Noto Sans KR' },
	{ pkg: '@fontsource/noto-sans-kr', file: 'noto-sans-kr-korean-600-normal.woff', family: 'Noto Sans KR' },
	{ pkg: '@fontsource/noto-sans-kr', file: 'noto-sans-kr-korean-700-normal.woff', family: 'Noto Sans KR' },
	{ pkg: '@fontsource/noto-sans-arabic', file: 'noto-sans-arabic-arabic-400-normal.woff', family: 'Noto Sans Arabic' },
	{ pkg: '@fontsource/noto-sans-arabic', file: 'noto-sans-arabic-arabic-600-normal.woff', family: 'Noto Sans Arabic' },
	{ pkg: '@fontsource/noto-sans-arabic', file: 'noto-sans-arabic-arabic-700-normal.woff', family: 'Noto Sans Arabic' },
	{ pkg: '@fontsource/noto-sans-thai', file: 'noto-sans-thai-thai-400-normal.woff', family: 'Noto Sans Thai' },
	{ pkg: '@fontsource/noto-sans-thai', file: 'noto-sans-thai-thai-600-normal.woff', family: 'Noto Sans Thai' },
	{ pkg: '@fontsource/noto-sans-thai', file: 'noto-sans-thai-thai-700-normal.woff', family: 'Noto Sans Thai' },
	{ pkg: '@fontsource/noto-sans-hebrew', file: 'noto-sans-hebrew-hebrew-400-normal.woff', family: 'Noto Sans Hebrew' },
	{ pkg: '@fontsource/noto-sans-hebrew', file: 'noto-sans-hebrew-hebrew-600-normal.woff', family: 'Noto Sans Hebrew' },
	{ pkg: '@fontsource/noto-sans-hebrew', file: 'noto-sans-hebrew-hebrew-700-normal.woff', family: 'Noto Sans Hebrew' },
	{
		pkg: '@fontsource/noto-sans-devanagari',
		file: 'noto-sans-devanagari-devanagari-400-normal.woff',
		family: 'Noto Sans Devanagari',
	},
	{
		pkg: '@fontsource/noto-sans-devanagari',
		file: 'noto-sans-devanagari-devanagari-600-normal.woff',
		family: 'Noto Sans Devanagari',
	},
	{
		pkg: '@fontsource/noto-sans-devanagari',
		file: 'noto-sans-devanagari-devanagari-700-normal.woff',
		family: 'Noto Sans Devanagari',
	},
]

/** Order matters: Latin first, then CJK, then other scripts. */
const OG_FONT_STACK = [
	'Noto Sans',
	'Noto Sans SC',
	'Noto Sans TC',
	'Noto Sans JP',
	'Noto Sans KR',
	'Noto Sans Arabic',
	'Noto Sans Hebrew',
	'Noto Sans Thai',
	'Noto Sans Devanagari',
] as const

const OG_FONT_STACK_CSS = OG_FONT_STACK.map((f) => `"${f}"`).join(', ')

let ogFontsReady = false

function ensureOgMultilingualFonts(): void {
	if (ogFontsReady) return
	for (const spec of OG_FONT_FACES) {
		try {
			const path = nodeRequire.resolve(`${spec.pkg}/files/${spec.file}`)
			GlobalFonts.registerFromPath(path, spec.family)
		} catch {
			// Skip when a face is unavailable in the deployment image.
		}
	}
	ogFontsReady = true
}

function canvasWeight(fontWeight: OgTextLayer['fontWeight']): 400 | 600 | 700 {
	if (fontWeight >= 700) return 700
	if (fontWeight >= 600) return 600
	return 400
}

function ogCanvasFont(fontWeight: OgTextLayer['fontWeight'], fontSize: number): string {
	const weight = canvasWeight(fontWeight)
	return `${weight} ${fontSize}px ${OG_FONT_STACK_CSS}, sans-serif`
}

function textDirection(text: string): 'ltr' | 'rtl' {
	if (/[\u0590-\u05FF\uFB1D-\uFB4F]/.test(text)) return 'rtl'
	if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text)) return 'rtl'
	return 'ltr'
}

function truncateToWidth(
	ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
	text: string,
	maxWidth: number
): string {
	if (!text || maxWidth <= 0) return text
	if (ctx.measureText(text).width <= maxWidth) return text
	let trimmed = text
	while (trimmed.length > 0 && ctx.measureText(`${trimmed}…`).width > maxWidth) {
		trimmed = trimmed.slice(0, -1)
	}
	return trimmed.length > 0 ? `${trimmed}…` : '…'
}

/** Render a single-line label as PNG for sharp composite (multilingual-safe). */
export function renderOgTextLayerPng(layer: OgTextLayer): { buffer: Buffer; left: number; top: number } {
	ensureOgMultilingualFonts()
	const text = layer.text.trim()
	const maxWidth = Math.max(32, layer.maxWidth ?? 1100)
	const canvasHeight = Math.ceil(layer.fontSize * 1.45)
	const measureCanvas = createCanvas(maxWidth, canvasHeight)
	const measureCtx = measureCanvas.getContext('2d')
	measureCtx.font = ogCanvasFont(layer.fontWeight, layer.fontSize)
	measureCtx.direction = textDirection(text)

	const displayText = layer.align === 'left' ? truncateToWidth(measureCtx, text, maxWidth) : text
	const measuredWidth = Math.ceil(measureCtx.measureText(displayText).width)
	const overlayWidth =
		layer.align === 'left' ? Math.min(maxWidth, Math.max(1, measuredWidth)) : maxWidth

	const canvas = createCanvas(overlayWidth, canvasHeight)
	const ctx = canvas.getContext('2d')
	ctx.font = ogCanvasFont(layer.fontWeight, layer.fontSize)
	ctx.fillStyle = layer.color
	ctx.textBaseline = 'alphabetic'
	ctx.textAlign = layer.align === 'center' ? 'center' : 'left'
	ctx.direction = textDirection(text)

	const textX = layer.align === 'center' ? overlayWidth / 2 : 0
	const textY = layer.fontSize
	ctx.fillText(displayText, textX, textY)

	const left =
		layer.align === 'center'
			? Math.max(0, Math.round(layer.x - overlayWidth / 2))
			: Math.max(0, Math.round(layer.x))
	const top = Math.max(0, Math.round(layer.y - layer.fontSize))

	return { buffer: canvas.toBuffer('image/png'), left, top }
}

export function buildOgTextComposites(
	layers: OgTextLayer[]
): Array<{ input: Buffer; left: number; top: number }> {
	return layers
		.filter((layer) => layer.text.trim().length > 0)
		.map((layer) => {
			const { buffer, left, top } = renderOgTextLayerPng(layer)
			return { input: buffer, left, top }
		})
}
