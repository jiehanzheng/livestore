import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncOptions } from 'node:child_process'
import { createHash, type BinaryLike } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { sdkNames, supportPaths } from './qualification-recipe.mts'

export type SourceEntry = {
  path: string
  kind: 'file' | 'symlink'
  executable: boolean
  sha256: string
  target?: string
}
export type SourceChange = SourceEntry | { path: string; kind: 'missing' }
export interface SnapshotEntry {
  path: string
  kind: 'file' | 'symlink'
  mode: number
  sha256: string
  target?: string
}
export interface CompatibilityDescriptor {
  kind: 'file' | 'symlink'
  executable: boolean
  sha256: string
  target?: string
}
export interface CompatibilityChange {
  path: string
  old: CompatibilityDescriptor | null
  current: CompatibilityDescriptor | null
}
export interface PayloadFile {
  path: string
  mode: number
  bytes: number
  sha256: string
}
export interface Tools {
  commands: Record<string, readonly string[]>
  environment: Record<string, string>
}
export type ToolInput =
  | { name: string; sha256: string; mode: number }
  | {
      name: string
      arguments: ({ input: string } | { literal: string })[]
    }
export interface ConsumerNode {
  root: string
  name: string
  dev: boolean
  manifestSha256: string
  edges: { name: string; root: string | null }[]
}
export const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)
export const hash = (value: BinaryLike): string => createHash('sha256').update(value).digest('hex')
export const canonical = (value: unknown): unknown => {
  if (Array.isArray(value) === true) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => compare(a, b))
        .map(([key, item]) => [key, canonical(item)]),
    )
  }
  return value
}
export const digest = (value: unknown): string => {
  const encoded = JSON.stringify(canonical(value))
  assert(encoded !== undefined, 'Missing digest value')
  return hash(encoded)
}
export const relative = (value: string): string => {
  assert(
    typeof value === 'string' && value.length > 0 && path.isAbsolute(value) === false,
    'Expected relative payload path',
  )
  assert(
    !/[\\\0]/.test(value) && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'Escaped payload path',
  )
  return value
}
type GitOptions = Omit<SpawnSyncOptions, 'encoding' | 'cwd'> & { encoding?: 'utf8' | 'buffer' }
export function git(root: string, args: string[], options: GitOptions & { encoding: 'buffer' }): Buffer
export function git(root: string, args: string[], options?: GitOptions & { encoding?: 'utf8' }): string
export function git(root: string, args: string[], options: GitOptions = {}): string | Buffer {
  const { encoding = 'utf8', ...rest } = options
  const result = spawnSync('git', args, { ...rest, cwd: root, encoding: encoding === 'buffer' ? null : 'utf8' })
  assert.equal(result.status, 0, `Git inspection failed: ${args[0]}`)
  if (encoding === 'buffer') {
    assert(Buffer.isBuffer(result.stdout))
    return result.stdout
  }
  assert.equal(typeof result.stdout, 'string')
  return String(result.stdout)
}
const semantic = (root: string, name: string): SourceChange => {
  const file = path.join(root, relative(name))
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })
  if (stat === undefined) return { path: name, kind: 'missing' }
  if (stat.isSymbolicLink() === true) {
    const target = fs.readlinkSync(file)
    assert(fs.realpathSync(file).startsWith(`${fs.realpathSync(root)}${path.sep}`), 'Source symlink escapes repository')
    return { path: name, kind: 'symlink', executable: false, sha256: hash(target), target }
  }
  assert(stat.isFile(), 'Unsupported authored entry')
  return { path: name, kind: 'file', executable: (stat.mode & 0o111) !== 0, sha256: hash(fs.readFileSync(file)) }
}
export const sourceState = (root: string, base: string) => {
  assert.match(base, /^[a-f0-9]{40}$/)
  assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), base, 'Source base changed')
  const names = [
    ...new Set(git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)),
  ].sort(compare)
  const tree = names.map((name) => semantic(root, name)).filter((row): row is SourceEntry => row.kind !== 'missing')
  const changedNames = git(root, ['diff', '--no-ext-diff', '--name-only', '-z', base]).split('\0').filter(Boolean)
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
  const changed = [...new Set([...changedNames, ...untracked])].sort(compare).map((name) => semantic(root, name))
  const staged = git(root, ['diff', '--no-ext-diff', '--cached', '--name-only', '-z', base])
    .split('\0')
    .filter(Boolean)
    .sort(compare)
  const physical = tree.map(({ path: name }) => {
    const stat = fs.lstatSync(path.join(root, name), { bigint: true })
    return [name, String(stat.ino), String(stat.mtimeNs), String(stat.ctimeNs)]
  })
  return {
    tree,
    changed,
    staged,
    indexDigest: hash(git(root, ['ls-files', '--stage', '-z'])),
    physicalDigest: digest(physical),
  }
}
export const sourceCompatibility = (
  root: string,
  tree: readonly SourceEntry[],
  snapshot: readonly SnapshotEntry[],
): CompatibilityChange[] => {
  const before = new Map(
    snapshot.filter((row) => !row.path.startsWith('repos/effect-utils/')).map((row) => [row.path, row]),
  )
  const after = new Map(tree.map((row) => [row.path, row]))
  const oldDescriptor = (row: SnapshotEntry | undefined): CompatibilityDescriptor | null =>
    row === undefined
      ? null
      : {
          kind: row.kind,
          executable: (row.mode & 0o111) !== 0,
          sha256: row.sha256,
          ...(row.kind === 'symlink' && row.target !== undefined ? { target: row.target } : {}),
        }
  const currentDescriptor = (row: SourceEntry | undefined): CompatibilityDescriptor | null => {
    if (row === undefined) return null
    const stat = fs.lstatSync(path.join(root, row.path))
    return {
      kind: row.kind,
      executable: (stat.mode & 0o111) !== 0,
      sha256: hash(fs.readFileSync(path.join(root, row.path))),
      ...(row.kind === 'symlink' && row.target !== undefined ? { target: row.target } : {}),
    }
  }
  return [...new Set([...before.keys(), ...after.keys()])].sort(compare).flatMap((name) => {
    const old = oldDescriptor(before.get(name)),
      current = currentDescriptor(after.get(name))
    return digest(old) === digest(current) ? [] : [{ path: name, old, current }]
  })
}
export const sdkIdentity = (root: string, tree: readonly SourceEntry[]) => {
  const prefixes = sdkNames.map((name) => `packages/${name}/`)
  const row = (name: string) => ({ path: name, sha256: hash(fs.readFileSync(path.join(root, name))) })
  return {
    contract: 'livestore-local-core-candidate-inventory-v1',
    sdkFiles: tree
      .filter((entry) => prefixes.some((prefix) => entry.path.startsWith(prefix)))
      .map((entry) => row(entry.path)),
    supportFiles: supportPaths.map(row),
  }
}
export const fileVector = (root: string, names: readonly string[]): PayloadFile[] =>
  [...names].sort(compare).map((name) => {
    const file = path.join(root, relative(name))
    assert(fs.realpathSync(file).startsWith(`${fs.realpathSync(root)}${path.sep}`), 'Payload escapes owner')
    const stat = fs.lstatSync(file)
    assert(stat.isFile(), 'Payload must be regular files')
    const bytes = fs.readFileSync(file)
    return { path: name, mode: stat.mode & 0o777, bytes: bytes.length, sha256: hash(bytes) }
  })
const record = (value: unknown): Record<string, unknown> => {
  assert(value !== null && typeof value === 'object' && Array.isArray(value) === false, 'Expected JSON object')
  return Object.fromEntries(Object.entries(value))
}
const stringMap = (value: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record(value ?? {})).map(([key, item]) => {
      assert.equal(typeof item, 'string', 'Expected package string field')
      return [key, String(item)]
    }),
  )
export const packageManifest = (root: string) => {
  const pkg = record(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')))
  const metadata = Object.fromEntries(
    Object.entries(record(pkg.peerDependenciesMeta ?? {})).map(([name, value]) => {
      const item = record(value)
      assert(item.optional === undefined || typeof item.optional === 'boolean', 'Invalid optional peer metadata')
      return [name, { optional: item.optional === true }]
    }),
  )
  return {
    name: typeof pkg.name === 'string' ? pkg.name : undefined,
    version: pkg.version,
    packageManager: pkg.packageManager,
    scripts: stringMap(pkg.scripts),
    dependencies: stringMap(pkg.dependencies),
    devDependencies: stringMap(pkg.devDependencies),
    peerDependencies: stringMap(pkg.peerDependencies),
    optionalDependencies: stringMap(pkg.optionalDependencies),
    peerDependenciesMeta: metadata,
  }
}
export const packPayload = (root: string, pnpm: string): PayloadFile[] => {
  const pkg = packageManifest(root)
  assert(
    ['prepack', 'prepare', 'postpack', 'prepublishOnly'].every((name) => pkg.scripts[name] === undefined),
    'Receipt verification never executes package lifecycle scripts',
  )
  assert.equal(pkg.packageManager, undefined, 'Receipt verification cannot dispatch another package manager')
  // Installed roots need directory selection without virtual workspace-root tarball additions.
  const result = spawnSync(pnpm, ['--dir', root, 'pack', '--dry-run', '--json', '--ignore-workspace'], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, 'Normal pinned pnpm pack selection failed')
  const files = record(JSON.parse(result.stdout)).files
  assert(Array.isArray(files), 'Missing normal packlist')
  const names = files.map((value: unknown) => {
    const name = record(value).path
    assert.equal(typeof name, 'string')
    return String(name)
  })
  assert.equal(new Set(names).size, names.length, 'Duplicate packlist path')
  return fileVector(root, names)
}
export const toolInputs = (tools: Tools): ToolInput[] => {
  const files: [string, string][] = [['node', process.execPath]]
  for (const [name, command] of Object.entries(tools.commands))
    for (const [index, arg] of command.entries()) {
      if (fs.existsSync(arg) === true && fs.statSync(arg).isFile() === true) files.push([`${name}.${index}`, arg])
    }
  for (const [name, file] of Object.entries(tools.environment)) files.push([name, file])
  const inputs: ToolInput[] = files.map(([name, file]) => ({
    name,
    sha256: hash(fs.readFileSync(file)),
    mode: fs.statSync(file).mode & 0o777,
  }))
  for (const [name, command] of Object.entries(tools.commands))
    inputs.push({
      name: `${name}.argv`,
      arguments: command.map((arg, index) =>
        fs.existsSync(arg) === true && fs.statSync(arg).isFile() === true
          ? { input: `${name}.${index}` }
          : { literal: arg },
      ),
    })
  return inputs.sort((a, b) => a.name.localeCompare(b.name, 'en'))
}
export const resolvePackage = (from: string, name: string): string | undefined => {
  assert(typeof name === 'string' && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name), 'Invalid dependency name')
  // A declared npm package can share a builtin name; inspect its package, not Node's builtin shortcut.
  const locations = createRequire(path.join(from, 'package.json')).resolve.paths(`${name}/`) ?? []
  for (const location of locations) {
    const candidate = path.join(location, name)
    if (fs.existsSync(path.join(candidate, 'package.json')) === true) return fs.realpathSync(candidate)
  }
  return undefined
}
export const consumerGraph = (
  entries: readonly { root: string; includeDev?: boolean }[],
): Map<string, ConsumerNode> => {
  assert.equal(
    new Set(entries.map((entry) => fs.realpathSync(entry.root))).size,
    entries.length,
    'Duplicate consumer entry root',
  )
  const queue = entries.map((entry) => ({ root: fs.realpathSync(entry.root), dev: entry.includeDev === true }))
  const nodes = new Map<string, ConsumerNode>()
  while (queue.length > 0) {
    const next = queue.shift()
    assert(next !== undefined)
    const { root, dev } = next,
      existing = nodes.get(root)
    if (existing !== undefined && (existing.dev === true || dev === false)) continue
    const pkg = packageManifest(root)
    assert(pkg.name !== undefined, 'Consumer node lacks package identity')
    const node: ConsumerNode = {
      root,
      name: pkg.name,
      dev,
      manifestSha256: hash(fs.readFileSync(path.join(root, 'package.json'))),
      edges: [],
    }
    nodes.set(root, node)
    const optional: Record<string, unknown> = { ...pkg.optionalDependencies }
    const required = { ...pkg.dependencies, ...pkg.peerDependencies, ...(dev === true ? pkg.devDependencies : {}) }
    for (const name of Object.keys(pkg.peerDependencies))
      if (pkg.peerDependenciesMeta[name]?.optional === true) optional[name] = required[name]
    for (const name of Object.keys({ ...required, ...optional }).sort(compare)) {
      const target = resolvePackage(root, name)
      assert(
        target !== undefined || name in optional,
        `Unresolved required consumer dependency: ${name} from ${pkg.name} (${root})`,
      )
      node.edges.push({ name, root: target ?? null })
      if (target !== undefined) queue.push({ root: target, dev: false })
    }
  }
  return nodes
}
