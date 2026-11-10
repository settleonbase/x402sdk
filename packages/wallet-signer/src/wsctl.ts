#!/usr/bin/env node
/**
 * wsctl — admin CLI for wallet-signer. Run on the signer host after SSH login, as a member of the
 * wsadmin group. Passwords and mnemonic words are read from /dev/tty with echo off: never from
 * argv or environment. `--password-stdin` exists for automation/tests only.
 */
import { openSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { connect } from 'node:net'
import { ReadStream, WriteStream } from 'node:tty'
import { randomInt } from 'node:crypto'
import { assertDataMount, loadConfig, paths } from './config'
import { isValidMnemonic, mnemonicToEntropyBytes, newMnemonic } from './hd'
import { createVaultJson, openVault } from './vault'

const argv = process.argv.slice(2)
function flag(name: string): boolean {
	const i = argv.indexOf(name)
	if (i >= 0) argv.splice(i, 1)
	return i >= 0
}
function opt(name: string): string | undefined {
	const i = argv.indexOf(name)
	if (i < 0) return undefined
	const v = argv[i + 1]
	argv.splice(i, 2)
	return v
}

const configPath = opt('--config') ?? process.env.WALLET_SIGNER_CONFIG ?? '/etc/wallet-signer/config.json'
const passwordStdin = flag('--password-stdin')

function tty(): { input: ReadStream; output: WriteStream } {
	const fd = openSync('/dev/tty', 'r+')
	return { input: new ReadStream(fd), output: new WriteStream(fd) }
}

/** Reads one line from the terminal with echo off. */
function readHidden(prompt: string): Promise<string> {
	const { input, output } = tty()
	output.write(prompt)
	input.setRawMode(true)
	input.setEncoding('utf8')
	return new Promise((resolve, reject) => {
		let value = ''
		const onData = (s: string) => {
			for (const ch of s) {
				if (ch === '\r' || ch === '\n') {
					input.setRawMode(false)
					input.removeListener('data', onData)
					input.destroy()
					output.write('\n')
					output.destroy()
					return resolve(value)
				}
				if (ch === '\u0003') {
					input.setRawMode(false)
					input.destroy()
					output.write('\n')
					return reject(new Error('cancelled'))
				}
				if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
				else value += ch
			}
		}
		input.on('data', onData)
	})
}

function ttyWrite(text: string): void {
	const { output, input } = tty()
	output.write(text)
	output.destroy()
	input.destroy()
}

async function readStdinLine(): Promise<string> {
	const chunks: Buffer[] = []
	for await (const c of process.stdin) chunks.push(c as Buffer)
	return Buffer.concat(chunks).toString('utf8').split('\n')[0]!.replace(/\r$/, '')
}

async function readPassword(prompt: string): Promise<string> {
	return passwordStdin ? readStdinLine() : readHidden(prompt)
}

function admin(socketPath: string, cmd: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; result?: unknown; error?: string; code?: number; data?: unknown }> {
	return new Promise((resolve, reject) => {
		const sock = connect(socketPath)
		let buf = ''
		sock.setEncoding('utf8')
		sock.on('connect', () => sock.write(`${JSON.stringify({ cmd, args })}\n`))
		sock.on('data', (d: string) => {
			buf += d
			const nl = buf.indexOf('\n')
			if (nl >= 0) {
				sock.end()
				resolve(JSON.parse(buf.slice(0, nl)))
			}
		})
		sock.on('error', reject)
	})
}

function print(v: unknown): void {
	process.stdout.write(`${JSON.stringify(v, null, 2)}\n`)
}

async function cmdInit(): Promise<void> {
	const cfg = loadConfig(configPath)
	// Never write a vault to the root disk because the encrypted volume is not mounted yet.
	assertDataMount(cfg)
	const vaultPath = paths(cfg).vault
	if (existsSync(vaultPath)) throw new Error(`vault already exists at ${vaultPath}; refusing to overwrite`)
	const unsafe = flag('--unsafe-test-init')
	const restore = flag('--restore')
	let phrase: string
	if (unsafe) {
		if (!cfg.allowUnsafeTestInit) throw new Error('--unsafe-test-init needs allowUnsafeTestInit in config (tests only)')
		phrase = newMnemonic()
		process.stderr.write('WARNING: test vault, mnemonic never shown and not recoverable\n')
	} else if (restore) {
		phrase = (await readHidden('Enter the 24 words separated by spaces (hidden): ')).trim().toLowerCase().replace(/\s+/g, ' ')
		if (!isValidMnemonic(phrase)) throw new Error('invalid mnemonic')
	} else {
		phrase = newMnemonic()
		const words = phrase.split(' ')
		const lines = words.map((w, i) => `${String(i + 1).padStart(2, ' ')}. ${w}`)
		const cols = [lines.slice(0, 8), lines.slice(8, 16), lines.slice(16, 24)]
		let table = ''
		for (let r = 0; r < 8; r++) table += cols.map((c) => (c[r] ?? '').padEnd(20)).join('') + '\n'
		ttyWrite(`\nWrite these 24 words on paper. They are shown once and never stored in clear.\n\n${table}\n`)
		await readHidden('Press Enter when written down (the screen will be cleared)...')
		ttyWrite('\x1b[2J\x1b[3J\x1b[H')
		const picks = new Set<number>()
		while (picks.size < 3) picks.add(randomInt(0, 24))
		for (const i of [...picks].sort((a, b) => a - b)) {
			const w = (await readHidden(`Word #${i + 1}: `)).trim().toLowerCase()
			if (w !== words[i]) throw new Error('word check failed; nothing written, run init again')
		}
	}
	let password: string
	if (passwordStdin) password = await readStdinLine()
	else {
		password = await readHidden('New vault password (min 12 chars, hidden): ')
		const again = await readHidden('Repeat password: ')
		if (again !== password) throw new Error('passwords differ')
	}
	const entropy = mnemonicToEntropyBytes(phrase)
	phrase = ''
	const json = await createVaultJson(entropy, password, cfg.scryptN)
	entropy.fill(0)
	writeFileSync(vaultPath, json, { mode: 0o600, flag: 'wx' })
	const address = JSON.parse(json).address as string
	print({ vault: vaultPath, pm: `0x${address.replace(/^0x/, '')}`, scryptN: cfg.scryptN, next: 'start the service and run: wsctl unlock' })
}

async function cmdVerifyVault(): Promise<void> {
	const cfg = loadConfig(configPath)
	const json = readFileSync(paths(cfg).vault, 'utf8')
	const pw = await readPassword('Vault password (hidden): ')
	const v = await openVault(json, pw)
	v.entropy.fill(0)
	print({ ok: true, pm: v.pmAddress })
}

async function main(): Promise<void> {
	const socketOverride = opt('--socket')
	const sock = () => socketOverride ?? loadConfig(configPath).adminSocket
	const [cmd, sub, ...rest] = argv
	const call = async (c: string, args: Record<string, unknown> = {}) => {
		const r = await admin(sock(), c, args)
		if (!r.ok) {
			process.stderr.write(`error ${r.code ?? ''}: ${r.error}\n`)
			if (r.data) print(r.data)
			process.exitCode = 1
			return
		}
		print(r.result)
	}
	switch (cmd) {
		case 'init':
			return cmdInit()
		case 'verify-vault':
			return cmdVerifyVault()
		case 'status':
			return call('status')
		case 'unlock': {
			const password = await readPassword('Vault password (hidden): ')
			return call('unlock', { password })
		}
		case 'lock':
			return call('lock')
		case 'array': {
			if (sub === 'list' || !sub) return call('array.list')
			const name = rest[0]
			if (!name) throw new Error('array name required')
			if (sub === 'add') {
				const count = Number(opt('--count') ?? 1)
				const chains = (opt('--chains') ?? '224422').split(',').map(Number)
				return call('array.add', { name, count, chains })
			}
			if (sub === 'grow') return call('array.grow', { name, count: Number(opt('--count')) })
			if (sub === 'rotate') return call('array.rotate', { name })
			throw new Error(`unknown array command ${sub}`)
		}
		case 'policy':
			return call('policy.reload')
		case 'client':
			if (!rest[0] && !sub) throw new Error('client disable|enable <name>')
			return call(sub === 'enable' ? 'client.enable' : 'client.disable', { name: rest[0] })
		case 'gas':
			return call(sub === 'run' ? 'gas.run' : 'gas.status')
		case 'tx':
			return call('tx.list', { limit: Number(opt('--limit') ?? 20) })
		case 'compromised':
			return call('compromised.list')
		default:
			process.stdout.write(
				[
					'usage: wsctl [--config path] <command>',
					'  init [--restore]              create the vault (shows 24 words once)',
					'  verify-vault                  offline: decrypt vault, print PM address',
					'  status | unlock | lock',
					'  array list | add <name> --count N --chains 224422 | grow <name> --count N | rotate <name>',
					'  policy reload | client disable|enable <name>',
					'  gas status | gas run | tx list [--limit N] | compromised',
					'',
				].join('\n'),
			)
	}
}

main().catch((e: unknown) => {
	process.stderr.write(`wsctl: ${e instanceof Error ? e.message : String(e)}\n`)
	process.exit(1)
})
