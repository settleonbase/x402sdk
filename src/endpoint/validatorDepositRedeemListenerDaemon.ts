import Colors from 'colors/safe'
import { logger } from '../logger'
import { startValidatorDepositRedeemListener } from './validatorDepositRedeem'

/**
 * Lightweight CoNET validator-node daemon: event listener only (no BeamioCluster / Master / port 2222).
 * Deploy on the validator host that matches targetNodeIp (e.g. 38.102.85.33).
 */
logger(Colors.cyan('[validatorDepositRedeemListenerDaemon] starting'))
startValidatorDepositRedeemListener()

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
