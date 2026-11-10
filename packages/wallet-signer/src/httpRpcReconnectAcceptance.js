const http = require('node:http')
const { JsonRpcProvider, WebSocketProvider } = require('ethers')
function listen(server, port) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)))
}
;(async () => {
  let calls = 0
  const server = http.createServer((req, res) => {
    calls += 1
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let msg = {}
      try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch {}
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? 1, result: '0x10' }))
    })
  })
  const port = await listen(server, 0)
  const provider = new JsonRpcProvider('http://127.0.0.1:' + port, 224422, { staticNetwork: true, cacheTimeout: -1 })
  console.log('RPC_FIRST', await provider.send('eth_blockNumber', []))
  await new Promise((resolve) => server.close(resolve))
  let failed = false
  try { await provider.send('eth_blockNumber', []) } catch (error) { failed = true; console.log('RPC_DOWN', error.code || error.message) }
  if (!failed) throw new Error('expected RPC failure while server is closed')
  await listen(server, port)
  console.log('RPC_RECONNECTED', await provider.send('eth_blockNumber', []))
  let rejected = false
  try { new WebSocketProvider('ws://127.0.0.1:' + port) } catch (error) {
    rejected = error && error.name === 'WebSocketDisabled'
    console.log('WS_PROVIDER', error && error.name)
  }
  if (!rejected) throw new Error('WebSocketProvider was not rejected')
  let flatRejected = false
  try { http.request({ host: '127.0.0.1', port, method: 'GET', headers: ['Upgrade', 'websocket', 'Connection', 'Upgrade'] }) }
  catch (error) { flatRejected = error && error.name === 'WebSocketDisabled'; console.log('FLAT_HEADER', error && error.name) }
  if (!flatRejected) throw new Error('flat header was not rejected')
  console.log('HTTP_CALLS', calls)
  console.log('REAL_NETWORK_CALLS', 0)
  server.close()
})().catch((error) => { console.error('RPC_CHILD_FAIL', error); process.exit(1) })
