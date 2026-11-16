/**
 * Earliest-load block for WebSocket constructors, ws:/wss: URLs, and Upgrade.
 * Import this module before any other application module.
 *
 * The ws package may still be loaded by ethers. Loading it is not a call.
 * This module does not remove that dependency and does not claim any advisory is fixed.
 */
import http from 'node:http'
import https from 'node:https'
import Module from 'node:module'

const DISABLED = 'WebSocket functionality is disabled'

type LoadFn = (this: unknown, request: string, parent: unknown, isMain: boolean) => unknown
type CacheRecord = { exports: unknown }
type ModuleHooks = { _load: LoadFn; _cache: Record<string, CacheRecord> }
type DisabledCtor = { new (...args: never[]): never; __conetWsWrapped?: true }

const hooks = Module as unknown as ModuleHooks

function disabledError(kind: string): Error {
	const error = new Error(`${DISABLED}: ${kind}`)
	error.name = 'WebSocketDisabled'
	return error
}

function disabledCtor(kind: string): DisabledCtor {
	function Disabled(this: unknown): never {
		throw disabledError(kind)
	}
	;(Disabled as unknown as DisabledCtor).__conetWsWrapped = true
	return Disabled as unknown as DisabledCtor
}

function copyStatic(from: Function, to: Function): void {
	for (const key of Object.getOwnPropertyNames(from)) {
		if (key === 'length' || key === 'name' || key === 'prototype') continue
		const desc = Object.getOwnPropertyDescriptor(from, key)
		if (!desc) continue
		try {
			Object.defineProperty(to, key, desc)
		} catch {
			/* non-configurable static */
		}
	}
}

function wrapWsExport(exported: unknown): unknown {
	if (typeof exported !== 'function') return exported
	if ((exported as DisabledCtor).__conetWsWrapped) return exported
	const Client = disabledCtor('WebSocket') as unknown as Function
	copyStatic(exported, Client)
	const Server = disabledCtor('WebSocketServer')
	const rec = Client as unknown as Record<string, unknown>
	rec.WebSocket = Client
	rec.Server = Server
	rec.WebSocketServer = Server
	rec.createWebSocketStream = disabledCtor('createWebSocketStream')
	;(Client as unknown as DisabledCtor).__conetWsWrapped = true
	return Client
}

function poisonProviderExports(loaded: unknown): void {
	if (!loaded || (typeof loaded !== 'object' && typeof loaded !== 'function')) return
	const exp = loaded as Record<string, unknown>
	for (const name of ['WebSocketProvider', 'InfuraWebSocketProvider']) {
		const current = exp[name]
		if (typeof current !== 'function') continue
		if ((current as DisabledCtor).__conetWsWrapped) continue
		exp[name] = disabledCtor(name)
	}
}

function replaceCached(loaded: unknown, wrapped: unknown): void {
	for (const record of Object.values(hooks._cache)) {
		if (record && record.exports === loaded) record.exports = wrapped
	}
}

function isWsRequest(request: string): boolean {
	return request === 'ws' || request.startsWith('ws/')
}

function resolvedFilename(request: string, parent: unknown): string | undefined {
	try {
		const resolved = (Module as unknown as { _resolveFilename: (req: string, parent: unknown, isMain: boolean) => string })._resolveFilename(request, parent, false)
		return typeof resolved === 'string' ? resolved : undefined
	} catch {
		return undefined
	}
}

function wsPackageKind(filename: string): 'client' | 'server' | 'stream' | 'bundle' | undefined {
	const norm = filename.replace(/\\/g, '/')
	if (!/\/node_modules\/ws\//.test(norm)) return undefined
	if (norm.endsWith('/ws/lib/websocket-server.js')) return 'server'
	if (norm.endsWith('/ws/lib/websocket.js')) return 'client'
	if (norm.endsWith('/ws/lib/stream.js')) return 'stream'
	if (norm.endsWith('/ws/index.js') || norm.endsWith('/ws/browser.js')) return 'bundle'
	return undefined
}

function isEthersWebsocketModule(request: string): boolean {
	return request.includes('provider-websocket') || request.includes('provider-infura') || request === 'ethers' || /(^|\/)ethers(\.js)?$/.test(request)
}

function headerValue(value: unknown): string {
	if (Array.isArray(value)) return value.map((item) => String(item)).join(',')
	if (value === undefined || value === null) return ''
	return String(value)
}

function headerPairIsUpgrade(name: unknown, value: unknown): boolean {
	return typeof name === 'string' && name.toLowerCase() === 'upgrade' && headerValue(value).toLowerCase().includes('websocket')
}

function hasUpgrade(headers: unknown): boolean {
	if (!headers) return false
	if (typeof Headers !== 'undefined' && headers instanceof Headers) {
		const value = headers.get('upgrade')
		return !!value && value.toLowerCase().includes('websocket')
	}
	if (Array.isArray(headers)) {
		for (let i = 0; i < headers.length; i++) {
			const item = headers[i]
			if (Array.isArray(item)) {
				if (headerPairIsUpgrade(item[0], item[1])) return true
				continue
			}
			// Node also accepts a flat list: ["Upgrade", "websocket", "Connection", "Upgrade"].
			if (headerPairIsUpgrade(item, headers[i + 1])) return true
		}
		return false
	}
	if (typeof headers === 'object') {
		for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
			if (headerPairIsUpgrade(key, value)) return true
		}
	}
	return false
}

function assertNoWebSocketRequest(args: unknown[]): void {
	for (const arg of args) {
		if (typeof arg === 'string') {
			if (/^wss?:\/\//i.test(arg)) throw disabledError('ws-url')
			continue
		}
		if (arg instanceof URL) {
			if (arg.protocol === 'ws:' || arg.protocol === 'wss:') throw disabledError('ws-url')
			continue
		}
		if (!arg || typeof arg !== 'object') continue
		const rec = arg as { protocol?: unknown; href?: unknown; headers?: unknown }
		if (typeof rec.protocol === 'string' && /^wss?:$/i.test(rec.protocol)) throw disabledError('ws-url')
		if (typeof rec.href === 'string' && /^wss?:\/\//i.test(rec.href)) throw disabledError('ws-url')
		if (hasUpgrade(rec.headers)) throw disabledError('Upgrade')
	}
}

function installRequestGuard(mod: { request: (...args: never[]) => unknown; get: (...args: never[]) => unknown }): void {
	const origRequest = mod.request
	const origGet = mod.get
	mod.request = function request(this: unknown, ...args: unknown[]) {
		assertNoWebSocketRequest(args)
		return origRequest.apply(this, args as never)
	} as typeof mod.request
	mod.get = function get(this: unknown, ...args: unknown[]) {
		assertNoWebSocketRequest(args)
		return origGet.apply(this, args as never)
	} as typeof mod.get
}

const UPGRADE_LISTENER_METHODS = ['on', 'addListener', 'prependListener', 'once', 'prependOnceListener'] as const

function isUpgradeEvent(event: unknown): boolean {
	return typeof event === 'string' && event.toLowerCase() === 'upgrade'
}

function guardServerPrototype(proto: object | null): void {
	if (!proto) return
	const marked = proto as { __conetServerGuarded?: boolean }
	if (marked.__conetServerGuarded) return
	marked.__conetServerGuarded = true
	const host = proto as Record<string, unknown>
	for (const name of UPGRADE_LISTENER_METHODS) {
		const current = host[name]
		if (typeof current !== 'function' || (current as { __conetWsWrapped?: boolean }).__conetWsWrapped) continue
		const orig = current as (this: unknown, event: unknown, listener: unknown, ...rest: unknown[]) => unknown
		const wrapped = function (this: unknown, event: unknown, listener: unknown, ...rest: unknown[]) {
			if (isUpgradeEvent(event)) throw disabledError('upgrade-listener')
			return orig.call(this, event, listener, ...rest)
		}
		;(wrapped as { __conetWsWrapped?: boolean }).__conetWsWrapped = true
		host[name] = wrapped
	}
	const emit = host.emit
	if (typeof emit === 'function' && !(emit as { __conetWsWrapped?: boolean }).__conetWsWrapped) {
		const origEmit = emit as (this: unknown, event: unknown, ...args: unknown[]) => unknown
		const wrappedEmit = function (this: unknown, event: unknown, ...args: unknown[]) {
			if (isUpgradeEvent(event)) {
				const socket = args[1] as { destroy?: () => void } | undefined
				if (socket && typeof socket.destroy === 'function') {
					try {
						socket.destroy()
					} catch {
						/* already closed */
					}
				}
				throw disabledError('inbound-upgrade')
			}
			return origEmit.call(this, event, ...args)
		}
		;(wrappedEmit as { __conetWsWrapped?: boolean }).__conetWsWrapped = true
		host.emit = wrappedEmit
	}
}

function wrapCreateServer(mod: object): void {
	const rec = mod as { createServer?: (...args: unknown[]) => unknown }
	const orig = rec.createServer
	if (typeof orig !== 'function' || (orig as { __conetWsWrapped?: boolean }).__conetWsWrapped) return
	const wrapped = function createServer(this: unknown, ...args: unknown[]) {
		const server = orig.apply(this, args)
		if (server && typeof server === 'object') guardServerPrototype(Object.getPrototypeOf(server) as object | null)
		return server
	}
	;(wrapped as { __conetWsWrapped?: boolean }).__conetWsWrapped = true
	rec.createServer = wrapped
}

function installServerGuard(): void {
	guardServerPrototype(http.Server.prototype)
	guardServerPrototype(https.Server.prototype)
	wrapCreateServer(http)
	wrapCreateServer(https)
}

function installFetchGuard(): void {
	const current = globalThis.fetch
	if (typeof current !== 'function') return
	if ((current as { __conetWsWrapped?: boolean }).__conetWsWrapped) return
	const orig = current
	const wrapped = function fetch(input: Parameters<typeof orig>[0], init?: Parameters<typeof orig>[1]): ReturnType<typeof orig> {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input instanceof Request ? input.url : ''
		if (/^wss?:\/\//i.test(url)) throw disabledError('fetch-ws')
		if (hasUpgrade(init?.headers)) throw disabledError('Upgrade')
		return orig(input, init)
	}
	;(wrapped as { __conetWsWrapped?: boolean }).__conetWsWrapped = true
	globalThis.fetch = wrapped as typeof orig
}

function installGlobalWebSocket(): void {
	const ctor = disabledCtor('WebSocket')
	try {
		Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: ctor })
	} catch {
		;(globalThis as { WebSocket?: unknown }).WebSocket = ctor
	}
}

function stubSource(kind: 'client' | 'server' | 'stream' | 'bundle'): string {
	const label = kind === 'server' ? 'WebSocketServer' : kind === 'stream' ? 'createWebSocketStream' : 'WebSocket'
	if (kind === 'bundle') {
		return `'use strict';
function deny(kind) {
	function Disabled() {
		const error = new Error('WebSocket functionality is disabled: ' + kind);
		error.name = 'WebSocketDisabled';
		throw error;
	}
	Disabled.__conetWsWrapped = true;
	return Disabled;
}
const WebSocket = deny('WebSocket');
const WebSocketServer = deny('WebSocketServer');
WebSocket.WebSocket = WebSocket;
WebSocket.Server = WebSocketServer;
WebSocket.WebSocketServer = WebSocketServer;
WebSocket.createWebSocketStream = deny('createWebSocketStream');
module.exports = WebSocket;
`
	}
	return `'use strict';
function Disabled() {
	const error = new Error('WebSocket functionality is disabled: ${label}');
	error.name = 'WebSocketDisabled';
	throw error;
}
Disabled.__conetWsWrapped = true;
module.exports = Disabled;
`
}

function installCompileHook(): void {
	const proto = (Module as unknown as { prototype: { _compile?: (this: unknown, content: string, filename: string) => unknown } }).prototype
	const orig = proto._compile
	if (!orig || (orig as { __conetWsWrapped?: boolean }).__conetWsWrapped) return
	const wrapped = function compile(this: unknown, content: string, filename: string) {
		const kind = wsPackageKind(filename)
		if (kind) return orig.call(this, stubSource(kind), filename)
		return orig.call(this, content, filename)
	}
	;(wrapped as { __conetWsWrapped?: boolean }).__conetWsWrapped = true
	proto._compile = wrapped
}

function installModuleHook(): void {
	if ((hooks._load as { __conetWsWrapped?: boolean }).__conetWsWrapped) return
	const orig = hooks._load
	const wrapped: LoadFn = function load(this: unknown, request, parent, isMain) {
		const filename = resolvedFilename(request, parent)
		const kind = filename ? wsPackageKind(filename) : undefined
		const loaded = orig.call(this, request, parent, isMain)
		if (kind === 'bundle' || isWsRequest(request)) {
			const next = wrapWsExport(loaded)
			if (next !== loaded) replaceCached(loaded, next)
			return next
		}
		if (kind === 'client' || kind === 'server' || kind === 'stream') {
			if (typeof loaded === 'function' && (loaded as DisabledCtor).__conetWsWrapped) return loaded
			const next = disabledCtor(kind === 'server' ? 'WebSocketServer' : kind === 'stream' ? 'createWebSocketStream' : 'WebSocket')
			if (next !== loaded) replaceCached(loaded, next)
			return next
		}
		if (isEthersWebsocketModule(request)) poisonProviderExports(loaded)
		return loaded
	}
	;(wrapped as { __conetWsWrapped?: boolean }).__conetWsWrapped = true
	hooks._load = wrapped
}

export function installWebSocketBan(): void {
	const flag = globalThis as { __conetWebSocketBan?: boolean }
	if (flag.__conetWebSocketBan) return
	flag.__conetWebSocketBan = true
	installGlobalWebSocket()
	installCompileHook()
	installModuleHook()
	installRequestGuard(http)
	installRequestGuard(https)
	installServerGuard()
	installFetchGuard()
}

installWebSocketBan()
