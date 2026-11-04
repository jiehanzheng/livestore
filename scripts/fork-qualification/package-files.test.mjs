import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const tools = JSON.parse(readFileSync(path.join(root, 'temp_nocommit/fork-qualification/tools.json'), 'utf8'))
const pnpm = tools.commands.pnpm[0]
const assets = {
  'dist/mod.js': 'export const runtime = true;',
  'dist/mod.d.ts': 'export declare const runtime: true;',
  'dist/mod.js.map': '{}',
  'dist/mod.d.ts.map': '{}',
  'dist/runtime.wasm': 'synthetic wasm fixture',
  'dist/cli.js': '#!/usr/bin/env node\n',
  'src/index.ts': 'export const runtime = true;',
  'src/sqlite-api.js': 'export const runtime = true;',
  'src/types/index.d.ts': 'export declare const runtime: true;',
  'src/examples/runtime.js': 'export const runtime = true;',
  'test/runtime.js': 'export const runtime = true;',
  'docs/usage.md': 'Public documentation',
  'dist/.tsbuildinfo': 'private cache',
  'dist/nested/compiler.tsbuildinfo': 'private cache',
  'src/.tsbuildinfo': 'private cache',
  'src/examples/compiler.tsbuildinfo': 'private cache',
  'test/compiler.tsbuildinfo': 'private cache',
  'docs/.tsbuildinfo': 'private cache',
  'project.tsbuildinfo': 'private cache',
}
const isCache = (name) => name.endsWith('.tsbuildinfo')
const hasCacheExclusion = (pattern) => pattern.startsWith('!') && pattern.includes('.tsbuildinfo')
const fixture = (run) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'livestore-package-files-'))
  try {
    for (const [name, bytes] of Object.entries(assets)) {
      const target = path.join(directory, name)
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, bytes)
      chmodSync(target, name === 'dist/cli.js' ? 0o755 : 0o644)
    }
    run(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
const packedFiles = (directory, files) => {
  // The fixture has no dependency or lifecycle scripts; the pinned package manager owns selection.
  writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: 'package-files-fixture', version: '1.0.0', files }),
  )
  const result = spawnSync(pnpm, ['--dir', directory, 'pack', '--dry-run', '--json', '--ignore-workspace'], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  const names = JSON.parse(result.stdout)
    .files.map((file) => file.path)
    .toSorted()
  assert.equal(new Set(names).size, names.length)
  return names.map((name) => {
    const target = path.join(directory, name)
    return {
      path: name,
      mode: statSync(target).mode & 0o777,
      sha256: createHash('sha256').update(readFileSync(target)).digest('hex'),
    }
  })
}
const readManifest = (name) =>
  JSON.parse(readFileSync(path.join(root, 'packages/@livestore', name, 'package.json'), 'utf8'))

test('real public SDK files declarations keep caches private while preserving all other selected assets and modes', async (context) => {
  const manifests = readdirSync(path.join(root, 'packages/@livestore'))
    .map(readManifest)
    .filter((manifest) => manifest.private !== true)
  assert(manifests.length > 0)
  for (const manifest of manifests) {
    await context.test(manifest.name, () =>
      fixture((directory) => {
        assert(Array.isArray(manifest.files))
        const before = packedFiles(
          directory,
          manifest.files.filter((pattern) => hasCacheExclusion(pattern) === false),
        )
        const after = packedFiles(directory, manifest.files)
        assert(after.every((file) => isCache(file.path) === false))
        // Only the fixture manifest changes when declaring exclusions; every other selected byte/mode must survive.
        assert.deepEqual(
          after.filter((file) => file.path !== 'package.json'),
          before.filter((file) => file.path !== 'package.json' && isCache(file.path) === false),
        )
        const executable = after.find((file) => file.path === 'dist/cli.js')
        if (executable !== undefined) assert.equal(executable.mode, 0o755)
        for (const name of Object.keys(assets).filter(isCache)) {
          assert.equal(readFileSync(path.join(directory, name), 'utf8'), 'private cache')
        }
      }),
    )
  }
})

test('real docs declaration keeps the exclusion after positive extras that can reinclude caches', () =>
  fixture((directory) => {
    const { files } = readManifest('livestore')
    assert(files.includes('docs'))
    // Moving the actual docs inclusion after the actual exclusion recreates the packlist ordering failure.
    const misplaced = packedFiles(directory, [...files.filter((pattern) => pattern !== 'docs'), 'docs'])
    assert(misplaced.some((file) => file.path === 'docs/.tsbuildinfo'))
    const correct = packedFiles(directory, files)
    assert(correct.some((file) => file.path === 'docs/usage.md'))
    assert(correct.every((file) => isCache(file.path) === false))
  }))
