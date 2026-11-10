import { readFileSync } from 'node:fs'
import { ORACLE_SOCKET_PATH } from './constants'
import { renderOutcome, runOnce, type QuoteSender } from './runOnce'
import { signerSendOnce } from './signerRpc'

type Io = {
	log: (line: string) => void
	error: (line: string) => void
}

export type ExecuteInput = {
	quoteFile: string
	socketPath?: string
	lockFile: string
	nowMs?: number
	send?: QuoteSender
	env?: NodeJS.ProcessEnv
	io?: Io
}

function flag(argv: string[], name: string): string | undefined {
	const index = argv.indexOf(name)
	if (index < 0) return undefined
	const value = argv[index + 1]
	if (!value || value.startsWith('--')) return undefined
	return value
}

export function parseArgv(argv: string[]): { quoteFile: string; socketPath: string; lockFile: string } {
	const quoteFile = flag(argv, '--quote-file')
	const lockFile = flag(argv, '--lock-file')
	if (!quoteFile) throw new Error('missing --quote-file')
	if (!lockFile) throw new Error('missing --lock-file')
	return {
		quoteFile,
		lockFile,
		socketPath: flag(argv, '--socket') ?? ORACLE_SOCKET_PATH,
	}
}

/** One process, one attempt. Exit non-zero when the signer or the source refuses. */
export async function execute(input: ExecuteInput): Promise<number> {
	const io = input.io ?? { log: console.log, error: console.error }
	const env = input.env ?? process.env
	const configuredChain = env.CONET_ORACLE_CHAIN_ID?.trim()
	if (configuredChain && configuredChain !== '224422') {
		io.error(`refused: chain: CONET_ORACLE_CHAIN_ID=${configuredChain}`)
		return 1
	}
	let document: unknown
	try {
		document = JSON.parse(readFileSync(input.quoteFile, 'utf8')) as unknown
	} catch (e) {
		const message = e instanceof Error ? e.message : 'unreadable quote file'
		io.error(`refused: source: ${message}`)
		return 1
	}
	const send = input.send ?? ((tx) => signerSendOnce(tx, input.socketPath ?? ORACLE_SOCKET_PATH))
	const outcome = await runOnce({
		document,
		nowMs: input.nowMs ?? Date.now(),
		lockPath: input.lockFile,
		send,
	})
	const view = renderOutcome(outcome)
	if (view.exitCode === 0) io.log(view.line)
	else io.error(view.line)
	return view.exitCode
}

async function cli(): Promise<void> {
	try {
		const args = parseArgv(process.argv.slice(2))
		const code = await execute({
			quoteFile: args.quoteFile,
			socketPath: args.socketPath,
			lockFile: args.lockFile,
		})
		process.exitCode = code
	} catch (e) {
		const message = e instanceof Error ? e.message : 'quote failed'
		console.error(`refused: arguments: ${message}`)
		process.exitCode = 1
	}
}

if (require.main === module) void cli()
