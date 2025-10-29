import express from 'express'
import type { Server } from 'node:http'
import { request } from 'node:https'
import type {RequestOptions} from 'node:https'
import { join } from 'node:path'
import Colors from 'colors/safe'
import { inspect } from 'node:util'
import { v4 } from 'uuid'
import {logger} from './logger'

import {ethers} from 'ethers'
import os from 'node:os'
import fs from 'node:fs'


export class x402Server {


    private loginListening: express.Response|null = null
    private localserver: Server
    private connect_peer_pool: any [] = []
    private worker_command_waiting_pool: Map<string, express.Response> = new Map()
    private logStram = ''

    constructor ( private PORT = 3000, private reactBuildFolder: string) {
        this.initialize()
    }

	public end = (): Promise<void> => new Promise(resolve => {
		if (this.localserver) {
			this.localserver.close(err => {
				if (err) {
					logger(Colors.red('Server err:'), err)
				}
			})
		}
		// 即使服务器不存在或关闭出错，也继续执行
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

    private initialize = async () => {
		// --- 关键逻辑开始 ---

		// 1. 定义默认路径（只读的应用包内部）
		const defaultPath = join(__dirname, 'workers')

		// 2. 定义更新路径（可写的 userData 目录内部）
		const userDataPath = this.reactBuildFolder
		const updatedPath = join(userDataPath, 'workers')

		// 3. 检查更新路径是否存在，然后决定使用哪个路径
		//    如果 updatedPath 存在，就用它；否则，回退到 defaultPath。
		let staticFolder = fs.existsSync(updatedPath) ? updatedPath : defaultPath
		logger(`staticFolder = ${staticFolder}`)

		
		// --- 关键逻辑结束 ---

        const app = express()
		const cors = require('cors')

        app.use( cors ())
		app.use ( express.static ( staticFolder ))
        //app.use ( express.static ( launcherFolder ))
        app.use ( express.json() )
		app.use (async (req, res: any, next) => {

			logger(Colors.blue(`${req.url}`))
				
			return next()
			
		})
        app.once ( 'error', ( err: any ) => {
            logger (err)
            logger (`Local server on ERROR, try restart!`)
            return this.initialize ()
        })


        app.post('/connecting', (req: any, res: any) => {

            const headerName=Colors.blue (`Local Server /connecting remoteAddress = ${req.socket?.remoteAddress}`)
            logger(headerName,  inspect(req.body.data, false, 3, true))
            let roop:  NodeJS.Timeout
            if (this.loginListening) {
                logger (`${headerName} Double connecting. drop connecting!`)
                return res.sendStatus(403).end()

            }
            this.loginListening = res
            res.setHeader('Cache-Control', 'no-cache')
            res.setHeader('Content-Type', 'text/event-stream')
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.setHeader('Connection', 'keep-alive')
            res.flushHeaders() // flush the headers to establish SSE with client

            const interValID = () => {

                if (res.closed) {
                    this.loginListening = null
                    return logger (` ${headerName} lost connect! `)
                }

                res.write(`\r\n\r\n`, (err: any) => {
                    if (err) {
                        logger (`${headerName }res.write got Error STOP connecting`, err)
                        res.end()
                        this.loginListening = null
                    }
                    return roop = setTimeout(() => {
                        interValID()
                    }, 10000)
                })
            }

            res.once('close', () => {
                logger(`[${headerName}] Closed`)
                res.end()
                clearTimeout(roop)
                this.loginListening = null
            })

            res.on('error', (err: any) => {
                logger(`[${headerName}] on Error`, err)
            })

            return interValID()

        })





        app.all ('/', (req: any, res: any) => {
			
			return res.status(404).end ()
		})

        this.localserver = app.listen ( this.PORT, () => {
            
			return console.table([
				{ 'x402 Server': `http://localhost:${this.PORT}` },
				{ 'Serving files from': staticFolder } 
			])
        })

        
    }
}
