import { hash, git, fileVector } from './qualification-observations.mts'
// Keep the existing Node/Bun receipt-consumer entrypoint bound to the checked implementation.
export {
  compare,
  hash,
  canonical,
  digest,
  relative,
  git,
  sourceState,
  fileVector,
  packPayload,
  toolInputs,
} from './qualification-observations.mts'
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

export const ensure = (condition, message) => {
  if (condition !== true) throw new Error(message)
}
export const equal = (actual, expected, message) => ensure(isDeepStrictEqual(actual, expected), message)
export const object = (value, message) =>
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), message)
export const array = (value, message) => ensure(Array.isArray(value), message)
export const sha = (value) => ensure(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Invalid SHA-256')
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
