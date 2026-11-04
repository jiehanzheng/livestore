import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { declaredCommands } from './qualification-policy.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const spec = JSON.parse(readFileSync(new URL('./tool-profile.json', import.meta.url)))
const run = (command, args, cwd = root, capture = false) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: capture === true ? 'pipe' : 'inherit' })
  if (result.error !== undefined || result.status !== 0)
    throw new Error(`${command} failed: ${result.error ?? result.stderr ?? result.status}`)
  return result.stdout?.trim()
}

if (`${process.platform}-${process.arch}` !== spec.platform)
  throw new Error(`Qualified tool profile supports ${spec.platform}; this platform needs separate qualification`)
if (Number(process.versions.node.split('.')[0]) !== spec.nodeMajor)
  throw new Error(`Node ${spec.nodeMajor} is required`)

const temporary = path.join(root, 'temp_nocommit')
mkdirSync(temporary, { recursive: true })
const ignore = path.join(temporary, '.gitignore')
if (existsSync(ignore) === false) writeFileSync(ignore, '*\n')
// Preserve a user's existing policy rather than silently placing evidence in tracked paths.
run('git', ['check-ignore', '--quiet', 'temp_nocommit/fork-qualification/tools/package.json'])
const evidence = path.join(temporary, 'fork-qualification')
mkdirSync(evidence, { recursive: true })
// pnpm 12 still discovers ancestor workspaces for nested profiles despite --ignore-workspace.
// A separate physical root keeps tool resolution from mutating the SDK materialization.
const profile = path.join(
  tmpdir(),
  `livestore-fork-tools-${createHash('sha256').update(root).update(JSON.stringify(spec)).digest('hex').slice(0, 16)}`,
)
for (let ancestor = path.dirname(profile); ; ancestor = path.dirname(ancestor)) {
  if (existsSync(path.join(ancestor, 'pnpm-workspace.yaml')) === true)
    throw new Error(`Tool profile would inherit workspace ${ancestor}`)
  if (path.dirname(ancestor) === ancestor) break
}
mkdirSync(profile, { recursive: true })
if (existsSync(path.join(profile, 'package.json')) === false) {
  // The initial installer generates hashed launchers too, so it must use the declared pin.
  const initialPnpmVersion = run('pnpm', ['--version'], profile, true)
  if (initialPnpmVersion !== spec.pnpm)
    throw new Error(`Initial pnpm ${spec.pnpm} is required; got ${initialPnpmVersion}`)
  // Bootstrap with an existing package manager before declaring the selected one: declaring it first
  // lets pnpm provision a global tool behind our back instead of the owned dependency below.
  writeFileSync(
    path.join(profile, 'package.json'),
    `${JSON.stringify(
      {
        name: 'livestore-fork-tool-profile',
        private: true,
        type: 'module',
        dependencies: spec.packages,
      },
      null,
      2,
    )}\n`,
  )
  run('pnpm', ['install', '--ignore-scripts', '--store-dir', '.pnpm-store'], profile)
  const selectedPnpm = path.join(profile, 'node_modules/.bin/pnpm')
  if (run(selectedPnpm, ['--version'], profile, true) !== spec.pnpm)
    throw new Error(`Prepared pnpm differs from ${spec.pnpm}`)
  run(selectedPnpm, ['pkg', 'set', `packageManager=pnpm@${spec.pnpm}`], profile)
  run(selectedPnpm, ['install', '--ignore-scripts', '--store-dir', '.pnpm-store'], profile)
}
const pnpm = path.join(profile, 'node_modules/.bin/pnpm')
const manifest = JSON.parse(readFileSync(path.join(profile, 'package.json')))
for (const [name, version] of Object.entries(spec.packages)) {
  if (manifest.dependencies?.[name] !== version) throw new Error(`Tool profile differs: ${name}`)
}
run(
  pnpm,
  [
    'install',
    '--frozen-lockfile',
    '--ignore-scripts',
    '--store-dir',
    '.pnpm-store',
    '--config.verify-store-integrity=true',
    '--config.strict-store-pkg-content-check=true',
  ],
  profile,
)

const artifacts = path.join(profile, '.canonical-genie')
mkdirSync(artifacts, { recursive: true })
for (const artifact of spec.artifacts) {
  const target = path.join(artifacts, artifact.file)
  if (existsSync(target) === false) {
    const response = await fetch(artifact.url)
    if (response.ok === false) throw new Error(`Artifact download failed: ${response.status} ${artifact.name}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length !== artifact.bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
      throw new Error(`Artifact integrity failed: ${artifact.name}`)
    writeFileSync(`${target}.download`, bytes)
    renameSync(`${target}.download`, target)
  }
  const bytes = readFileSync(target)
  if (bytes.length !== artifact.bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
    throw new Error(`Artifact integrity failed: ${artifact.name}`)
}
const api = path.join(artifacts, 'typescript-api-server')
const nativeArtifact = spec.artifacts.find((artifact) => artifact.name === 'typescript-api-server')
run('python3', [
  path.join(root, 'scripts/fork-qualification/verify-native-artifact.py'),
  path.join(artifacts, nativeArtifact.file),
  api,
  nativeArtifact.sha256,
])
const bin = path.join(profile, 'node_modules/.bin')
const compiler = run(path.join(bin, 'effect-tsgo'), ['get-exe-path'], profile, true)
const descriptor = {
  profile,
  specSha256: createHash('sha256')
    .update(readFileSync(new URL('./tool-profile.json', import.meta.url)))
    .digest('hex'),
  commands: declaredCommands(profile, spec.packages.typescript),
  environment: {
    GENIE_EXPORT_TYPE_PROOF_COMPILER: compiler,
    GENIE_TYPESCRIPT_API_SERVER: path.join(api, 'bin/typescript-api-server'),
  },
}
writeFileSync(path.join(evidence, 'tools.json'), `${JSON.stringify(descriptor, null, 2)}\n`)
console.log(`Qualified tool inputs prepared at ${profile}; SDK qualification has not run.`)
