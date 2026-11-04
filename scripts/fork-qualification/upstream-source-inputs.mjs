import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

export const UPSTREAM_SOURCE_ROOT = 'packages/@livestore/wa-sqlite/vendor/source-ced5652e'
export const UPSTREAM_PROVENANCE = `${UPSTREAM_SOURCE_ROOT}/provenance.json`
export const UPSTREAM_AUTHORED_README = 'packages/@livestore/wa-sqlite/vendor/README.md'

// Exact upstream bytes are inputs, not authored style. Updating these pins requires a new review.
export const UPSTREAM_SOURCE_INPUTS = Object.freeze(
  [
    {
      path: 'LICENSE',
      sha256: '547f9e97e461bd369cc64b6fc12d724e8b02764b8db7812691f29f0ec572be79',
      gitBlobSha1: '5715004bb1bf66a86a2f4918fe2a4f103e22e46d',
      upstreamPath: 'LICENSE',
      bytes: 1073,
      mode: '0644',
      upstreamMode: '100644',
    },
    {
      path: 'runtime/wa-sqlite-async.mjs',
      sha256: '23739ea7ea7011b32668968fd921eafc0b17fc8d0363e8f5b9e6098cf2f2cd4d',
      gitBlobSha1: '47823c46a631d2dcb4aba3fd56ebb4ac45e4580e',
      upstreamPath: 'dist/wa-sqlite-async.mjs',
      bytes: 128720,
      mode: '0644',
      upstreamMode: '100644',
    },
    {
      path: 'runtime/wa-sqlite-async.wasm',
      sha256: 'beb3436a10816120200ec32e552158051c76a8132dfbf0312704843267c8e7bf',
      gitBlobSha1: 'a5916d17e14879d64d502b611d5d14cdd7cb017c',
      upstreamPath: 'dist/wa-sqlite-async.wasm',
      bytes: 1261904,
      mode: '0644',
      upstreamMode: '100755',
    },
    {
      path: 'src/FacadeVFS.js',
      sha256: '6de41eee28f7d4279d409e275b3e25fd5e7837163386e4e8f2c379cd9f72a60c',
      gitBlobSha1: 'dbc4947a14486d32c6be4727c158a17e3e7cf11c',
      upstreamPath: 'src/FacadeVFS.js',
      bytes: 17977,
      mode: '0644',
      upstreamMode: '100644',
    },
    {
      path: 'src/VFS.js',
      sha256: '55e7455e2ec0000cc4ba7a8bf7882f414a40f2a0ba6eb4c4ac847f379f54d92f',
      gitBlobSha1: '12966b9cfbe8713850aad2e564e7ff1fa231875c',
      upstreamPath: 'src/VFS.js',
      bytes: 4445,
      mode: '0644',
      upstreamMode: '100644',
    },
    {
      path: 'src/WebLocksMixin.js',
      sha256: '0ee2f39f43b3a8d70e94c0e5a2bac97f2c55416830183d4810caf28b2cec7375',
      gitBlobSha1: 'e5fd48f9ad54d1484c4f6282b5af56801c3b8ba5',
      upstreamPath: 'src/WebLocksMixin.js',
      bytes: 12949,
      mode: '0644',
      upstreamMode: '100644',
    },
    {
      path: 'src/examples/IDBBatchAtomicVFS.js',
      sha256: '13d9f2ea1c30621affd27e407b760a7eb15ce465ded12d79c3f8bf190361e5ad',
      gitBlobSha1: '0d03347d8ac61bcf0cfa90419e8597360719c09a',
      upstreamPath: 'src/examples/IDBBatchAtomicVFS.js',
      bytes: 28708,
      mode: '0644',
      upstreamMode: '100644',
    },
    {
      path: 'src/sqlite-api.js',
      sha256: '4369293946705a7bebfdd54d54461bfb210c8f357a15d153312f20767be69fe2',
      gitBlobSha1: '12e59a14f63a63589cc3ccf5c6205a6f143a347c',
      upstreamPath: 'src/sqlite-api.js',
      bytes: 29731,
      mode: '0644',
      upstreamMode: '100644',
    },
    {
      path: 'src/sqlite-constants.js',
      sha256: 'f7b570f0c39e4b54c99f2598b6ad42018d4d8bf791861ede20d295628ae49f8f',
      gitBlobSha1: '3878b169631b468a31c01455c57a4f1248eb7a56',
      upstreamPath: 'src/sqlite-constants.js',
      bytes: 11247,
      mode: '0644',
      upstreamMode: '100644',
    },
  ].map(Object.freeze),
)
const expectedProvenance = Object.freeze({
  repository: 'https://github.com/rhashimoto/wa-sqlite',
  commit: 'ced5652ee7b65d22da3efeb0ef628977b64383cd',
  release: null,
  purpose: 'Coherent async SOURCE-only API/VFS/binary; synchronous STATE entry remains unchanged',
  license: 'LICENSE',
  files: UPSTREAM_SOURCE_INPUTS,
})
const sha = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex')
const requireInput = (condition, message) => {
  if (condition !== true) throw new Error(`Pinned upstream SOURCE input: ${message}`)
}

export const validateUpstreamSourceInputs = (root) => {
  // Reject ancestor symlinks before reading or walking the reviewed owner boundary.
  let ancestor = root
  for (const segment of UPSTREAM_SOURCE_ROOT.split('/')) {
    ancestor = path.join(ancestor, segment)
    const stat = lstatSync(ancestor)
    requireInput(stat.isDirectory() === true, `not a physical directory: ${ancestor}`)
  }
  const expectedFiles = new Set([...UPSTREAM_SOURCE_INPUTS.map((row) => row.path), 'provenance.json'])
  const expectedDirectories = new Set([''])
  for (const file of expectedFiles) {
    const segments = file.split('/')
    for (let length = 1; length < segments.length; length++)
      expectedDirectories.add(segments.slice(0, length).join('/'))
  }
  const owner = path.join(root, UPSTREAM_SOURCE_ROOT)
  const actualFiles = []
  const visit = (name) => {
    const file = path.join(owner, name)
    const stat = lstatSync(file)
    if (stat.isDirectory() === true) {
      requireInput(expectedDirectories.has(name), `unexpected directory: ${name}`)
      requireInput((stat.mode & 0o7777) === 0o755, `unexpected directory mode: ${name}`)
      for (const entry of readdirSync(file)) visit(name === '' ? entry : `${name}/${entry}`)
      return
    }
    requireInput(stat.isFile() === true, `not a regular file: ${name}`)
    requireInput(expectedFiles.has(name), `unexpected file: ${name}`)
    requireInput((stat.mode & 0o7777) === 0o644, `unexpected file mode: ${name}`)
    actualFiles.push(name)
  }
  visit('')
  requireInput(
    actualFiles.length === expectedFiles.size && [...expectedFiles].every((file) => actualFiles.includes(file)),
    'missing input',
  )
  const manifest = readFileSync(path.join(root, UPSTREAM_PROVENANCE))
  // Canonical exact metadata also refuses duplicate keys, escaped paths and unreviewed manifest fields.
  requireInput(
    manifest.equals(Buffer.from(`${JSON.stringify(expectedProvenance, null, 2)}\n`)),
    'provenance differs from the reviewed manifest',
  )
  for (const expected of UPSTREAM_SOURCE_INPUTS) {
    const bytes = readFileSync(path.join(owner, expected.path))
    requireInput(bytes.length === expected.bytes, `byte count changed: ${expected.path}`)
    requireInput(sha('sha256', bytes) === expected.sha256, `SHA-256 changed: ${expected.path}`)
    const blob = Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])
    requireInput(sha('sha1', blob) === expected.gitBlobSha1, `Git blob changed: ${expected.path}`)
  }
  return [...UPSTREAM_SOURCE_INPUTS.map((row) => `${UPSTREAM_SOURCE_ROOT}/${row.path}`), UPSTREAM_PROVENANCE]
}
