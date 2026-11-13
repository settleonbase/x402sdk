// 测试专用启动器：加载已编译产物并启动 Master 或 Cluster。配置来自 HOME 重定向后的合成 .master.json。
// 用法：HOME=<隔离目录> node run-isolated-service.cjs <build-out 目录> master|cluster
const path = require('node:path')
const guard = require('./guard.cjs')
guard.assertServiceLaunchAllowed()
guard.assertTestHome(process.env.HOME)
const [buildDir, which] = process.argv.slice(2)
if (which === 'master') {
  const m = require(path.join(buildDir, 'endpoint/beamioMaster.js'))
  ;(m.default || m.startMaster || m)()
} else if (which === 'cluster') {
  const s = require(path.join(buildDir, 'endpoint/beamioServer.js'))
  s.startServer()
} else {
  throw new Error('usage: <build-out> master|cluster')
}
