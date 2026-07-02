import Colors from 'colors/safe'
import { logger } from '../logger'
import { replayValidatorRedeemClaimedEvent } from './validatorDepositRedeem'

const requestId = process.argv[2]?.trim()
if (!requestId) {
	console.error('Usage: node dist/endpoint/replayValidatorRedeemClaimedOnce.js <requestId>')
	process.exit(1)
}

void replayValidatorRedeemClaimedEvent(requestId)
	.then((state) => {
		if (!state) {
			logger(Colors.red('[replayValidatorRedeemClaimedOnce] no state after replay'))
			process.exit(2)
		}
		logger(
			Colors.green(
				`[replayValidatorRedeemClaimedOnce] done status=${state.status} validators=${state.validatorCount} requestId=${state.requestId}`
			)
		)
		process.exit(state.status === 'succeeded' ? 0 : 1)
	})
	.catch((e: unknown) => {
		const msg = e instanceof Error ? e.message : String(e)
		logger(Colors.red('[replayValidatorRedeemClaimedOnce] failed:'), msg)
		process.exit(1)
	})
