import Colors from 'colors/safe'
import { logger } from '../logger'
import { startValidatorDepositRedeemListener } from './validatorDepositRedeem'
import { startValidatorRewardHourlyReporter, stopValidatorRewardHourlyReporter } from './validatorRewardHourlyReporter'

/**
 * Lightweight CoNET validator-node daemon: event listener + hourly CNET reward reporter
 * (no BeamioCluster / Master / port 2222). Deploy on the validator host that matches
 * targetNodeIp (e.g. 38.102.85.33) alongside the CoNET-DL / newCoNET Prysm stack.
 */
logger(Colors.cyan('[validatorDepositRedeemListenerDaemon] starting'))
startValidatorDepositRedeemListener()
startValidatorRewardHourlyReporter()

function shutdown(): void {
	stopValidatorRewardHourlyReporter()
	process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
