import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

export const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0)
export const hash = (value) => createHash('sha256').update(value).digest('hex')
export const canonical = (value) => {
  if (Array.isArray(value) === true) return value.map(canonical)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort(compare)
        .map((key) => [key, canonical(value[key])]),
    )
  return value
}
export const digest = (value) => hash(JSON.stringify(canonical(value)))
export const ensure = (condition, message) => {
  if (condition !== true) throw new Error(message)
}
export const equal = (actual, expected, message) => ensure(isDeepStrictEqual(actual, expected), message)
export const object = (value, message) =>
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), message)
export const array = (value, message) => ensure(Array.isArray(value), message)
export const sha = (value) => ensure(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Invalid SHA-256')
export const relative = (value) => {
  ensure(typeof value === 'string' && value.length > 0 && !path.isAbsolute(value), 'Expected relative payload path')
  ensure(
    !/[\\\0]/.test(value) && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'Escaped payload path',
  )
  return value
}
export const unique = (rows, key, message) => {
  array(rows, message)
  ensure(new Set(rows.map(key)).size === rows.length, message)
}
export const capture = (context, code, run) => {
  try {
    return run()
  } catch (error) {
    context.issues.push({ code, detail: error.message })
    return undefined
  }
}
export const resolve = (base, value) => {
  ensure(typeof value === 'string' && value.length > 0, 'Missing local path')
  return path.resolve(base, value)
}
export const readRef = (context, ref) => {
  object(ref, 'Missing hashed evidence reference')
  sha(ref.sha256)
  const file = resolve(context.evidenceDirectory, ref.path)
  ensure(fs.statSync(file).isFile(), 'Evidence must be a regular file')
  const bytes = fs.readFileSync(file)
  ensure(hash(bytes) === ref.sha256, `Evidence hash changed: ${file}`)
  context.references.set(file, ref.sha256)
  return bytes
}
export const jsonRef = (context, ref) => JSON.parse(readRef(context, ref).toString('utf8'))
export const git = (root, args, options = {}) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', ...options })
  ensure(result.status === 0, `Git inspection failed: ${args[0]}`)
  return result.stdout
}
const semantic = (root, name) => {
  const file = path.join(root, relative(name))
  if (fs.existsSync(file) === false && fs.lstatSync(file, { throwIfNoEntry: false }) === undefined)
    return { path: name, kind: 'missing' }
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink() === true) {
    const target = fs.readlinkSync(file)
    ensure(fs.realpathSync(file).startsWith(`${fs.realpathSync(root)}${path.sep}`), 'Source symlink escapes repository')
    return { path: name, kind: 'symlink', executable: false, sha256: hash(target), target }
  }
  ensure(stat.isFile(), 'Unsupported authored entry')
  // Git commits executable bits, not readonly projection permissions. Artifact modes are checked separately in full.
  return { path: name, kind: 'file', executable: (stat.mode & 0o111) !== 0, sha256: hash(fs.readFileSync(file)) }
}
export const sourceState = (root, base) => {
  ensure(/^[a-f0-9]{40}$/.test(base), 'Expected exact base commit')
  ensure(git(root, ['rev-parse', 'HEAD']).trim() === base, 'Source base changed')
  const tracked = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean)
  const names = [...new Set(tracked)].sort(compare)
  const tree = names.map((name) => semantic(root, name)).filter((row) => row.kind !== 'missing')
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
export const indexed = (root, row) => {
  const metadata = git(root, ['ls-files', '--stage', '-z', '--', row.path]).split('\0').filter(Boolean)
  if (row.kind === 'missing') return metadata.length === 0
  ensure(metadata.length === 1, 'Missing or unresolved index entry')
  const mode = metadata[0].split(' ')[0]
  const object = `:${row.path}`
  const size = Number(git(root, ['cat-file', '-s', object]).trim())
  ensure(Number.isSafeInteger(size) && size >= 0, 'Invalid index object size')
  // Official WASM blobs exceed spawnSync's default buffer; bound the read to the actual Git object instead.
  const bytes = git(root, ['show', object], { encoding: 'buffer', maxBuffer: size + 1 })
  return (
    hash(bytes) === row.sha256 &&
    (mode === '120000') === (row.kind === 'symlink') &&
    (mode === '100755') === row.executable
  )
}
export const fileVector = (root, names) =>
  [...names].sort(compare).map((name) => {
    const file = path.join(root, relative(name))
    ensure(fs.realpathSync(file).startsWith(`${fs.realpathSync(root)}${path.sep}`), 'Payload escapes owner')
    const stat = fs.lstatSync(file)
    ensure(stat.isFile(), 'Payload must be regular files')
    const bytes = fs.readFileSync(file)
    return { path: name, mode: stat.mode & 0o777, bytes: bytes.length, sha256: hash(bytes) }
  })
export const walkPayload = (root) => {
  const names = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      if (directory === '' && entry.name === 'node_modules') continue
      const name = directory !== '' ? `${directory}/${entry.name}` : entry.name
      if (entry.isDirectory() === true) visit(name)
      else names.push(name)
    }
  }
  visit('')
  return fileVector(root, names)
}
export const packPayload = (root, pnpm) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  ensure(
    ['prepack', 'prepare', 'postpack', 'prepublishOnly'].every((name) => pkg.scripts?.[name] === undefined),
    'Receipt verification never executes package lifecycle scripts',
  )
  ensure(pkg.packageManager === undefined, 'Receipt verification cannot dispatch another package manager')
  // Installed producer roots need physical directory selection, without virtual workspace-root tarball additions.
  const result = spawnSync(pnpm, ['--dir', root, 'pack', '--dry-run', '--json', '--ignore-workspace'], {
    encoding: 'utf8',
  })
  ensure(result.status === 0, 'Normal pinned pnpm pack selection failed')
  const names = JSON.parse(result.stdout).files.map((row) => row.path)
  unique(names, (name) => name, 'Duplicate packlist path')
  return fileVector(root, names)
}
export const toolInputs = (tools) => {
  const files = [['node', process.execPath]]
  for (const [name, command] of Object.entries(tools.commands))
    for (const [index, arg] of command.entries())
      if (fs.existsSync(arg) === true && fs.statSync(arg).isFile() === true) files.push([`${name}.${index}`, arg])
  for (const [name, file] of Object.entries(tools.environment)) files.push([name, file])
  const inputs = files
    .map(([name, file]) => ({ name, sha256: hash(fs.readFileSync(file)), mode: fs.statSync(file).mode & 0o777 }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
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
