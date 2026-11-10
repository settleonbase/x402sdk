import './noWebSocket'
import { readFileSync } from 'node:fs'
import { ORACLE_SOCKET_PATH } from './constants'
import { fetchPublicQuote, nodeHttpGet, type HttpGet } from './publicQuotes'
import { renderOutcome, runOnce, type QuoteSender } from './runOnce'
import { signerSendOnce } from './signerRpc'

type Io = {
	log: (line: string) => void
	error: (line: string) => void
}

export type ExecuteInput = {
	lockFile: string
	socketPath?: string
	fxUrl?: string
	ethUrl?: string
	caFile?: string
	/** Called after each attempt's responses arrive. Not sampled before GET. */
	now?: () => number
	maxAttempts?: number
	retryDelayMs?: number
	timeoutMs?: number
	send?: QuoteSender
	get?: HttpGet
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

export function parseArgv(argv: string[]): {
	lockFile: string
	socketPath: string
	fxUrl?: string
	ethUrl?: string
	caFile?: string
	maxAttempts?: number
} {
	if (argv.includes('--quote-file')) {
		throw new Error('a quote file is not a source; this process fetches public rates')
	}
	const lockFile = flag(argv, '--lock-file')
	if (!lockFile) throw new Error('missing --lock-file')
	const attempts = flag(argv, '--max-attempts')
	return {
		lockFile,
		socketPath: flag(argv, '--socket') ?? ORACLE_SOCKET_PATH,
		fxUrl: flag(argv, '--fx-url'),
		ethUrl: flag(argv, '--eth-url'),
		caFile: flag(argv, '--ca-file'),
		maxAttempts: attempts ? Number(attempts) : undefined,
	}
}

/** Fetch public rates, then one signature attempt. Locked does not retry. */
export async function execute(input: ExecuteInput): Promise<number> {
	const io = input.io ?? { log: console.log, error: console.error }
	const env = input.env ?? process.env
	const configuredChain = env.CONET_ORACLE_CHAIN_ID?.trim()
	if (configuredChain && configuredChain !== '224422') {
		io.error(`refused: chain: CONET_ORACLE_CHAIN_ID=${configuredChain}`)
		return 1
	}
	const ca = input.caFile ? readFileSync(input.caFile) : undefined
	const get = input.get ?? nodeHttpGet(ca)
	const send = input.send ?? ((tx) => signerSendOnce(tx, input.socketPath ?? ORACLE_SOCKET_PATH))
	const outcome = await runOnce({
		lockPath: input.lockFile,
		send,
		loadQuote: async () => {
			const fetched = await fetchPublicQuote({
				now: input.now,
				fxUrl: input.fxUrl,
				ethUrl: input.ethUrl,
				timeoutMs: input.timeoutMs,
				maxAttempts: input.maxAttempts,
				retryDelayMs: input.retryDelayMs,
				get,
			})
			io.log(`fetched observedAt=${new Date(fetched.quote.observedAtMs).toISOString()} attempts=${fetched.attempts}`)
			return fetched.quote
		},
	})
	const view = renderOutcome(outcome)
	if (view.exitCode === 0) io.log(view.line)
	else io.error(view.line)
	return view.exitCode
}

async function cli(): Promise<void> {
	try {
		const args = parseArgv(process.argv.slice(2))
		const code = await execute(args)
		process.exitCode = code
	} catch (e) {
		const message = e instanceof Error ? e.message : 'quote failed'
		console.error(`refused: arguments: ${message}`)
		process.exitCode = 1
	}
}

if (require.main === module) void cli()
