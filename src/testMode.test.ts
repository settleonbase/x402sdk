// 测试模式开关的正负例。运行：node --test src/testMode.test.ts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const mod = path.join(here, 'testMode.ts')

const loadWithEnv = (env: Record<string, string | undefined>) => {
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...process.env, ...env })) if (v !== undefined) clean[k] = v
  for (const k of Object.keys(env)) if (env[k] === undefined) delete clean[k]
  return spawnSync(process.execPath, ['--eval', `import(${JSON.stringify(mod)}).then(()=>console.log('LOADED'))`], { env: clean, encoding: 'utf8' })
}

test('negative: BEAMIO_TEST_MODE=1 with NODE_ENV=production refuses to load', () => {
  const r = loadWithEnv({ BEAMIO_TEST_MODE: '1', NODE_ENV: 'production' })
  assert.notEqual(r.status, 0)
  assert.ok(/refusing to start/.test(r.stderr))
  assert.ok(!r.stdout.includes('LOADED'))
})

test('positive: test mode without production loads', () => {
  const r = loadWithEnv({ BEAMIO_TEST_MODE: '1', NODE_ENV: undefined })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(r.stdout.includes('LOADED'))
})

test('default: no test mode, production env loads and defaults apply', () => {
  const r = loadWithEnv({ BEAMIO_TEST_MODE: undefined, NODE_ENV: 'production' })
  assert.equal(r.status, 0, r.stderr)
})

test('resolveDbUrl: default unless test mode and a loopback override', async () => {
  const saved = { ...process.env }
  try {
    const { resolveDbUrl } = await import('./testMode.ts')
    const D = 'postgres://postgres:your_password@127.0.0.1:5432/postgres'
    delete process.env.BEAMIO_TEST_MODE; delete process.env.BEAMIO_TEST_DB_URL
    assert.equal(resolveDbUrl(D), D)
    process.env.BEAMIO_TEST_DB_URL = 'postgres://u:p@127.0.0.1:55432/x'
    assert.equal(resolveDbUrl(D), D, 'override ignored without BEAMIO_TEST_MODE=1')
    process.env.BEAMIO_TEST_MODE = '1'
    assert.equal(resolveDbUrl(D), 'postgres://u:p@127.0.0.1:55432/x')
    process.env.BEAMIO_TEST_DB_URL = 'postgres://u:p@localhost:55432/x'
    assert.equal(resolveDbUrl(D), 'postgres://u:p@localhost:55432/x')
  } finally {
    process.env = saved
  }
})

test('negative: non-loopback DB host is refused in test mode', async () => {
  const saved = { ...process.env }
  try {
    const { resolveDbUrl } = await import('./testMode.ts')
    process.env.BEAMIO_TEST_MODE = '1'
    process.env.BEAMIO_TEST_DB_URL = 'postgres://u:p@db.example.com:5432/x'
    assert.throws(() => resolveDbUrl('postgres://d'), /must be loopback/)
    process.env.BEAMIO_TEST_DB_URL = 'postgres://u:p@10.0.0.5:5432/x'
    assert.throws(() => resolveDbUrl('postgres://d'), /must be loopback/)
    process.env.BEAMIO_TEST_DB_URL = 'not a url'
    assert.throws(() => resolveDbUrl('postgres://d'), /not a valid URL/)
  } finally {
    process.env = saved
  }
})

test('resolveTestPort: default unless test mode and a valid port; invalid ports fall back', async () => {
  const saved = { ...process.env }
  try {
    const { resolveTestPort } = await import('./testMode.ts')
    delete process.env.BEAMIO_TEST_MODE
    process.env.BEAMIO_TEST_MASTER_PORT = '41111'
    assert.equal(resolveTestPort('BEAMIO_TEST_MASTER_PORT', 1111), 1111)
    process.env.BEAMIO_TEST_MODE = '1'
    assert.equal(resolveTestPort('BEAMIO_TEST_MASTER_PORT', 1111), 41111)
    process.env.BEAMIO_TEST_MASTER_PORT = '70000'
    assert.equal(resolveTestPort('BEAMIO_TEST_MASTER_PORT', 1111), 1111)
    process.env.BEAMIO_TEST_MASTER_PORT = 'abc'
    assert.equal(resolveTestPort('BEAMIO_TEST_MASTER_PORT', 1111), 1111)
  } finally {
    process.env = saved
  }
})
