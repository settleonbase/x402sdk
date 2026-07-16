import Colors from 'colors/safe'
import { logger } from '../logger'
import { startValidatorDepositRedeemListener, stopValidatorDepositRedeemListener, waitForListenerSerialQueue, waitForRunCommandChildren } from './validatorDepositRedeem'
import { startValidatorRewardHourlyReporter, stopValidatorRewardHourlyReporter } from './validatorRewardHourlyReporter'
import {
	startValidatorClRewardPayoutReporter,
	stopValidatorClRewardPayoutReporter,
} from './validatorClRewardPayoutReporter'
import {
	CONET_VALIDATOR_CL_PAYOUT_ONCHAIN_LANE,
	waitForOnchainTxQueue,
} from '../onchainTxSerialQueue'

/**
 * Lightweight CoNET validator-node daemon: event listener + hourly CNET reward reporter
 * + CL skim payout reporter (no BeamioCluster / Master / port 2222). Deploy on the validator host that matches
 * targetNodeIp (e.g. 38.102.85.33) alongside the CoNET-DL / newCoNET Prysm stack.
 */
logger(Colors.cyan('[validatorDepositRedeemListenerDaemon] starting'))
startValidatorDepositRedeemListener()
startValidatorRewardHourlyReporter()
startValidatorClRewardPayoutReporter()

let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return
	shuttingDown = true
	logger(
		Colors.yellow(
			`[validatorDepositRedeemListenerDaemon] ${signal}; waiting for helper scripts (08_import, …) before exit`
		)
	)
	stopValidatorRewardHourlyReporter()
	stopValidatorClRewardPayoutReporter()
	stopValidatorDepositRedeemListener()
	await waitForListenerSerialQueue()
	await waitForOnchainTxQueue(CONET_VALIDATOR_CL_PAYOUT_ONCHAIN_LANE)
	await waitForRunCommandChildren()
	process.exit(0)
}

process.on('SIGINT', () => {
	void shutdown('SIGINT')
})
process.on('SIGTERM', () => {
	void shutdown('SIGTERM')
})
