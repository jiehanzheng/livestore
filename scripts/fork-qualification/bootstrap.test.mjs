import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const directory = path.dirname(fileURLToPath(import.meta.url))
const spec = JSON.parse(fs.readFileSync(path.join(directory, 'tool-profile.json'), 'utf8'))

const usingBootstrap = (version, inspect) => {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'livestore-bootstrap-pin-')))
  try {
    const root = path.join(temporary, 'sdk')
    const scripts = path.join(root, 'scripts/fork-qualification')
    const bin = path.join(temporary, 'bin')
    const log = path.join(temporary, 'commands.jsonl')
    fs.mkdirSync(scripts, { recursive: true })
    fs.mkdirSync(bin)
    for (const name of [
      'bootstrap.mjs',
      'qualification-policy.mjs',
      'upstream-source-inputs.mjs',
      'tool-profile.json',
    ]) {
      fs.copyFileSync(path.join(directory, name), path.join(scripts, name))
    }
    const init = spawnSync('git', ['init', '--quiet', root], { encoding: 'utf8' })
    assert.equal(init.status, 0, init.stderr)
    fs.mkdirSync(path.join(root, 'temp_nocommit'))
    fs.writeFileSync(path.join(root, 'temp_nocommit/.gitignore'), '*\n')
    fs.writeFileSync(
      path.join(bin, 'pnpm'),
      `#!${process.execPath}
import fs from 'node:fs'
const args = process.argv.slice(2)
const manifest = fs.existsSync('package.json') ? JSON.parse(fs.readFileSync('package.json')) : null
fs.appendFileSync(process.env.BOOTSTRAP_PIN_TEST_LOG, JSON.stringify({ args, cwd: process.cwd(), manifest }) + '\\n')
if (args.length === 1 && args[0] === '--version') console.log(process.env.BOOTSTRAP_PIN_TEST_VERSION)
else process.exit(73)
`,
      { mode: 0o755 },
    )
    const profile = path.join(
      temporary,
      `livestore-fork-tools-${createHash('sha256').update(root).update(JSON.stringify(spec)).digest('hex').slice(0, 16)}`,
    )
    const result = spawnSync(process.execPath, [path.join(scripts, 'bootstrap.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        TMPDIR: temporary,
        BOOTSTRAP_PIN_TEST_LOG: log,
        BOOTSTRAP_PIN_TEST_VERSION: version,
      },
    })
    const commands = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
    inspect({ result, commands, profile })
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

test('wrong initial pnpm refuses before manifest creation or any dependency install', () => {
  usingBootstrap('12.4.1', ({ result, commands, profile }) => {
    assert.equal(result.status, 1)
    assert.match(result.stderr, new RegExp(`Initial pnpm ${spec.pnpm} is required; got 12.4.1`))
    assert.deepEqual(
      commands.map((command) => command.args),
      [['--version']],
    )
    assert.equal(commands[0].cwd, profile)
    assert.equal(commands[0].manifest, null)
    assert.equal(fs.existsSync(path.join(profile, 'package.json')), false)
  })
})

test('exact initial pnpm reaches the unchanged normal first install without packageManager dispatch', () => {
  usingBootstrap(spec.pnpm, ({ result, commands, profile }) => {
    // The recording driver stops at install; no dependency or artifact fetch is executed by this test.
    assert.equal(result.status, 1)
    assert.match(result.stderr, /pnpm failed: 73/)
    assert.deepEqual(
      commands.map((command) => command.args),
      [['--version'], ['install', '--ignore-scripts', '--store-dir', '.pnpm-store']],
    )
    assert(commands.every((command) => command.cwd === profile))
    assert.equal(commands[0].manifest, null)
    assert.deepEqual(commands[1].manifest.dependencies, spec.packages)
    assert.equal(commands[1].manifest.packageManager, undefined)
  })
})
