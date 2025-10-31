import express from 'express'
import type { Server } from 'node:http'
import { request } from 'node:https'
import type {RequestOptions} from 'node:https'
import { join } from 'node:path'
import Colors from 'colors/safe'
import { inspect } from 'node:util'
import {logger} from './logger'

import {ethers} from 'ethers'
import os from 'node:os'
import fs from 'node:fs'
import { paymentMiddleware, Network } from 'x402-express';


const routes =  {
    "/api/weather": {
      price: "$0.001",
      network: "base",
      config: {
        discoverable: true, // make your endpoint discoverable
        description: "SETTLE: MINTS THAT SETTLE_ON BASE",
        inputSchema: {
          queryParams: { 
            location: { 
              type: 'Canada', 
              description: "Toronto", 
              required: true
            }
          }
        },
        outputSchema: {
          type: "object",
          properties: { 
            temperature: { type: "number" },
            conditions: { type: "string" },
            humidity: { type: "number" }
          }
        }
      }
    }
}

const initialize = async (reactBuildFolder: string, PORT: number, serverRoute: (router: any) => void) => {
	console.log('🔧 Initialize called with PORT:', PORT, 'reactBuildFolder:', reactBuildFolder)
	


	const defaultPath = join(__dirname, 'workers')
	console.log('📁 defaultPath:', defaultPath)


	const userDataPath = reactBuildFolder
	const updatedPath = join(userDataPath, 'workers')
	console.log('📁 updatedPath:', updatedPath)


	let staticFolder = fs.existsSync(updatedPath) ? updatedPath : defaultPath
	logger(`staticFolder = ${staticFolder}`)
	console.log('📁 staticFolder:', staticFolder)

	const app = express()
	const cors = require('cors')

	app.use( cors ())
	app.use ( express.static ( staticFolder ))
	app.use ( express.json() )
	app.use (async (req, res: any, next) => {
		logger(Colors.blue(`${req.url}`))
		return next()
	})

	app.use(paymentMiddleware('0x87cAeD4e51C36a2C2ece3Aaf4ddaC9693d2405E1', {"/api/weather": {
      price: "$0.001",
      network: "base",
      config: {
        discoverable: true, // make your endpoint discoverable
        description: "SETTLE: MINTS THAT SETTLE_ON BASE",
        inputSchema: {
          queryParams: {
            
          }
        },
        outputSchema: {
          type: "object",
          properties: { 
            temperature: { type: "number" },
            conditions: { type: "string" },
            humidity: { type: "number" }
          }
        }
      }
    }}))

	const router = express.Router ()

	app.use( '/api', router )
	serverRoute(router)

	app.once ( 'error', ( err: any ) => {
		logger (err)
		logger (`Local server on ERROR, try restart!`)
		return 
	})



	app.all ('/', (req: any, res: any) => {
		return res.status(404).end ()
	})


	console.log('🚀 Starting express.listen on port:', PORT)
	const server = app.listen( PORT, () => {
		console.log('✅ Server started successfully!')
		console.table([
			{ 'x402 Server': `http://localhost:${PORT}`, 'Serving files from': staticFolder }
		])
	})

	server.on('error', (err: any) => {
		console.error('❌ Server error:', err)
	})

	return server
}

export class x402Server {

    private loginListening: express.Response|null = null
    private localserver: Server | null = null
    private connect_peer_pool: any [] = []
    private worker_command_waiting_pool: Map<string, express.Response> = new Map()
    private logStram: any

    constructor ( private PORT = 3000, private reactBuildFolder: string) {
		this.logStram = 
        console.log('🏗️  x402Server constructor called')
    }

	public async start(): Promise<void> {
		console.log('⏳ start() called')
		try {
			this.localserver = await initialize(this.reactBuildFolder, this.PORT, this.router)
			console.log('✨ start() completed successfully')
		} catch (err) {
			console.error('❌ start() error:', err)
			throw err
		}
	}

	public router ( router: express.Router ) {

        router.get('/info', async (req,res) => {
            res.status(200).json({ 'x402 Server': `http://localhost: 4088`, 'Serving files from': '' }).end()
        })

		router.get('/weather', async (req,res) => {
			res.status(200).json({routes}).end()
		})
	}

	public end = (): Promise<void> => new Promise(resolve => {
		if (this.localserver) {
			this.localserver.close(err => {
				if (err) {
					logger(Colors.red('Server err:'), err)
				}
			})
		}
		resolve()
	})

    public postMessageToLocalDevice ( device: string, encryptedMessage: string ) {
        const index = this.connect_peer_pool.findIndex ( n => n.publicKeyID === device )
        if ( index < 0 ) {
            return console.log ( inspect ({ postMessageToLocalDeviceError: `this.connect_peer_pool have no publicKeyID [${ device }]`}, false, 3, true ))
        }
        const ws = this.connect_peer_pool[ index ]
        const sendData = { encryptedMessage: encryptedMessage }
        console.log ( inspect ({ ws_send: sendData}, false, 3, true ))
        return ws.send ( JSON.stringify ( sendData ))
    }
}


console.log('📌 Script started')

;(async () => {
	try {
		console.log('🌍 Creating x402Server instance...')
		const server = new x402Server(4088, '')
		
		console.log('⏳ Calling server.start()...')
		await server.start()
		
		console.log('✅ Server started successfully!')
		
		process.on('SIGINT', async () => {
			logger('Shutting down gracefully...')
			await server.end()
			process.exit(0)
		})
		
		console.log('🎯 Server is now running. Press Ctrl+C to exit.')
		
	} catch (error) {
		logger(Colors.red('Failed to start server:'), error)
		console.error('❌ Error details:', error)
		process.exit(1)
	}
})()

console.log('📌 Script setup completed')