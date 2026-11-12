import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { fileVector } from '../fork-qualification/qualification-observations.mts'
import { exportSdk, writeSdkExport } from './export-sdk.ts'

test('SDK export preserves modes, rejects an existing output, and removes a failed export', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'livestore-sdk-export-'))
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }))
  const root = path.join(scratch, 'repo')
  const output = path.join(scratch, 'sdk')
  const failedOutput = path.join(scratch, 'failed')
  const name = '@livestore/example'
  const pkg = path.join(root, 'packages', name)
  fs.mkdirSync(pkg, { recursive: true })
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init')
  fs.writeFileSync(path.join(root, '.gitignore'), '/packages/\n')
  git('add', '.gitignore')
  git('-c', 'user.name=SDK export test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Fixture')
  const head = git('rev-parse', 'HEAD')
  fs.writeFileSync(path.join(pkg, 'bin'), 'executable\n')
  fs.chmodSync(path.join(pkg, 'bin'), 0o751)
  fs.writeFileSync(path.join(pkg, 'data'), 'content\n')
  fs.writeFileSync(path.join(pkg, 'excluded'), 'outside the packlist\n')
  const files = fileVector(pkg, ['bin', 'data'])
  const inventory = { packages: [{ name, files }] }

  writeSdkExport({ root, head, output, inventory })
  const exported = path.join(output, 'packages', name)
  assert.deepEqual(fs.readdirSync(exported).sort(), ['bin', 'data'])
  assert.deepEqual(fileVector(exported, ['bin', 'data']), files)
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(output, 'candidate-artifact-inventory.json'), 'utf8')),
    inventory,
  )
  assert.throws(() => writeSdkExport({ root, head, output, inventory }), { code: 'EEXIST' })
  assert.deepEqual(fileVector(exported, ['bin', 'data']), files)

  fs.writeFileSync(path.join(pkg, 'data'), 'changed after selection\n')
  assert.throws(() => writeSdkExport({ root, head, output: failedOutput, inventory }), /file changed/)
  assert.equal(fs.existsSync(failedOutput), false)

  fs.appendFileSync(path.join(root, '.gitignore'), '# changed tracked file\n')
  assert.throws(() => exportSdk(root, failedOutput), /clean Git checkout/)
  assert.equal(fs.existsSync(failedOutput), false)
  git('add', '.gitignore')
  assert.throws(() => exportSdk(root, failedOutput), /clean Git checkout/)
  git('restore', '--source=HEAD', '--staged', '--worktree', '.gitignore')
  git('update-index', '--assume-unchanged', '.gitignore')
  fs.appendFileSync(path.join(root, '.gitignore'), '# hidden change\n')
  assert.throws(() => exportSdk(root, failedOutput), /fully checked-out Git index/)
  git('update-index', '--no-assume-unchanged', '.gitignore')
  git('restore', '.gitignore')
  fs.writeFileSync(path.join(root, 'untracked'), 'dirty\n')
  assert.throws(() => exportSdk(root, failedOutput), /clean Git checkout/)
  assert.equal(fs.existsSync(failedOutput), false)
})
