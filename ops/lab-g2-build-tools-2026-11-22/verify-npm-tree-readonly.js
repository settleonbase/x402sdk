'use strict'
// READ-ONLY check that an installed node_modules matches the lock file it was installed from: no network, no writes, no child processes (only fs reads and a sha256).
// usage: node verify-npm-tree-readonly.js <release dir> <expected sha256 of package-lock.json>
// Compared: (1) package-lock.json hash; (2) node_modules/.package-lock.json (npm's hidden lock of what was really installed) against package-lock.json: every non-optional entry present with the same
// version / resolved / integrity, nothing extra; entries that are optional and absent are only COUNTED (platform-specific packages); (3) the directories really on disk under node_modules (every package.json found by
// walking) against the hidden lock, and each installed version against the lock; (4) the TypeScript compiler: version equals the lock's and the bin link resolves. Exit 0 and last line NPMTREE_OK, or exit 3 and NPMTREE_FAIL.
const fs = require('fs'), path = require('path'), crypto = require('crypto')
const [, , dir, expectLock] = process.argv
if (!dir || !/^[0-9a-f]{64}$/.test(expectLock || '')) { console.error('usage: node verify-npm-tree-readonly.js <release dir> <64-hex sha256 of package-lock.json>'); process.exit(2) }
const problems = []
const bad = (m) => { if (problems.length < 40) problems.push(m); else if (problems.length === 40) problems.push('... (more)'); }
const rd = (p) => fs.readFileSync(p)
const js = (p) => JSON.parse(rd(p).toString('utf8'))
let lock, hidden
try {
  const buf = rd(path.join(dir, 'package-lock.json'))
  const got = crypto.createHash('sha256').update(buf).digest('hex')
  if (got !== expectLock) bad(`package-lock.json sha256 ${got} is not the expected ${expectLock}`)
  lock = JSON.parse(buf.toString('utf8'))
  hidden = js(path.join(dir, 'node_modules', '.package-lock.json'))
} catch (e) { console.log('NPMTREE_FAIL cannot read the lock files: ' + e.message); process.exit(3) }
if (![2, 3].includes(lock.lockfileVersion) || ![2, 3].includes(hidden.lockfileVersion)) bad(`lockfileVersion lock=${lock.lockfileVersion} hidden=${hidden.lockfileVersion}`)
const L = lock.packages || {}, H = hidden.packages || {}
let compared = 0, optionalAbsent = 0, links = 0
for (const [key, e] of Object.entries(L)) {
  if (key === '') continue
  const h = H[key]
  if (e.link) { links++; continue }
  if (!h) { if (e.optional) { optionalAbsent++; continue } bad(`not installed (missing from the hidden lock): ${key}`); continue }
  compared++
  if (e.version !== h.version) bad(`version differs at ${key}: lock ${e.version} installed ${h.version}`)
  if (e.resolved && h.resolved && e.resolved !== h.resolved) bad(`resolved differs at ${key}`)
  if (e.integrity && h.integrity && e.integrity !== h.integrity) bad(`integrity differs at ${key}`)
  if (e.integrity && !h.integrity) bad(`integrity missing in the hidden lock at ${key}`)
}
for (const key of Object.keys(H)) if (!L[key]) bad(`installed but not in the lock: ${key}`)
// what is really on disk
const found = new Map()
function walk(nm, rel) {
  let names
  try { names = fs.readdirSync(nm) } catch { return }
  for (const n of names) {
    if (n.startsWith('.')) continue
    const dirs = n.startsWith('@') ? fs.readdirSync(path.join(nm, n)).filter((x) => !x.startsWith('.')).map((x) => `${n}/${x}`) : [n]
    for (const d of dirs) {
      const key = `${rel}node_modules/${d}`
      const pj = path.join(dir, key, 'package.json')
      let st
      try { st = fs.lstatSync(path.join(dir, key)) } catch { continue }
      if (st.isSymbolicLink()) { found.set(key, { link: true }); continue }
      if (!fs.existsSync(pj)) continue
      let v
      try { v = JSON.parse(rd(pj).toString('utf8')).version } catch { bad(`unreadable package.json at ${key}`); continue }
      found.set(key, { version: v })
      walk(path.join(dir, key, 'node_modules'), `${key}/`)
    }
  }
}
walk(path.join(dir, 'node_modules'), '')
for (const [key, h] of Object.entries(H)) {
  const f = found.get(key)
  if (!f) { if (!h.link) bad(`in the hidden lock but not on disk: ${key}`); continue }
  if (!f.link && h.version && f.version !== h.version) bad(`on-disk version differs at ${key}: hidden lock ${h.version} disk ${f.version}`)
}
for (const key of found.keys()) if (!H[key]) bad(`on disk but not in the hidden lock: ${key}`)
// the compiler
const tsLock = L['node_modules/typescript']
try {
  const tsv = js(path.join(dir, 'node_modules', 'typescript', 'package.json')).version
  if (!tsLock || tsv !== tsLock.version) bad(`typescript on disk ${tsv} differs from the lock ${tsLock && tsLock.version}`)
  const tscReal = fs.realpathSync(path.join(dir, 'node_modules', '.bin', 'tsc'))
  if (!fs.statSync(tscReal).isFile()) bad('node_modules/.bin/tsc does not resolve to a file')
} catch (e) { bad('typescript or its bin link is not usable: ' + e.message) }
console.log(`package-lock sha256 ${crypto.createHash('sha256').update(rd(path.join(dir, 'package-lock.json'))).digest('hex')}; lock entries compared ${compared}, optional-and-absent ${optionalAbsent}, links ${links}; hidden-lock entries ${Object.keys(H).length}; directories found on disk ${found.size}`)
if (problems.length) { for (const p of problems) console.log('PROBLEM ' + p); console.log(`NPMTREE_FAIL ${problems.length}`); process.exit(3) }
console.log('NPMTREE_OK'); process.exit(0)
