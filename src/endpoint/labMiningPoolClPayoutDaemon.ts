import Colors from 'colors/safe'
import { logger } from '../logger'
import {
	flushLabMiningPoolListeningCheckpoint,
	startValidatorLabMiningPoolClPayoutReporter,
	stopValidatorLabMiningPoolClPayoutReporter,
	waitForLabMiningPoolClPayoutIdle,
} from './validatorLabMiningPoolClPayoutReporter'
import { waitForAllOnchainTxQueues } from '../onchainTxSerialQueue'

/**
 * Standalone daemon: Lab manual staking CL skim → ConetLabMiningPool via Redeem.withdrawNative(admin).
 * Run on ONE ops host with EL RPC + beacon REST (default http://127.0.0.1:4100).
 * Do not run alongside guardian CL payout for the same withdrawal keys — Lab path skips guardianId > 0.
 */
logger(Colors.cyan('[labMiningPoolClPayoutDaemon] starting'))
startValidatorLabMiningPoolClPayoutReporter()

let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return
	shuttingDown = true
	logger(Colors.yellow(`[labMiningPoolClPayoutDaemon] ${signal}; draining payout queue…`))
	stopValidatorLabMiningPoolClPayoutReporter()
	await waitForLabMiningPoolClPayoutIdle()
	await flushLabMiningPoolListeningCheckpoint()
	await waitForAllOnchainTxQueues()
	process.exit(0)
}

process.on('SIGINT', () => {
	void shutdown('SIGINT')
})
process.on('SIGTERM', () => {
	void shutdown('SIGTERM')
})
