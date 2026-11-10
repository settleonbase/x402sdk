/**
 * Repeatable WebSocket-use check for wallet-signer and conet-oracle-daemon.
 * Parses source with the TypeScript AST. A string mention is not a call.
 * ethers' unused WebSocketProvider export is outside this scan (node_modules).
 *
 * Pass/fail covers only those two packages' business source and compiled dist,
 * their direct node entries, and the three startup lines that preload the guard.
 * It does not make the rest of the repository, browsers, or chain nodes safe.
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const worktree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const WIP_SHA256 = '4e66e94ce6a93eaa5c526b5446fd024baeb1ac271260af9b43043e13039625ff'
const failures = []
const businessFindings = []

function fail(message) {
	failures.push(message)
}

function sha256(file) {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function walk(dir, out) {
	if (!fs.existsSync(dir)) return
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name === '.git') continue
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) walk(full, out)
		else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.map')) out.push(full)
	}
}

const BANNED_FREE = new Set(['WebSocket', 'WebSocketServer', 'WebSocketProvider', 'InfuraWebSocketProvider'])
const WS_SPEC = new Set(['ws', 'websocket', 'isomorphic-ws', 'rpc-websockets', 'uWebSockets.js'])

function isWsSpec(spec) {
	return WS_SPEC.has(spec) || spec.startsWith('ws/')
}
function isEthersSpec(spec) {
	return spec === 'ethers' || spec.startsWith('ethers/')
}
function literal(node) {
	return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null
}

function scan(text, fileName) {
	const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : fileName.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
	const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, kind)
	const findings = []
	const scopes = [new Map()]
	const add = (node, kindName, detail) => {
		const pos = source.getLineAndCharacterOfPosition(node.getStart(source))
		findings.push(`${fileName}:${pos.line + 1}:${pos.character + 1} ${kindName} ${detail}`)
	}
	const bind = (name, value) => scopes[scopes.length - 1].set(name, value)
	const lookup = (name) => {
		for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return scopes[i].get(name)
		return undefined
	}
	const push = () => scopes.push(new Map())
	const pop = () => scopes.pop()

	function classify(expr) {
		if (!expr) return 'none'
		if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr) || ts.isSatisfiesExpression?.(expr)) return classify(expr.expression)
		if (ts.isIdentifier(expr)) {
			const known = lookup(expr.text)
			if (known) return known
			return BANNED_FREE.has(expr.text) ? 'ban' : 'none'
		}
		if (ts.isPropertyAccessExpression(expr)) {
			const prop = expr.name.text
			const obj = classify(expr.expression)
			const root = ts.isIdentifier(expr.expression) ? expr.expression.text : ''
			if ((root === 'globalThis' || root === 'global' || root === 'window') && prop === 'WebSocket') return 'ban'
			if ((obj === 'wsmod' || obj === 'ban') && ['WebSocket', 'Server', 'WebSocketServer', 'createWebSocketStream'].includes(prop)) return 'ban'
			if ((obj === 'ethers' || obj === 'ban') && (prop === 'WebSocketProvider' || prop === 'InfuraWebSocketProvider')) return 'ban'
			return 'none'
		}
		if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'require') {
			const spec = literal(expr.arguments[0]) ?? (ts.isIdentifier(expr.arguments[0]) ? lookup(expr.arguments[0].text) : null)
			if (typeof spec === 'string' && isWsSpec(spec)) return 'ban'
			if (spec === 'ws-spec') return 'ban'
			if (typeof spec === 'string' && isEthersSpec(spec)) return 'ethers'
			return 'none'
		}
		return 'none'
	}

	function bindName(name, value) {
		if (ts.isIdentifier(name)) bind(name.text, value)
	}

	function visit(node) {
		if (ts.isTypeNode(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) return
		if (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) {
			push()
			for (const param of node.parameters) if (ts.isIdentifier(param.name) && BANNED_FREE.has(param.name.text)) bind(param.name.text, 'ban')
			ts.forEachChild(node, visit)
			pop()
			return
		}
		if (ts.isBlock(node)) {
			push()
			ts.forEachChild(node, visit)
			pop()
			return
		}
		if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
			const spec = literal(node.moduleSpecifier)
			const clause = node.importClause
			if (spec && isWsSpec(spec)) add(node, 'import', spec)
			if (spec && isEthersSpec(spec) && clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
				for (const el of clause.namedBindings.elements) {
					if (el.isTypeOnly) continue
					const imported = el.propertyName?.text ?? el.name.text
					if (imported === 'WebSocketProvider' || imported === 'InfuraWebSocketProvider') {
						bind(el.name.text, 'ban')
						add(el, 'import', `${imported} from ${spec}`)
					}
				}
			}
			if (spec && isWsSpec(spec) && clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
				for (const el of clause.namedBindings.elements) if (!el.isTypeOnly) bind(el.name.text, 'ban')
			}
			if (spec && isWsSpec(spec) && clause?.name) bind(clause.name.text, 'ban')
			if (spec && isEthersSpec(spec) && clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) bind(clause.namedBindings.name.text, 'ethers')
			return
		}
		if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
			const spec = literal(node.arguments[0]) ?? (ts.isIdentifier(node.arguments[0]) ? lookup(node.arguments[0].text) : null)
			if ((typeof spec === 'string' && isWsSpec(spec)) || spec === 'ws-spec') add(node, 'dynamic-import', String(spec))
		}
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
			const spec = literal(node.arguments[0]) ?? (ts.isIdentifier(node.arguments[0]) ? lookup(node.arguments[0].text) : null)
			if ((typeof spec === 'string' && isWsSpec(spec)) || spec === 'ws-spec') add(node, 'require', String(spec))
		}
		if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && classify(node.expression) === 'ban' && !(ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
			add(node, ts.isNewExpression(node) ? 'new' : 'call', node.expression.getText(source).slice(0, 80))
		}
		if (ts.isVariableDeclaration(node)) {
			if (node.initializer) visit(node.initializer)
			const value = classify(node.initializer)
			if (literal(node.initializer) && isWsSpec(literal(node.initializer))) bindName(node.name, 'ws-spec')
			else bindName(node.name, value)
			if (ts.isObjectBindingPattern(node.name)) {
				for (const el of node.name.elements) {
					if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) continue
					const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text
					if (value === 'ethers' && (prop === 'WebSocketProvider' || prop === 'InfuraWebSocketProvider')) {
						bind(el.name.text, 'ban')
						add(el, 'require-binding', prop)
					} else if ((value === 'ban' || value === 'wsmod') && ['WebSocket', 'Server', 'WebSocketServer', 'createWebSocketStream'].includes(prop)) bind(el.name.text, 'ban')
					else bind(el.name.text, 'none')
				}
			}
			return
		}
		if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /^wss?:\/\//i.test(node.text)) {
			const parent = node.parent
			if (!(parent && ts.isImportDeclaration(parent)) && !(parent && ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'require')) add(node, 'url', node.text.slice(0, 80))
		}
		ts.forEachChild(node, visit)
	}
	visit(source)
	return findings
}

function assertRecognizer() {
	const samples = [
		["import { JsonRpcProvider, parseUnits, Interface } from 'ethers'\n", 0],
		["const label = 'WebSocketProvider'\n", 0],
		["const { WebSocketProvider } = require('ethers')\nnew WebSocketProvider('ws://127.0.0.1')\n", 3],
		['const WS = WebSocket\nnew WS("wss://127.0.0.1")\n', 2],
		["import('ws')\n", 1],
		["const spec = 'ws'\nrequire(spec)\n", 1],
		['function open(url){ return new WebSocket(url) }\n', 1],
	]
	for (const [text, count] of samples) {
		const found = scan(text, 'recognizer.ts')
		if (found.length < count) fail(`recognizer missed a use in ${JSON.stringify(text)} -> ${found.join(' | ') || 'none'}`)
		if (count === 0 && found.length !== 0) fail(`recognizer flagged non-use ${JSON.stringify(text)} -> ${found.join(' | ')}`)
	}
}

function firstImport(file) {
	const text = fs.readFileSync(file, 'utf8')
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS)
	const stmt = source.statements.find((item) => ts.isImportDeclaration(item))
	return stmt && ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : ''
}

function firstRequire(file) {
	const text = fs.readFileSync(file, 'utf8')
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
	let found = ''
	function visit(node) {
		if (found) return
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
			found = literal(node.arguments[0]) ?? ''
			return
		}
		ts.forEachChild(node, visit)
	}
	visit(source)
	return found
}

function execTokens(line) {
	return line.trim().split(/\s+/)
}

function checkExec(file, text) {
	const lines = text.split(/\n/).filter((line) => line.includes('ExecStart='))
	if (lines.length !== 1) {
		fail(`${file}: expected one ExecStart, found ${lines.length}`)
		return
	}
	const tokens = execTokens(lines[0].slice(lines[0].indexOf('ExecStart=') + 'ExecStart='.length))
	const requireAt = tokens.indexOf('--require')
	const guardAt = tokens.findIndex((token) => token.endsWith('noWebSocket.js'))
	const mainAt = tokens.findIndex((token) => token.endsWith('main.js'))
	console.log(`startup ${path.relative(worktree, file)} :: ${lines[0].trim()}`)
	if (requireAt < 0 || guardAt < 0 || mainAt < 0 || !(requireAt < guardAt && guardAt < mainAt)) {
		fail(`${file}: --require noWebSocket.js must appear before main.js`)
	}
	if (/NODE_OPTIONS=.*--require/.test(text) || /\beval\b/.test(lines[0]) || /-e\b/.test(lines[0])) {
		fail(`${file}: preload must be the ExecStart --require module, not NODE_OPTIONS or eval`)
	}
}

assertRecognizer()

const signerGuard = path.join(worktree, 'packages/wallet-signer/src/noWebSocket.ts')
const oracleGuard = path.join(worktree, 'packages/conet-oracle-daemon/src/noWebSocket.ts')
const signerSha = sha256(signerGuard)
const oracleSha = sha256(oracleGuard)
console.log(`signer_sha256=${signerSha}`)
console.log(`oracle_sha256=${oracleSha}`)
if (signerSha !== oracleSha) fail('signer and oracle noWebSocket.ts differ')
if (signerSha === WIP_SHA256 || oracleSha === WIP_SHA256) fail('guard is still the WIP hash')

const packages = ['packages/wallet-signer', 'packages/conet-oracle-daemon']
const allow = new Set(['noWebSocket.ts', 'noWebSocket.js', 'noWebSocketProbe.mjs', 'noWebSocketEsmProbe.mjs', '.noWebSocket.probe-compile.cjs'])
const scanned = []
for (const pkg of packages) {
	for (const rel of ['src', 'p0', 'test', 'dist']) {
		const root = path.join(worktree, pkg, rel)
		const files = []
		walk(root, files)
		for (const file of files) {
			scanned.push(path.relative(worktree, file))
			const base = path.basename(file)
			const text = fs.readFileSync(file, 'utf8')
			if (allow.has(base)) {
				if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(text)) fail(`${file}: enforcement or probe uses eval or new Function`)
				continue
			}
			businessFindings.push(...scan(text, path.relative(worktree, file)))
		}
	}
}

const entries = [
	['packages/wallet-signer/src/main.ts', './noWebSocket', 'packages/wallet-signer/dist/src/main.js'],
	['packages/wallet-signer/src/wsctl.ts', './noWebSocket', 'packages/wallet-signer/dist/src/wsctl.js'],
	['packages/wallet-signer/p0/p0Plan.ts', '../src/noWebSocket', 'packages/wallet-signer/dist/p0/p0Plan.js'],
	['packages/conet-oracle-daemon/src/main.ts', './noWebSocket', 'packages/conet-oracle-daemon/dist/src/main.js'],
]
console.log('covered_entries:')
for (const [src, spec, dist] of entries) {
	console.log(`- ${src} -> ${dist}`)
	if (firstImport(path.join(worktree, src)) !== spec) fail(`${src}: first import is not ${spec}`)
	const distPath = path.join(worktree, dist)
	if (!fs.existsSync(distPath)) fail(`${dist}: missing compiled entry; run tsc before this check`)
	else if (!firstRequire(distPath).endsWith('noWebSocket')) fail(`${dist}: first require is not the guard (${firstRequire(distPath)})`)
}

const startups = [
	'packages/wallet-signer/deploy/wallet-signer.service',
	'packages/conet-oracle-daemon/deploy/conet-oracle-quote.service',
	'packages/conet-oracle-daemon/deploy/run-systemd-fetch-acceptance.sh',
]
console.log('covered_startups:')
for (const rel of startups) {
	console.log(`- ${rel}`)
	checkExec(path.join(worktree, rel), fs.readFileSync(path.join(worktree, rel), 'utf8'))
}

const remediation = []
function walkService(dir) {
	if (!fs.existsSync(dir)) return
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) walkService(full)
		else if (entry.isFile()) {
			const text = fs.readFileSync(full, 'utf8')
			if (/ws:\/\/|wss:\/\/|--ws\b/.test(text)) remediation.push(path.relative(worktree, full))
		}
	}
}
walkService(path.join(worktree, 'service'))
console.log(`scanned_business_files=${scanned.length}`)
console.log('not_business_use=node_modules/ethers WebSocketProvider export; transitive load of ws; noWebSocket.ts guard; noWebSocketProbe.mjs')
console.log('covered=wallet-signer main, wsctl, p0Plan, oracle main, wallet-signer.service, conet-oracle-quote.service, run-systemd-fetch-acceptance.sh')
console.log('not_covered=rest-of-repository, browsers, chain-nodes, http2')
console.log('not_globally_safe=yes')
console.log('service_remediation_not_modified:')
for (const file of remediation) console.log(`- ${file}`)
if (businessFindings.length) {
	console.log('business_findings:')
	for (const finding of businessFindings) console.log(finding)
	fail(`business WebSocket use: ${businessFindings.length}`)
}
if (failures.length) {
	console.log('check_failures:')
	for (const failure of failures) console.log(failure)
	console.log('exit=1')
	process.exit(1)
}
console.log('exit=0')
