// 测试工具守卫的负例与正例。运行：node --test guard.test.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const g = require('./guard.cjs')

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'beamio-guard-test-'))

test('negative: HOME outside os.tmpdir() is refused', () => {
  assert.throws(() => g.assertTestHome('/Users'), /not under os.tmpdir|lacks marker/)
  const notCreated = path.join(os.homedir(), 'should-not-create-' + process.pid)
  assert.throws(() => g.initTestHome(notCreated), /not under os.tmpdir/)
  assert.equal(fs.existsSync(notCreated), false, 'refused HOME must not be created')
})

test('negative: HOME under tmp without marker is refused by launcher check', () => {
  const d = tmpRoot()
  assert.throws(() => g.assertTestHome(d), /lacks marker/)
})

test('negative: non-empty HOME without marker is refused by init', () => {
  const d = tmpRoot()
  fs.writeFileSync(path.join(d, 'real-data.txt'), 'x')
  assert.throws(() => g.initTestHome(d), /non-empty HOME without marker/)
})

test('positive: init creates marker in an empty tmp HOME; launcher check then passes', () => {
  const d = tmpRoot()
  const real = g.initTestHome(d)
  assert.ok(fs.existsSync(path.join(real, g.MARKER)))
  assert.equal(g.assertTestHome(real), real)
})

test('negative: launcher refuses without BEAMIO_TEST_MODE=1 or with production', () => {
  const saved = { ...process.env }
  try {
    delete process.env.BEAMIO_TEST_MODE
    assert.throws(() => g.assertServiceLaunchAllowed(), /BEAMIO_TEST_MODE must be 1/)
    process.env.BEAMIO_TEST_MODE = '1'; process.env.NODE_ENV = 'production'
    assert.throws(() => g.assertServiceLaunchAllowed(), /NODE_ENV=production/)
    delete process.env.NODE_ENV
    g.assertServiceLaunchAllowed()
  } finally { process.env = saved }
})

test('negative: synthetic config is not overwritten when not written by this tool', () => {
  const d = g.initTestHome(tmpRoot())
  const cfg = path.join(d, '.master.json')
  fs.writeFileSync(cfg, '{"foreign":true}')
  assert.throws(() => g.assertCanWriteSynthConfig(cfg), /not written by this tool/)
})

test('negative: tool-written config changed by someone else is refused', () => {
  const d = g.initTestHome(tmpRoot())
  const cfg = path.join(d, '.master.json')
  fs.writeFileSync(cfg, '{"a":1}')
  g.recordSynthConfig(cfg)
  g.assertCanWriteSynthConfig(cfg)
  fs.writeFileSync(cfg, '{"a":2}')
  assert.throws(() => g.assertCanWriteSynthConfig(cfg), /changed since/)
})

test('child environment is a whitelist: no NODE_ENV, no inherited secrets', () => {
  const saved = { ...process.env }
  try {
    process.env.NODE_ENV = 'production'; process.env.SOME_SECRET = 'x'
    const env = g.minimalChildEnv('/tmp/x')
    assert.equal(env.NODE_ENV, undefined)
    assert.equal(env.SOME_SECRET, undefined)
    assert.equal(env.BEAMIO_TEST_MODE, '1')
  } finally { process.env = saved }
})
