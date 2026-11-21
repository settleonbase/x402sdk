/** No editor / `sed -i.bak` leftovers in the repository: a labWalRollback.test.ts.bak once slipped into a commit. Checks the tracked files and that .gitignore keeps them out. Skipped when there is no git checkout (clean exports). */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const git = (args: string[]): { ok: boolean; out: string } => {
	const r = spawnSync('git', ['-C', __dirname, ...args], { encoding: 'utf8' })
	return { ok: r.status === 0, out: r.stdout ?? '' }
}

test('no tracked *.bak / *.orig / *.rej file, and .gitignore lists them', { skip: git(['rev-parse', '--show-toplevel']).ok ? false : 'not a git checkout' }, () => {
	const files = git(['ls-files']).out.split('\n').filter(Boolean)
	assert.deepEqual(files.filter((f) => /\.(bak|orig|rej)$/.test(f)), [], 'stray leftover files are tracked')
	const top = git(['rev-parse', '--show-toplevel']).out.trim()
	const ignore = fs.readFileSync(path.join(top, '.gitignore'), 'utf8')
	for (const pat of ['*.bak', '*.orig', '*.rej']) assert.ok(ignore.split('\n').includes(pat), `.gitignore has ${pat}`)
	const probe = spawnSync('git', ['-C', top, 'check-ignore', '-q', 'src/endpoint/example.test.ts.bak'])
	assert.equal(probe.status, 0, 'a .bak file is ignored by git')
})
