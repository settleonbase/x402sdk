import {startServer} from './beamioServer'
import { cpus } from 'node:os'
import Cluster from 'node:cluster'
import Colors from 'colors/safe'
import { logger } from '../logger'
import startMaster from './beamioMaster'

if (Cluster.isPrimary) {
	const forkWorker = () => {
		
		let numCPUs = cpus().length

		for (let i = 0; i < numCPUs/2; i ++){
			_forkWorker()
		}
	}
	
	const _forkWorker = () => {
		const fork = Cluster.fork ()
		fork.once ('exit', (code: number, signal: string) => {
			logger (Colors.red(`Worker [${ fork.id }] Exit with code[${ code }] signal[${ signal }]!\n Restart after 30 seconds!`))
			
			return setTimeout (() => {
				return _forkWorker ()
			}, 1000 * 10 )
		})
		return (fork)
	}
	forkWorker()

	startMaster()
	
} else {
	startServer()
}
