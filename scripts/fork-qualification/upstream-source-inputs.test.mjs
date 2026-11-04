import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { sourceState, walkPayload } from './commit-files.mjs'
import { sdkIdentity, supportPaths } from './commit-source.mjs'
import { createSourcePolicy } from './qualification-policy.mjs'
import {
  UPSTREAM_AUTHORED_README,
  UPSTREAM_PROVENANCE,
  UPSTREAM_SOURCE_INPUTS,
  UPSTREAM_SOURCE_ROOT,
  validateUpstreamSourceInputs,
} from './upstream-source-inputs.mjs'

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixture = (run) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'livestore-upstream-inputs-'))
  try {
    const files = [...UPSTREAM_SOURCE_INPUTS.map((row) => `${UPSTREAM_SOURCE_ROOT}/${row.path}`), UPSTREAM_PROVENANCE]
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      fs.copyFileSync(path.join(checkout, file), path.join(root, file))
    }
    return run(root, path.join(root, UPSTREAM_SOURCE_ROOT))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}
const changeManifest = (root, change) => {
  const file = path.join(root, UPSTREAM_PROVENANCE)
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  change(manifest)
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
}
const git = (root, args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test('exact nine reviewed upstream inputs and authored provenance validate', () => {
  const actual = validateUpstreamSourceInputs(checkout)
  assert.equal(actual.length, 10)
  assert(actual.includes(`${UPSTREAM_SOURCE_ROOT}/runtime/wa-sqlite-async.wasm`))
  assert(actual.includes(`${UPSTREAM_SOURCE_ROOT}/LICENSE`))
  assert(actual.includes(UPSTREAM_PROVENANCE))
  fixture((root) => assert.deepEqual(validateUpstreamSourceInputs(root), actual))
})

test('rejects changed input bytes, even when the manifest is edited to describe them', () =>
  fixture((root, owner) => {
    const file = path.join(owner, 'src/sqlite-api.js')
    fs.appendFileSync(file, '\n// changed\n')
    assert.throws(() => validateUpstreamSourceInputs(root), /byte count changed/)
    changeManifest(root, (manifest) => {
      manifest.files.find((row) => row.path === 'src/sqlite-api.js').bytes += 12
    })
    assert.throws(() => validateUpstreamSourceInputs(root), /provenance differs/)
  }))

test('rejects same-size input byte tampering by digest', () =>
  fixture((root, owner) => {
    const file = path.join(owner, 'runtime/wa-sqlite-async.wasm'),
      bytes = fs.readFileSync(file)
    bytes[100] ^= 1
    fs.writeFileSync(file, bytes)
    assert.throws(() => validateUpstreamSourceInputs(root), /SHA-256 changed/)
  }))

test('rejects a missing reviewed input', () =>
  fixture((root, owner) => {
    fs.unlinkSync(path.join(owner, 'LICENSE'))
    assert.throws(() => validateUpstreamSourceInputs(root), /missing input/)
  }))

test('rejects extra files and directories rather than exempting a vendor glob', () => {
  fixture((root, owner) => {
    fs.writeFileSync(path.join(owner, 'authored-wrapper.js'), 'export const value = 1\n')
    assert.throws(() => validateUpstreamSourceInputs(root), /unexpected file/)
  })
  fixture((root, owner) => {
    fs.mkdirSync(path.join(owner, 'extra'))
    assert.throws(() => validateUpstreamSourceInputs(root), /unexpected directory/)
  })
})

for (const [name, mutate] of [
  [
    'missing manifest row',
    (manifest) => {
      manifest.files.pop()
    },
  ],
  [
    'extra manifest row',
    (manifest) => {
      manifest.files.push({ ...manifest.files[0], path: 'extra.js' })
    },
  ],
  [
    'duplicate manifest row',
    (manifest) => {
      manifest.files[1] = manifest.files[0]
    },
  ],
  [
    'path escape',
    (manifest) => {
      manifest.files[0].path = '../LICENSE'
    },
  ],
  [
    'upstream path escape',
    (manifest) => {
      manifest.files[0].upstreamPath = '../LICENSE'
    },
  ],
  [
    'repository substitution',
    (manifest) => {
      manifest.repository = 'https://example.invalid/fork'
    },
  ],
  [
    'commit substitution',
    (manifest) => {
      manifest.commit = '0'.repeat(40)
    },
  ],
  [
    'license substitution',
    (manifest) => {
      manifest.license = 'src/sqlite-api.js'
    },
  ],
  [
    'blob substitution',
    (manifest) => {
      manifest.files[0].gitBlobSha1 = '0'.repeat(40)
    },
  ],
  [
    'upstream mode substitution',
    (manifest) => {
      manifest.files[0].upstreamMode = '100755'
    },
  ],
  [
    'local mode substitution',
    (manifest) => {
      manifest.files[0].mode = '0755'
    },
  ],
  [
    'metadata extension',
    (manifest) => {
      manifest.exempt = true
    },
  ],
])
  test(`rejects ${String(name)}`, () =>
    fixture((root) => {
      changeManifest(root, mutate)
      assert.throws(() => validateUpstreamSourceInputs(root), /provenance differs/)
    }))

test('rejects duplicate JSON keys instead of accepting their parsed final value', () =>
  fixture((root) => {
    const file = path.join(root, UPSTREAM_PROVENANCE),
      text = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file, text.replace('{', '{\n  "release": "v1.1.2",'))
    assert.throws(() => validateUpstreamSourceInputs(root), /provenance differs/)
  }))

test('rejects input, manifest and ancestor symlinks without following them', () => {
  for (const name of ['LICENSE', 'provenance.json'])
    fixture((root, owner) => {
      const file = path.join(owner, name),
        target = path.join(root, 'target')
      fs.renameSync(file, target)
      fs.symlinkSync(target, file)
      assert.throws(() => validateUpstreamSourceInputs(root), /not a regular file/)
    })
  fixture((root, owner) => {
    const target = path.join(root, 'external-owner')
    fs.renameSync(owner, target)
    fs.symlinkSync(target, owner)
    assert.throws(() => validateUpstreamSourceInputs(root), /not a physical directory/)
  })
})

test('rejects unexpected file and directory modes', () => {
  for (const mode of [0o600, 0o755])
    fixture((root, owner) => {
      fs.chmodSync(path.join(owner, 'src/VFS.js'), mode)
      assert.throws(() => validateUpstreamSourceInputs(root), /unexpected file mode/)
    })
  fixture((root, owner) => {
    fs.chmodSync(path.join(owner, 'src'), 0o700)
    assert.throws(() => validateUpstreamSourceInputs(root), /unexpected directory mode/)
  })
})

test('only the nine exact inputs leave authored style; all remain source, SDK and package payload bytes', () =>
  fixture((root) => {
    const put = (name, bytes) => {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
      fs.writeFileSync(path.join(root, name), bytes)
    }
    for (const file of supportPaths) put(file, '{}\n')
    put(UPSTREAM_AUTHORED_README, '# Reviewed upstream SOURCE inputs\n')
    const wrapper = 'packages/@livestore/wa-sqlite/src/async-source-wrapper.js'
    put(wrapper, 'export const authored = true\n')
    const policy = createSourcePolicy(root)
    git(root, ['init', '--quiet'])
    git(root, ['add', '.'])
    git(root, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ])
    const base = git(root, ['rev-parse', 'HEAD'])
    const full = policy.sourceInventory(),
      authored = policy.authoredSourceInventory()
    assert.equal(full.length - authored.length, 9)
    for (const row of UPSTREAM_SOURCE_INPUTS) {
      const name = `${UPSTREAM_SOURCE_ROOT}/${row.path}`
      assert(full.includes(name))
      assert.equal(authored.includes(name), false)
    }
    for (const file of [UPSTREAM_PROVENANCE, UPSTREAM_AUTHORED_README, wrapper]) assert(authored.includes(file))
    const state = sourceState(root, base),
      sdk = sdkIdentity(root, state.tree)
    const payload = walkPayload(path.join(root, 'packages/@livestore/wa-sqlite'))
    for (const name of validateUpstreamSourceInputs(root)) {
      assert(state.tree.some((row) => row.path === name))
      assert(sdk.sdkFiles.some((row) => row.path === name))
      assert(payload.some((row) => row.path === name.slice('packages/@livestore/wa-sqlite/'.length)))
    }
    fs.appendFileSync(path.join(root, wrapper), '// authored changes remain checked\n')
    assert(policy.authoredSourceInventory().includes(wrapper))
    assert.notEqual(sourceState(root, base).physicalDigest, state.physicalDigest)
    const ignored = '.gitignore'
    put(ignored, `${UPSTREAM_SOURCE_ROOT}/runtime/wa-sqlite-async.wasm\n`)
    git(root, ['rm', '--cached', '--quiet', `${UPSTREAM_SOURCE_ROOT}/runtime/wa-sqlite-async.wasm`])
    assert.throws(() => policy.sourceInventory(), /absent from git source inventory/)
  }))

test('current authored inventory omits deletions while source receipts still bind their missing state', () =>
  fixture((root, owner) => {
    const authored = 'packages/@livestore/common/src/deleted-authored.ts'
    const required = '.oxfmtrc.json.genie.ts'
    for (const name of [authored, required, UPSTREAM_AUTHORED_README]) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
      fs.writeFileSync(path.join(root, name), name === authored ? 'export const value = 1\n' : '# fixture\n')
    }
    git(root, ['init', '--quiet'])
    git(root, ['add', '.'])
    git(root, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ])
    const base = git(root, ['rev-parse', 'HEAD'])
    const policy = createSourcePolicy(root)
    assert(policy.authoredSourceInventory().includes(authored))
    fs.unlinkSync(path.join(root, authored))
    assert.equal(policy.authoredSourceInventory().includes(authored), false)
    const state = sourceState(root, base)
    assert.equal(
      state.tree.some((row) => row.path === authored),
      false,
    )
    assert.deepEqual(
      state.changed.find((row) => row.path === authored),
      { path: authored, kind: 'missing' },
    )

    fs.unlinkSync(path.join(root, required))
    assert.throws(() => policy.sourceInventory(), /Source inventory includes missing files/)
    fs.unlinkSync(path.join(owner, 'LICENSE'))
    // Reviewed bytes are validated before the ordinary authored deletion filter is reached.
    assert.throws(() => policy.sourceInventory(), /missing input/)
  }))
