#!/usr/local/bin
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.launchDaemon = void 0;
const server_1 = require("./server");
const yargs = require('yargs');
const argv = yargs(process.argv.slice(2))
    .usage('Usage: yarn run seguro-gateway --port [number] --path [string]')
    .help('h')
    .alias('h', 'help')
    .describe('port', 'Run Seguro Gateway on this port.')
    .describe('path', 'Read worker files on this path.')
    .example('seguro-gateway --port 3001', 'Run Seguro Gateway on PORT 3001')
    .example('seguro-gateway --path ./', 'Read worker files on current directory.')
    .example('seguro-gateway --port 3001 --path ./', 'Read worker files on current directory & run Seguro Gateway on PORT 3001.')
    .check(function (argv) {
    if (argv.port) {
        if (typeof argv.port !== 'number') {
            console.log('Invalid port argument.');
            process.exit(1);
        }
    }
    if (argv.path) {
        if (typeof argv.path !== 'string') {
            console.log('Invalid path argument.');
            process.exit(1);
        }
    }
    return true;
})
    .argv;
let PORT = 3001;
let PATH = __dirname;
const launchDaemon = (port, path) => {
    new server_1.x402Server(port, path);
};
exports.launchDaemon = launchDaemon;
if (argv.port || argv.path) {
    PATH = argv.path;
    if (typeof argv.port === 'number') {
        PORT = argv.port;
    }
    else {
        console.log('Invalid PORT, running on PORT 3001.');
    }
    (0, exports.launchDaemon)(PORT, PATH);
}
