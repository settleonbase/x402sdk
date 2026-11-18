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
 * Standalone daemon: Lab manual staking CL skim → LabMiningPoolPayoutExecutor.payout
 * via dedicated unix socket (CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_SOCKET).
 * FORBIDDEN: private-key → VDR.withdrawNative; forbidden sock <claim-payout-socket>.
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
	// Hard bound: stuck tx.wait must not block systemd stop beyond TimeoutStopSec.
	await waitForLabMiningPoolClPayoutIdle(90_000)
	await flushLabMiningPoolListeningCheckpoint()
	await waitForAllOnchainTxQueues(90_000)
	process.exit(0)
}

process.on('SIGINT', () => {
	void shutdown('SIGINT')
})
process.on('SIGTERM', () => {
	void shutdown('SIGTERM')
})
