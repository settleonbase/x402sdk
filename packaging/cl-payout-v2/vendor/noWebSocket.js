"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.installWebSocketBan = installWebSocketBan;
/**
 * Earliest-load block for WebSocket constructors, ws:/wss: URLs, and Upgrade.
 * Import this module before any other application module.
 *
 * The ws package may still be loaded by ethers. Loading it is not a call.
 * This module does not remove that dependency and does not claim any advisory is fixed.
 */
const node_http_1 = __importDefault(require("node:http"));
const node_https_1 = __importDefault(require("node:https"));
const node_module_1 = __importDefault(require("node:module"));
const DISABLED = 'WebSocket functionality is disabled';
const hooks = node_module_1.default;
function disabledError(kind) {
    const error = new Error(`${DISABLED}: ${kind}`);
    error.name = 'WebSocketDisabled';
    return error;
}
function disabledCtor(kind) {
    function Disabled() {
        throw disabledError(kind);
    }
    ;
    Disabled.__conetWsWrapped = true;
    return Disabled;
}
function copyStatic(from, to) {
    for (const key of Object.getOwnPropertyNames(from)) {
        if (key === 'length' || key === 'name' || key === 'prototype')
            continue;
        const desc = Object.getOwnPropertyDescriptor(from, key);
        if (!desc)
            continue;
        try {
            Object.defineProperty(to, key, desc);
        }
        catch {
            /* non-configurable static */
        }
    }
}
function wrapWsExport(exported) {
    if (typeof exported !== 'function')
        return exported;
    if (exported.__conetWsWrapped)
        return exported;
    const Client = disabledCtor('WebSocket');
    copyStatic(exported, Client);
    const Server = disabledCtor('WebSocketServer');
    const rec = Client;
    rec.WebSocket = Client;
    rec.Server = Server;
    rec.WebSocketServer = Server;
    rec.createWebSocketStream = disabledCtor('createWebSocketStream');
    Client.__conetWsWrapped = true;
    return Client;
}
function poisonProviderExports(loaded) {
    if (!loaded || (typeof loaded !== 'object' && typeof loaded !== 'function'))
        return;
    const exp = loaded;
    for (const name of ['WebSocketProvider', 'InfuraWebSocketProvider']) {
        const current = exp[name];
        if (typeof current !== 'function')
            continue;
        if (current.__conetWsWrapped)
            continue;
        exp[name] = disabledCtor(name);
    }
}
function replaceCached(loaded, wrapped) {
    for (const record of Object.values(hooks._cache)) {
        if (record && record.exports === loaded)
            record.exports = wrapped;
    }
}
function isWsRequest(request) {
    return request === 'ws' || request.startsWith('ws/');
}
function resolvedFilename(request, parent) {
    try {
        const resolved = node_module_1.default._resolveFilename(request, parent, false);
        return typeof resolved === 'string' ? resolved : undefined;
    }
    catch {
        return undefined;
    }
}
function wsPackageKind(filename) {
    const norm = filename.replace(/\\/g, '/');
    if (!/\/node_modules\/ws\//.test(norm))
        return undefined;
    if (norm.endsWith('/ws/lib/websocket-server.js'))
        return 'server';
    if (norm.endsWith('/ws/lib/websocket.js'))
        return 'client';
    if (norm.endsWith('/ws/lib/stream.js'))
        return 'stream';
    if (norm.endsWith('/ws/index.js') || norm.endsWith('/ws/browser.js'))
        return 'bundle';
    return undefined;
}
function isEthersWebsocketModule(request) {
    return request.includes('provider-websocket') || request.includes('provider-infura') || request === 'ethers' || /(^|\/)ethers(\.js)?$/.test(request);
}
function headerValue(value) {
    if (Array.isArray(value))
        return value.map((item) => String(item)).join(',');
    if (value === undefined || value === null)
        return '';
    return String(value);
}
function headerPairIsUpgrade(name, value) {
    return typeof name === 'string' && name.toLowerCase() === 'upgrade' && headerValue(value).toLowerCase().includes('websocket');
}
function hasUpgrade(headers) {
    if (!headers)
        return false;
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        const value = headers.get('upgrade');
        return !!value && value.toLowerCase().includes('websocket');
    }
    if (Array.isArray(headers)) {
        for (let i = 0; i < headers.length; i++) {
            const item = headers[i];
            if (Array.isArray(item)) {
                if (headerPairIsUpgrade(item[0], item[1]))
                    return true;
                continue;
            }
            // Node also accepts a flat list: ["Upgrade", "websocket", "Connection", "Upgrade"].
            if (headerPairIsUpgrade(item, headers[i + 1]))
                return true;
        }
        return false;
    }
    if (typeof headers === 'object') {
        for (const [key, value] of Object.entries(headers)) {
            if (headerPairIsUpgrade(key, value))
                return true;
        }
    }
    return false;
}
function assertNoWebSocketRequest(args) {
    for (const arg of args) {
        if (typeof arg === 'string') {
            if (/^wss?:\/\//i.test(arg))
                throw disabledError('ws-url');
            continue;
        }
        if (arg instanceof URL) {
            if (arg.protocol === 'ws:' || arg.protocol === 'wss:')
                throw disabledError('ws-url');
            continue;
        }
        if (!arg || typeof arg !== 'object')
            continue;
        const rec = arg;
        if (typeof rec.protocol === 'string' && /^wss?:$/i.test(rec.protocol))
            throw disabledError('ws-url');
        if (typeof rec.href === 'string' && /^wss?:\/\//i.test(rec.href))
            throw disabledError('ws-url');
        if (hasUpgrade(rec.headers))
            throw disabledError('Upgrade');
    }
}
function installRequestGuard(mod) {
    const origRequest = mod.request;
    const origGet = mod.get;
    mod.request = function request(...args) {
        assertNoWebSocketRequest(args);
        return origRequest.apply(this, args);
    };
    mod.get = function get(...args) {
        assertNoWebSocketRequest(args);
        return origGet.apply(this, args);
    };
}
const UPGRADE_LISTENER_METHODS = ['on', 'addListener', 'prependListener', 'once', 'prependOnceListener'];
function isUpgradeEvent(event) {
    return typeof event === 'string' && event.toLowerCase() === 'upgrade';
}
function guardServerPrototype(proto) {
    if (!proto)
        return;
    const marked = proto;
    if (marked.__conetServerGuarded)
        return;
    marked.__conetServerGuarded = true;
    const host = proto;
    for (const name of UPGRADE_LISTENER_METHODS) {
        const current = host[name];
        if (typeof current !== 'function' || current.__conetWsWrapped)
            continue;
        const orig = current;
        const wrapped = function (event, listener, ...rest) {
            if (isUpgradeEvent(event))
                throw disabledError('upgrade-listener');
            return orig.call(this, event, listener, ...rest);
        };
        wrapped.__conetWsWrapped = true;
        host[name] = wrapped;
    }
    const emit = host.emit;
    if (typeof emit === 'function' && !emit.__conetWsWrapped) {
        const origEmit = emit;
        const wrappedEmit = function (event, ...args) {
            if (isUpgradeEvent(event)) {
                const socket = args[1];
                if (socket && typeof socket.destroy === 'function') {
                    try {
                        socket.destroy();
                    }
                    catch {
                        /* already closed */
                    }
                }
                throw disabledError('inbound-upgrade');
            }
            return origEmit.call(this, event, ...args);
        };
        wrappedEmit.__conetWsWrapped = true;
        host.emit = wrappedEmit;
    }
}
function wrapCreateServer(mod) {
    const rec = mod;
    const orig = rec.createServer;
    if (typeof orig !== 'function' || orig.__conetWsWrapped)
        return;
    const wrapped = function createServer(...args) {
        const server = orig.apply(this, args);
        if (server && typeof server === 'object')
            guardServerPrototype(Object.getPrototypeOf(server));
        return server;
    };
    wrapped.__conetWsWrapped = true;
    rec.createServer = wrapped;
}
function installServerGuard() {
    guardServerPrototype(node_http_1.default.Server.prototype);
    guardServerPrototype(node_https_1.default.Server.prototype);
    wrapCreateServer(node_http_1.default);
    wrapCreateServer(node_https_1.default);
}
function installFetchGuard() {
    const current = globalThis.fetch;
    if (typeof current !== 'function')
        return;
    if (current.__conetWsWrapped)
        return;
    const orig = current;
    const wrapped = function fetch(input, init) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input instanceof Request ? input.url : '';
        if (/^wss?:\/\//i.test(url))
            throw disabledError('fetch-ws');
        if (hasUpgrade(init?.headers))
            throw disabledError('Upgrade');
        return orig(input, init);
    };
    wrapped.__conetWsWrapped = true;
    globalThis.fetch = wrapped;
}
function installGlobalWebSocket() {
    const ctor = disabledCtor('WebSocket');
    try {
        Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: ctor });
    }
    catch {
        ;
        globalThis.WebSocket = ctor;
    }
}
function stubSource(kind) {
    const label = kind === 'server' ? 'WebSocketServer' : kind === 'stream' ? 'createWebSocketStream' : 'WebSocket';
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
`;
    }
    return `'use strict';
function Disabled() {
	const error = new Error('WebSocket functionality is disabled: ${label}');
	error.name = 'WebSocketDisabled';
	throw error;
}
Disabled.__conetWsWrapped = true;
module.exports = Disabled;
`;
}
function installCompileHook() {
    const proto = node_module_1.default.prototype;
    const orig = proto._compile;
    if (!orig || orig.__conetWsWrapped)
        return;
    const wrapped = function compile(content, filename) {
        const kind = wsPackageKind(filename);
        if (kind)
            return orig.call(this, stubSource(kind), filename);
        return orig.call(this, content, filename);
    };
    wrapped.__conetWsWrapped = true;
    proto._compile = wrapped;
}
function installModuleHook() {
    if (hooks._load.__conetWsWrapped)
        return;
    const orig = hooks._load;
    const wrapped = function load(request, parent, isMain) {
        const filename = resolvedFilename(request, parent);
        const kind = filename ? wsPackageKind(filename) : undefined;
        const loaded = orig.call(this, request, parent, isMain);
        if (kind === 'bundle' || isWsRequest(request)) {
            const next = wrapWsExport(loaded);
            if (next !== loaded)
                replaceCached(loaded, next);
            return next;
        }
        if (kind === 'client' || kind === 'server' || kind === 'stream') {
            if (typeof loaded === 'function' && loaded.__conetWsWrapped)
                return loaded;
            const next = disabledCtor(kind === 'server' ? 'WebSocketServer' : kind === 'stream' ? 'createWebSocketStream' : 'WebSocket');
            if (next !== loaded)
                replaceCached(loaded, next);
            return next;
        }
        if (isEthersWebsocketModule(request))
            poisonProviderExports(loaded);
        return loaded;
    };
    wrapped.__conetWsWrapped = true;
    hooks._load = wrapped;
}
function installWebSocketBan() {
    const flag = globalThis;
    if (flag.__conetWebSocketBan)
        return;
    flag.__conetWebSocketBan = true;
    installGlobalWebSocket();
    installCompileHook();
    installModuleHook();
    installRequestGuard(node_http_1.default);
    installRequestGuard(node_https_1.default);
    installServerGuard();
    installFetchGuard();
}
installWebSocketBan();
