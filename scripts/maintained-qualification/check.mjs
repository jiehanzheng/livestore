import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { digest, hash, sourceState } from '../fork-qualification/qualification-observations.mts'
import { authoredFiles, demos, inspect, readReference } from './contract.mjs'
import { toolEnvironment } from './environment.mjs'

const root = fs.realpathSync(fileURLToPath(new URL('../../', import.meta.url)))
assert.equal(process.argv.length, 3, 'Usage: node scripts/maintained-qualification/check.mjs <lead-reviewed-plan.json>')
const planFile = fs.realpathSync(process.argv[2])
const tools = JSON.parse(fs.readFileSync(path.join(root, 'temp_nocommit/fork-qualification/tools.json')))
const out = path.join(root, `temp_nocommit/maintained-qualification/run-${Date.now()}-${process.pid}`)
assert.equal(fs.readFileSync(path.join(root, 'temp_nocommit/.gitignore'), 'utf8').trim(), '*')
fs.mkdirSync(out, { recursive: true })
const observed = inspect(root, planFile, tools)
const env = toolEnvironment(root, tools, observed.rendererRuntime.root)
const gates = []
const run = (name, command, args, cwd = root) => {
  const log = path.join(out, `${name}.log`),
    fd = fs.openSync(log, 'wx')
  const result = spawnSync(command, args, { cwd, env, stdio: ['ignore', fd, fd] })
  fs.closeSync(fd)
  const gate = {
    name,
    argv: [command, ...args],
    cwd,
    exitCode: result.status,
    signal: result.signal,
    joined: true,
    log: { path: log, sha256: hash(fs.readFileSync(log)) },
  }
  gates.push(gate)
  fs.writeFileSync(path.join(out, 'gates.json'), JSON.stringify(gates, null, 2) + '\n')
  assert(!result.error && result.status === 0, `${name} failed; retained ${log}`)
  console.log(`PASS ${name}`)
}
run('sdk-source-staging-controls', process.execPath, ['--test', 'scripts/standalone/stage-source-directory.test.ts'])
const generator = tools.commands.genie
run('generation-root', generator[0], [...generator.slice(1), '--check', '--cwd', root, '--phase', 'bootstrap'])
for (const area of ['packages', 'tests', 'scripts', 'docs'])
  run(`generation-${area}`, generator[0], [...generator.slice(1), '--check', '--cwd', path.join(root, area)])
run('strict-frozen-install', tools.commands.pnpm[0], ['install', '--frozen-lockfile', '--strict-peer-dependencies'])
const authored = authoredFiles(root, observed.state.tree)
run('source-format', tools.commands.format[0], ['--check', ...authored])
const lint = tools.commands.lint
const compiler = tools.commands.compiler
run('compiler', compiler[0], [
  ...compiler.slice(1),
  '--build',
  '--force',
  '--pretty',
  'false',
  '--listFiles',
  'packages/@local/astro-twoslash-code',
  'packages/@local/astro-tldraw',
  'docs/src/content/_assets/code',
  'docs/src/content/_assets/code/native',
  'scripts/maintained-qualification',
  ...demos.map((name) => `examples/${name}`),
  'examples/cloudflare-todomvc/test',
  'examples/web-email-client/tsconfig.worker.json',
])
const importedCliSources = new Set(
  fs
    .readFileSync(path.join(out, 'compiler.log'), 'utf8')
    .split('\n')
    .filter((file) => file.startsWith(path.join(root, 'scripts/src/'))),
)
for (const entry of ['docs.ts', 'docs-export.ts'])
  assert(
    importedCliSources.has(path.join(root, 'scripts/src/commands', entry)),
    'Owning CLI source missing from compiler program',
  )
run('type-aware-lint', lint[0], [
  ...lint.slice(1),
  '--type-aware',
  '--deny-warnings',
  ...authored.filter((file) => /\.[cm]?[jt]sx?$/.test(file)),
])
run('contract-negative-controls', process.execPath, ['--test', 'scripts/maintained-qualification/contract.test.mjs'])
const vitest = path.join(root, 'node_modules/vitest/vitest.mjs')
for (const [name, config] of [
  ['twoslash', 'packages/@local/astro-twoslash-code/vitest.config.ts'],
  ['tldraw', 'packages/@local/astro-tldraw/vitest.config.ts'],
  ['docs', 'docs/vitest.config.ts'],
  ['email', 'examples/web-email-client/vitest.config.ts'],
  ['linearlite', 'examples/web-linearlite/vitest.config.ts'],
])
  run(`${name}-tests`, process.execPath, [vitest, 'run', '--config', config])
run('intent-layer', process.execPath, [
  vitest,
  'run',
  '--project',
  '@local/tests-package-common',
  'tests/package-common/src/intent-layer/intent-layer.test.ts',
])
run('docs-check', tools.commands.pnpm[0], ['exec', 'astro', 'check'], path.join(root, 'docs'))
// Production rendering and source export are real generation boundaries. Keep a
// full inventory but only the reviewed pages/assets after the normal build joins.
const production = path.join(out, 'docs-production')
run(
  'docs-production',
  tools.commands.pnpm[0],
  ['exec', 'astro', 'build', '--outDir', production],
  path.join(root, 'docs'),
)
const inventory = []
const collect = (directory) => {
  for (const row of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, row.name)
    if (row.isDirectory() === true) collect(file)
    else {
      const stat = fs.lstatSync(file)
      assert(stat.isFile())
      inventory.push({
        path: path.relative(production, file),
        sha256: hash(fs.readFileSync(file)),
        mode: stat.mode & 0o777,
        bytes: stat.size,
      })
    }
  }
}
collect(production)
fs.writeFileSync(path.join(out, 'production-inventory.json'), JSON.stringify(inventory, null, 2) + '\n')
const docs = observed.plan.artifacts.find((row) => row.id === 'docs')
const retained = JSON.parse(readReference(docs.inventory, path.dirname(planFile), new Map())).files
const compact = path.join(out, 'reviewed-docs')
for (const row of retained) {
  const relative = path.relative(fs.realpathSync(docs.root), path.resolve(docs.root, row.path))
  const file = path.join(production, relative),
    destination = path.join(compact, relative)
  assert.equal(hash(fs.readFileSync(file)), row.sha256, `New production page/asset differs: ${relative}`)
  assert.equal(fs.statSync(file).mode & 0o777, row.mode)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(file, destination)
  fs.chmodSync(destination, row.mode)
}
const handles = spawnSync('lsof', ['+D', production], { encoding: 'utf8' })
assert.equal(handles.stdout?.trim() ?? '', '', 'Retain production tree while a reader is active')
fs.rmSync(production, { recursive: true })
run('markdown-export', tools.commands.genie[0], [
  'scripts/src/mono.ts',
  'docs',
  'export-markdown',
  '--workspace-root',
  root,
  '--out',
  path.join(out, 'markdown'),
  '--include-llms',
])
const after = inspect(root, planFile, tools)
assert.deepEqual(after.state.tree, observed.state.tree, 'A check changed authored source')
assert.equal(after.state.indexDigest, observed.state.indexDigest, 'A check changed the index')
for (const [file, sha256] of observed.references) readReference({ path: file, sha256 }, root, new Map())
const result = {
  contract: 'livestore-maintained-qualification-result-v2',
  qualified: true,
  commitEligible: false,
  adopted: false,
  sourceTreeSha256: digest(after.state.tree),
  indexDigest: after.state.indexDigest,
  plan: { path: planFile, sha256: hash(fs.readFileSync(planFile)) },
  gates,
  reused: after.plan.reuse,
  artifacts: after.artifacts,
  standalone: after.standalone,
  inheritedFormatDiagnostics: after.plan.inheritedFormatDiagnostics,
  limits: [
    'Named maintained Node/pnpm scope only.',
    'Cold Nix closure/tool-browser integration, automatic devenv readiness and native setup-trace smoke remain unverified.',
    'No release/native-SQLite rebuild/upstream/Darwin parity, commit or application adoption authority.',
  ],
}
fs.writeFileSync(path.join(out, 'qualification.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
console.log(`Qualified named maintained inputs; final source/index review remains required. ${out}`)
