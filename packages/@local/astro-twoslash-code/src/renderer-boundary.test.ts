import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { resolveProjectPaths } from './project-paths.ts'
import { createRendererConfig } from './renderer-config.ts'
import { prepareRendererJob } from './renderer-owner.ts'
import { createRendererDispatcher, type RendererClose } from './renderer-parent.ts'
import { encodeRendererFailure, jobByteLimit, renderInputLimit, type RendererJob } from './renderer-protocol.ts'

const projectRoot = fileURLToPath(new URL('../example', import.meta.url))
const paths = resolveProjectPaths(projectRoot)
const request: RendererJob = { mode: 'build', projectRoot, ownerRoot: paths.snippetAssetsRoot, runtime: {} }

const withScratch = async (onFinished: (cleanup: () => void) => void, use: (directory: string) => Promise<void>) => {
  fs.mkdirSync(paths.cacheRoot, { recursive: true })
  const directory = fs.mkdtempSync(path.join(paths.cacheRoot, 'pure-boundary-'))
  onFinished(() => fs.rmSync(directory, { recursive: true, force: true }))
  await use(directory)
}

describe('pure renderer boundary checks — no renderer process capability', () => {
  it('bounds serialized failure output even when JSON expands every control character', () => {
    const encoded = encodeRendererFailure('\0'.repeat(jobByteLimit))
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(jobByteLimit)
    expect(JSON.parse(encoded).ok).toBe(false)
  })
  it('rejects invalid compiler options instead of silently using defaults', async ({ onTestFinished }) => {
    await withScratch(onTestFinished, async (directory) => {
      const config = path.join(directory, 'tsconfig.json')
      fs.writeFileSync(path.join(directory, 'valid.ts'), 'export const value = 1')
      fs.writeFileSync(
        config,
        JSON.stringify({ compilerOptions: { target: 'invalid-target' }, include: ['./valid.ts'] }),
      )
      expect(() => createRendererConfig(paths, { snippetTsconfigPath: config })).toThrow(
        /Invalid snippet configuration.*[\s\S]*TS6046/,
      )
      fs.writeFileSync(config, JSON.stringify({ compilerOptions: { target: 'ESNext' }, include: ['./valid.ts'] }))
      expect(createRendererConfig(paths, { snippetTsconfigPath: config }).compilerOptions.target).toBe(
        ts.ScriptTarget.ESNext,
      )
    })
  })
  it('accepts the populated maintained example owner configuration', () => {
    expect(createRendererConfig(paths).compilerOptions.noEmit).toBe(true)
  })
  it('accepts an explicitly empty valid config for virtual inputs while refusing invalid options', async ({
    onTestFinished,
  }) => {
    await withScratch(onTestFinished, async (directory) => {
      const virtualPaths = resolveProjectPaths(path.join(directory, 'virtual-owner'))
      fs.mkdirSync(virtualPaths.snippetAssetsRoot, { recursive: true })
      const configPath = path.join(virtualPaths.snippetAssetsRoot, 'tsconfig.json')
      const config = { compilerOptions: { target: 'ESNext' }, references: [] }
      fs.writeFileSync(configPath, JSON.stringify(config))
      expect(createRendererConfig(virtualPaths).compilerOptions.target).toBe(ts.ScriptTarget.ESNext)
      expect(
        prepareRendererJob({
          mode: 'render',
          projectRoot: virtualPaths.projectRoot,
          ownerRoot: virtualPaths.snippetAssetsRoot,
          runtime: {},
          inputs: [{ code: 'const count = 1', language: 'ts', lineOwners: [] }],
        }).job.mode,
      ).toBe('render')
      fs.writeFileSync(configPath, JSON.stringify({ ...config, compilerOptions: { target: 'invalid-target' } }))
      expect(() => createRendererConfig(virtualPaths)).toThrow(/TS6046/)
    })
  })
  it('reports accidental empty discovery instead of ignoring TS18003', async ({ onTestFinished }) => {
    await withScratch(onTestFinished, async (directory) => {
      const configPath = path.join(directory, 'tsconfig.json')
      fs.writeFileSync(
        configPath,
        JSON.stringify({ compilerOptions: { target: 'ESNext' }, include: ['./missing/**/*.ts'] }),
      )
      expect(() => createRendererConfig(paths, { snippetTsconfigPath: configPath })).toThrow(/TS18003/)
    })
  })
  it('normalizes a real symlink owner without allowing a second dispatch', async ({ onTestFinished }) => {
    await withScratch(onTestFinished, async (directory) => {
      const alias = path.join(directory, 'project-alias')
      fs.symlinkSync(projectRoot, alias, 'dir')
      const aliased: RendererJob = {
        ...request,
        projectRoot: alias,
        ownerRoot: resolveProjectPaths(alias).snippetAssetsRoot,
      }
      expect(prepareRendererJob(aliased).ownerRoot).toBe(prepareRendererJob(request).ownerRoot)
      let close: (value: RendererClose) => void = () => {
        throw new Error('Uninitialized close.')
      }
      const closed = new Promise<RendererClose>((resolve) => {
        close = resolve
      })
      let count = 0
      const dispatcher = createRendererDispatcher({
        prepare: prepareRendererJob,
        launch: () => {
          count += 1
          return {
            output: { descriptor: 0, closed: true },
            scratch: { path: '/injected/scratch', state: 'removed' },
            handle: { injected: true },
            pid: 42,
            directory: '/injected/scratch',
            started: Promise.resolve(),
            closed,
            terminate: () => {},
            closeOutput: () => {},
            readOutput: () => ({ ok: true, value: 0 }),
            cleanup: () => {},
            retain: () => {},
          }
        },
        schedule: () => () => {},
      })
      const running = dispatcher.start(aliased)
      expect(() => dispatcher.start(request)).toThrow(/admission occupied/)
      expect(count).toBe(1)
      close({ code: 0, signal: null })
      expect(await running.result).toBe(0)
    })
  })

  it('rejects wrong owner, relative roots, excessive counts and nonserializable options before launch', () => {
    let count = 0
    const dispatcher = createRendererDispatcher({
      prepare: prepareRendererJob,
      launch: () => {
        count += 1
        throw new Error('Must not launch')
      },
      schedule: () => () => {},
    })
    expect(() => dispatcher.start({ ...request, ownerRoot: projectRoot })).toThrow(/actual snippet workspace/)
    expect(() => dispatcher.start({ ...request, projectRoot: 'relative' })).toThrow(/absolute/)
    expect(() =>
      dispatcher.start({
        ...request,
        mode: 'render',
        inputs: Array.from({ length: renderInputLimit + 1 }, () => ({ code: '', language: 'ts', lineOwners: [] })),
      }),
    ).toThrow(/input count bound/)
    const runtime = {
      snippetTsconfigPath: './tsconfig.json',
      toJSON: () => {
        throw new Error('Must not execute a callback.')
      },
    }
    expect(() => dispatcher.start({ ...request, runtime })).toThrow(/serializable/)
    const accessorJob = Object.defineProperty({ ...request }, 'projectRoot', {
      get: () => {
        throw new Error('Must not execute a getter.')
      },
    })
    expect(() => dispatcher.start(accessorJob)).toThrow(/without accessors/)
    expect(count).toBe(0)
  })

  it('rejects an oversized request before launch', () => {
    let count = 0
    const dispatcher = createRendererDispatcher({
      prepare: prepareRendererJob,
      launch: () => {
        count += 1
        throw new Error('Must not launch')
      },
      schedule: () => () => {},
    })
    expect(() =>
      dispatcher.start({
        ...request,
        mode: 'render',
        inputs: [{ code: 'x'.repeat(jobByteLimit + 1), language: 'ts', lineOwners: [] }],
      }),
    ).toThrow(/exceeds 16 MiB/)
    expect(count).toBe(0)
  })

  it('keeps the child local import closure away from all parent process capabilities', () => {
    const root = fileURLToPath(new URL('.', import.meta.url))
    const forbidden = new Set(['renderer-job.ts', 'renderer-parent.ts', 'renderer.ts', 'cli/snippets.ts'])
    const visited = new Set<string>()
    const walk = (filename: string) => {
      const relative = path.relative(root, filename)
      expect(forbidden.has(relative), `forbidden child import ${relative}`).toBe(false)
      if (visited.has(filename) === true) return
      visited.add(filename)
      const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
      const dependency = (specifier: string) => {
        expect(['node:child_process', 'child_process'].includes(specifier), `process import in ${relative}`).toBe(false)
        if (specifier.startsWith('.') === false) return
        const resolved = path.resolve(path.dirname(filename), specifier)
        if (resolved.startsWith(root) === false) throw new Error('Owned child import escaped its source root.')
        walk(resolved)
      }
      const visit = (node: ts.Node) => {
        if (
          (ts.isImportDeclaration(node) === true || ts.isExportDeclaration(node) === true) &&
          node.moduleSpecifier !== undefined &&
          ts.isStringLiteral(node.moduleSpecifier) === true
        )
          dependency(node.moduleSpecifier.text)
        if (
          ts.isCallExpression(node) === true &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) === true && node.expression.text === 'require'))
        ) {
          const argument = node.arguments[0]
          if (argument !== undefined && ts.isStringLiteral(argument) === true) dependency(argument.text)
          else throw new Error(`Unbounded dynamic import in ${relative}.`)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    walk(path.join(root, 'renderer-child.ts'))
    expect(visited.has(path.join(root, 'cli/snippet-build.ts'))).toBe(true)
    expect(visited.has(path.join(root, 'renderer-local.ts'))).toBe(true)
    for (const filename of visited) {
      expect(fs.readFileSync(filename, 'utf8').split('\n').length, filename).toBeLessThan(400)
    }
  })
})
