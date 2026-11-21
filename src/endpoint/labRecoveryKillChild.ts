/**
 * Test support for labRecoveryKill.test.ts: the recovery of a state directory in its own process, so the parent can kill -9 it at a chosen moment of the READ phase.
 * Usage: node --import tsx labRecoveryKillChild.ts <stateDir> <readOnly 0|1> <loader stream|whole>
 * Prints "READY" right before the recovery starts and "DONE <pending> <consumed> <replayed>" when it finished.
 */
import { recoverPayoutState } from './labPayoutRecovery'

const [dir, readOnly, loader] = process.argv.slice(2)
if (!dir) throw new Error('usage: labRecoveryKillChild <stateDir> <readOnly> <loader>')
process.stdout.write('READY\n')
const rec = recoverPayoutState(dir, { readOnly: readOnly === '1', loader: loader === 'whole' ? 'whole' : 'stream' })
process.stdout.write(`DONE ${rec.core.pendingSize} ${rec.core.consumedSize} ${rec.replayed}\n`)
