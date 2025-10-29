#!/usr/local/bin
import { x402Server} from './server'

const yargs = require('yargs')

const argv = yargs(process.argv.slice(2))
    .usage('Usage: yarn run x402 --port [number] --path [string]')
    .help('h')
    .alias('h', 'help')
    .describe('port', 'Run x402 on this port.')
    .describe('path', 'Read worker files on this path.')
    .example('x402 --port 3001', 'Run x402 on PORT 3001')
    .example('x402 --path ./', 'Read worker files on current directory.')
    .example('x402 --port 3001 --path ./', 'Read worker files on current directory & run x402 Gateway on PORT 3001.')
    .check(function (argv: any) {
        if (argv.port) {
            if (typeof argv.port !== 'number') {
                console.log('Invalid port argument.')
                process.exit(1)
            }
        }

        if (argv.path) {
            if (typeof argv.path !== 'string') {
                console.log('Invalid path argument.')
                process.exit(1)
            }
        }
        return true;
    })
    .argv

let PORT = 3001
let PATH = __dirname

export const launchDaemon = (port: number, path: string) => {
    new x402Server ( port, path )
}


if (argv.port || argv.path) {
    PATH = argv.path
    if (typeof argv.port === 'number') {
        PORT = argv.port
    } else {
        console.log('Invalid PORT, running on PORT 3001.')
    }
    launchDaemon(PORT, PATH)
}