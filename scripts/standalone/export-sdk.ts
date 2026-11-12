import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {
  digest,
  git,
  hash,
  packPayload,
  sdkIdentity,
  sourceState,
  type PayloadFile,
} from '../fork-qualification/qualification-observations.mts'
import { sdkNames } from '../fork-qualification/qualification-recipe.mts'

interface ExportPlan {
  root: string
  head: string
  output: string
  inventory: { packages: readonly { name: string; files: readonly PayloadFile[] }[] }
}

const cleanHead = (root: string) => {
  const head = git(root, ['rev-parse', 'HEAD']).trim()
  // Git status can hide worktree changes behind these index flags.
  assert(
    !git(root, ['ls-files', '-v', '-z'])
      .split('\0')
      .some((entry) => /^[a-zS] /.test(entry)),
    'SDK export requires a fully checked-out Git index',
  )
  assert.equal(
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']),
    '',
    'SDK export requires a clean Git checkout',
  )
  return head
}

export const writeSdkExport = ({ root, head, output, inventory }: ExportPlan) => {
  fs.mkdirSync(output)
  try {
    for (const pkg of inventory.packages) {
      for (const file of pkg.files) {
        const relative = path.join('packages', pkg.name, file.path)
        const input = path.join(root, relative)
        const destination = path.join(output, relative)
        const stat = fs.lstatSync(input)
        const bytes = fs.readFileSync(input)
        assert(
          stat.isFile() &&
            (stat.mode & 0o777) === file.mode &&
            bytes.length === file.bytes &&
            hash(bytes) === file.sha256,
          `Pack-selected file changed during SDK export: ${relative}`,
        )
        fs.mkdirSync(path.dirname(destination), { recursive: true })
        fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 })
        fs.chmodSync(destination, file.mode)
      }
    }
    assert.equal(cleanHead(root), head, 'Git HEAD changed during SDK export')
    // Consumers treat the inventory as the completion marker for the directory.
    const pending = path.join(output, '.inventory.tmp')
    fs.writeFileSync(pending, `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' })
    fs.renameSync(pending, path.join(output, 'candidate-artifact-inventory.json'))
  } catch (error) {
    fs.rmSync(output, { recursive: true, force: true })
    throw error
  }
}

export const exportSdk = (root: string, requestedOutput: string) => {
  const head = cleanHead(root)
  const absolute = path.resolve(requestedOutput)
  const output = path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute))
  const fromRoot = path.relative(root, output)
  assert(
    fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot),
    'SDK export directory must be outside the checkout',
  )
  assert.equal(fs.lstatSync(output, { throwIfNoEntry: false }), undefined, 'SDK export directory already exists')
  const profile: unknown = JSON.parse(
    fs.readFileSync(path.join(root, 'scripts/fork-qualification/tool-profile.json'), 'utf8'),
  )
  assert(
    profile !== null &&
      typeof profile === 'object' &&
      'nodeMajor' in profile &&
      'pnpm' in profile &&
      Number.isInteger(profile.nodeMajor) &&
      typeof profile.pnpm === 'string',
    'Invalid pinned tool profile',
  )
  assert.equal(process.versions.node.split('.')[0], String(profile.nodeMajor), 'Use the pinned Node major')
  assert.equal(
    execFileSync('pnpm', ['--version'], { cwd: root, encoding: 'utf8' }).trim(),
    profile.pnpm,
    'Use the pinned pnpm',
  )
  const sourceSeal = digest(sdkIdentity(root, sourceState(root, head).tree))
  const packages = sdkNames.map((name) => {
    const files = packPayload(path.join(root, 'packages', name), 'pnpm')
    return { name, sha256: hash(JSON.stringify(files)), files }
  })
  // The app pins the serialized inventory, including property order and the final newline.
  const inventory = {
    contract: 'livestore-qualified-package-payload-v1',
    sourceSeal,
    files: packages.reduce((count, pkg) => count + pkg.files.length, 0),
    directoryIdentity: hash(JSON.stringify(packages.map(({ name, sha256 }) => ({ name, sha256 })))),
    packages,
  }
  writeSdkExport({ root, head, output, inventory })
  return inventory
}

if (import.meta.main) {
  assert.equal(process.argv.length, 3, 'Usage: node scripts/standalone/export-sdk.ts <absent-output-directory>')
  const root = fs.realpathSync(git(process.cwd(), ['rev-parse', '--show-toplevel']).trim())
  const output = process.argv[2]
  assert(output !== undefined, 'Missing export directory')
  const { sourceSeal, files, directoryIdentity } = exportSdk(root, output)
  console.log(JSON.stringify({ sourceSeal, files, directoryIdentity }))
}
