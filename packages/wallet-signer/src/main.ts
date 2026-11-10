#!/usr/bin/env node
import './noWebSocket'
import { mkdirSync } from 'node:fs'
import { startAdminServer } from './adminServer'
import { assertDataMount, loadConfig, type Config } from './config'
import { startRpcServers } from './rpcServer'
import { SignerService } from './service'

function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag)
	return i >= 0 ? process.argv[i + 1] : undefined
}

function main(): void {
	const configPath = argValue('--config') ?? process.env.WALLET_SIGNER_CONFIG ?? '/etc/wallet-signer/config.json'
	let config: Config
	try {
		config = loadConfig(configPath)
		assertDataMount(config)
	} catch (e) {
		process.stderr.write(`[wallet-signer] refusing to start: ${e instanceof Error ? e.message : String(e)}\n`)
		process.exit(1)
	}
	mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
	mkdirSync(config.logDir, { recursive: true, mode: 0o700 })
	const svc = new SignerService(config)
	const admin = startAdminServer(svc, config.adminSocket)
	const rpc = startRpcServers(svc, config.rpc)
	svc.start()
	process.stdout.write(`[wallet-signer] started LOCKED; admin=${config.adminSocket} tls=${config.rpc.tls ? `${config.rpc.tls.host}:${config.rpc.tls.port}` : 'off'} proxied=${describeProxied(config.rpc.proxied)}\n`)
	const shutdown = (sig: string) => {
		process.stdout.write(`[wallet-signer] ${sig}: locking and exiting\n`)
		svc.stop()
		admin.close()
		for (const s of rpc) s.close()
		setTimeout(() => process.exit(0), 200).unref()
	}
	process.on('SIGTERM', () => shutdown('SIGTERM'))
	process.on('SIGINT', () => shutdown('SIGINT'))
	process.on('uncaughtException', (e) => {
		process.stderr.write(`[wallet-signer] uncaught: ${e instanceof Error ? e.message : String(e)}\n`)
	})
}

function describeProxied(p: Config['rpc']['proxied']): string {
	if (!p) return 'off'
	return p.path ? `unix:${p.path}` : `${p.host}:${p.port}`
}

main()
