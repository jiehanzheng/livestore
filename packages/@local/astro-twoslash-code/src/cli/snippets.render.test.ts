import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { toHtml } from 'hast-util-to-html'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Effect } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { resolveProjectPaths } from '../project-paths.ts'
import { startRendererJob } from '../renderer-job.ts'
import { createSnippetRenderer } from '../renderer.ts'
import { buildSnippetBundle } from '../vite/snippet-graph.ts'
import { renderSnippet } from './snippet-render.ts'
import { assembleSnippet, guessLanguage, sanitizeSnippetContent } from './snippet-source.ts'
import { createVirtualFiles, remapVirtualPathsForFocus, resolveFocusVirtualPath } from './snippet-virtual-files.ts'

const packageRoot = fileURLToPath(new URL('../..', import.meta.url))
const workspaceRoot = process.env.WORKSPACE_ROOT ?? path.resolve(packageRoot, '../../..')
const exampleProjectRoot = path.join(packageRoot, 'example')
type TRenderer = Parameters<typeof renderSnippet>[0]
let exampleRenderer: TRenderer | undefined
let examplePaths: ReturnType<typeof resolveProjectPaths>
let docsRenderer: TRenderer | undefined
let docsPaths: ReturnType<typeof resolveProjectPaths>

const requireRenderer = (renderer: TRenderer | undefined): TRenderer => {
  if (renderer === undefined) throw new Error('Renderer fixture was not acquired.')
  return renderer
}

// Register before setup: a failed second acquisition still owns the first.
// Settle disposals independently so either failure cannot abandon the other.
afterAll(async () => {
  const disposed = await Promise.allSettled(
    [exampleRenderer, docsRenderer].map(async (renderer) => renderer?.dispose()),
  )
  const failures = disposed.filter((result) => result.status === 'rejected').map((result) => result.reason)
  if (failures.length > 0) throw new AggregateError(failures, 'Renderer fixture disposal failed.')
})
beforeAll(async () => {
  examplePaths = resolveProjectPaths(exampleProjectRoot)
  exampleRenderer = await createSnippetRenderer(examplePaths, {})
  docsPaths = resolveProjectPaths(path.join(workspaceRoot, 'docs'))
  docsRenderer = await createSnippetRenderer(docsPaths, {})
})

const stripTwoslashPopups = (input: string): string => {
  const target = '<span class="twoslash-popup-container'
  let result = ''
  let cursor = 0

  while (cursor < input.length) {
    const start = input.indexOf(target, cursor)
    if (start === -1) {
      result += input.slice(cursor)
      break
    }

    result += input.slice(cursor, start)
    let depth = 0
    let index = start

    while (index < input.length) {
      const nextOpen = input.indexOf('<span', index)
      const nextClose = input.indexOf('</span>', index)
      if (nextClose === -1) {
        index = input.length
        break
      }
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1
        index = nextOpen + 5
        continue
      }
      depth -= 1
      index = nextClose + 7
      if (depth <= 0) {
        break
      }
    }

    cursor = index
  }

  return result
}

const stripMarkup = (input: string) =>
  stripTwoslashPopups(input)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[#0-9a-zA-Z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
describe('renderSnippet integration', () => {
  it('checks and renders the actual Vue provider and query templates', async () => {
    for (const filename of ['getting-started/vue/app.vue', 'getting-started/vue/queries.vue']) {
      const bundle = buildSnippetBundle({
        entryFilePath: path.join(docsPaths.snippetAssetsRoot, filename),
        baseDir: docsPaths.snippetAssetsRoot,
      })
      const rendered = await Effect.runPromise(renderSnippet(requireRenderer(docsRenderer), bundle, filename))
      expect(rendered.diagnostics).toEqual([])
      expect(rendered.html).toContain('<code>')
      expect(rendered.html).not.toContain('__LS_FILE')
    }
  })

  it('resolves real Vue imports after TypeScript rendered the same module virtually', async () => {
    const inputs = [
      'reference/framework-integrations/vue/schema.ts',
      'reference/framework-integrations/vue/use-query.vue',
    ].map((name) => {
      const bundle = buildSnippetBundle({
        entryFilePath: path.join(docsPaths.snippetAssetsRoot, name),
        baseDir: docsPaths.snippetAssetsRoot,
      })
      const files = remapVirtualPathsForFocus(createVirtualFiles(bundle.files, bundle.fileOrder), name)
      const { code, lines } = assembleSnippet(files, resolveFocusVirtualPath(files, name))
      return { code, language: guessLanguage(name), lineOwners: lines.map(({ owner, marker }) => ({ owner, marker })) }
    })
    const job = startRendererJob({
      mode: 'render',
      projectRoot: docsPaths.projectRoot,
      ownerRoot: docsPaths.snippetAssetsRoot,
      runtime: {},
      inputs,
    })
    await expect(job.result).resolves.toHaveLength(2)
  })

  it.each([
    ['inline setup', 'const count = 1'],
    ['a trailing setup comment', '\nconst count = 1 // comment'],
  ])('renders Vue with %s', async (_layout, script) => {
    const code = `<script setup lang="ts">${script}</script>\n<template>{{ count }}</template>`
    const rendered = await requireRenderer(docsRenderer).render({
      code,
      language: 'vue',
      lineOwners: code.split('\n').map(() => ({ owner: './app.vue', marker: null })),
    })
    expect(rendered.renderedGroupAst.type).toBe('element')
  })

  it('rejects a Vue template that reads a nonexistent property', async () => {
    const code = '<script setup lang="ts">const count = 1</script>\n<template>{{ count.missing }}</template>'
    await expect(
      requireRenderer(docsRenderer).render({
        code,
        language: 'vue',
        lineOwners: code.split('\n').map(() => ({ owner: './app.vue', marker: null })),
      }),
    ).rejects.toThrow(/\[2339\].*Property 'missing'/)
  })

  it('fails closed on unexpected type errors', async () => {
    await expect(
      requireRenderer(exampleRenderer).render({
        code: 'const value: string = 1',
        language: 'ts',
        lineOwners: [{ owner: './main.ts', marker: null }],
      }),
    ).rejects.toThrow(/not assignable/)
  })

  it('renders expected diagnostics and Markdown links in type hovers', async () => {
    const code = [
      '// @errors: 2322',
      '/** See [the guide](https://example.com/guide). */',
      'const value: string = 1',
      'console.log(value)',
    ].join('\n')
    const rendered = await requireRenderer(exampleRenderer).render({
      code,
      language: 'ts',
      lineOwners: code.split('\n').map(() => ({ owner: './main.ts', marker: null })),
    })
    const html = toHtml(rendered.renderedGroupAst)
    expect(html).toContain('twoslash-popup-error')
    expect(html).toContain('not assignable to type')
    expect(html).toContain('href="https://example.com/guide"')
  })
  it('does not rewrite literal cut marker content', () => {
    const source = [
      "const message = '// ---cut--- should stay literal'",
      'const inline = 1 // ---cut--- explanation',
      'const double = "// ---cut---"',
    ].join('\n')

    const sanitized = sanitizeSnippetContent(source)

    expect(sanitized).toBe(source)
  })

  it('emits isolated HTML for each file in a multi-file snippet', async () => {
    const entryFilePath = path.join(examplePaths.snippetAssetsRoot, 'main.ts')
    const bundle = buildSnippetBundle({ entryFilePath, baseDir: examplePaths.snippetAssetsRoot })

    const renderFile = async (filename: string) =>
      Effect.runPromise(renderSnippet(requireRenderer(exampleRenderer), bundle, filename))

    const renderedMain = await renderFile('main.ts')
    const renderedUtils = await renderFile('utils.ts')

    const mainHtml = renderedMain.html ?? ''
    const utilsHtml = renderedUtils.html ?? ''

    const mainText = stripMarkup(mainHtml)
    const utilsText = stripMarkup(utilsHtml)

    expect(mainText).toMatch(/export const\s+message/)
    expect(mainText).not.toMatch(/export const\s+greet\s*=\s*\(\s*name/)
    expect(utilsText).toMatch(/export const\s+greet\s*=\s*\(\s*name\s*:\s*string/)
    expect(utilsText).not.toMatch(/export const\s+message/)
    expect(mainHtml).not.toMatch(/__LS_FILE_(START|END)__/)
    expect(utilsHtml).not.toMatch(/__LS_FILE_(START|END)__/)
    expect(mainHtml).not.toContain('// @filename:')
    expect(utilsHtml).not.toContain('// @filename:')
    expect(mainHtml).not.toEqual(utilsHtml)

    const extractDataCode = (html: string): string => {
      const match = html.match(/data-code="([^"]*)"/)
      return match?.[1] ?? ''
    }
    const decodeDataCode = (value: string): string => value.replace(/\u007f/g, '\n')

    const mainDataCode = extractDataCode(mainHtml)
    const utilsDataCode = extractDataCode(utilsHtml)
    const decodedMainDataCode = decodeDataCode(mainDataCode)

    expect(mainDataCode).toContain('message')
    expect(decodedMainDataCode).toContain('\n\nexport const message')
    expect(mainDataCode).not.toMatch(/__LS_FILE_(START|END)__/)
    expect(utilsDataCode).toContain('greet = (name: string)')
    expect(utilsDataCode).not.toMatch(/__LS_FILE_(START|END)__/)
  })

  it('restarts focus ownership after cut markers', () => {
    const focusVirtualPath = './focus.ts'
    const focusContent = sanitizeSnippetContent(
      ['export const first = true', '// ---cut---', 'export const second = true'].join('\n'),
    )

    const assembled = assembleSnippet([{ virtualPath: focusVirtualPath, content: focusContent }], focusVirtualPath)
    const focusStarts = assembled.lines.filter(
      (line) => line.marker === 'start' && line.content.includes(focusVirtualPath),
    )

    expect(focusStarts).toHaveLength(2)
  })

  it('trims trailing blank lines from snippet payloads', async () => {
    const entryFilePath = path.join(examplePaths.snippetAssetsRoot, 'main.ts')
    const bundle = buildSnippetBundle({ entryFilePath, baseDir: examplePaths.snippetAssetsRoot })
    const mainRecord = bundle.files[bundle.mainFileRelativePath]
    if (mainRecord == null) {
      throw new Error(`Missing main file record for ${bundle.mainFileRelativePath}`)
    }

    const paddedFiles: typeof bundle.files = {
      ...bundle.files,
      [bundle.mainFileRelativePath]: {
        ...mainRecord,
        content: `${mainRecord.content}\n\n`,
      },
    }

    const paddedBundle = {
      ...bundle,
      files: paddedFiles,
    }

    const rendered = await Effect.runPromise(
      renderSnippet(requireRenderer(exampleRenderer), paddedBundle, bundle.mainFileRelativePath),
    )

    const dataCode = rendered.html?.match(/data-code="([^"]*)"/)?.[1] ?? ''
    const decoded = dataCode.replace(/\u007f/g, '\n')
    const blankLines = rendered.html?.match(/<div class="line"><\/div>/g) ?? []

    expect(decoded).toContain('\n\nexport const message')
    expect(decoded.endsWith('\n')).toBe(false)
    expect(blankLines.length).toBe(1)
  })

  it('renders type hovers while keeping copy text free of hover content', async () => {
    const bundle = buildSnippetBundle({
      entryFilePath: path.join(examplePaths.snippetAssetsRoot, 'main.ts'),
      baseDir: examplePaths.snippetAssetsRoot,
    })
    const rendered = await Effect.runPromise(renderSnippet(requireRenderer(exampleRenderer), bundle, 'main.ts'))
    expect(rendered.html).toContain('twoslash-popup-container')
    const dataCode = rendered.html?.match(/data-code="([^"]*)"/)?.[1] ?? ''
    expect(dataCode).not.toContain('twoslash-popup')
    expect(dataCode).not.toContain('__LS_FILE')
  })

  it('renders the docs minimal example without leaking sentinel metadata', async () => {
    const entryFilePath = path.join(docsPaths.snippetAssetsRoot, 'getting-started/node/minimal-example.ts')
    const bundle = buildSnippetBundle({ entryFilePath, baseDir: docsPaths.snippetAssetsRoot })

    const renderFile = async (filename: string) =>
      Effect.runPromise(renderSnippet(requireRenderer(docsRenderer), bundle, filename))

    const renderedMain = await renderFile('getting-started/node/minimal-example.ts')
    const renderedSchema = await renderFile('getting-started/node/livestore/schema.ts')

    const mainHtml = renderedMain.html ?? ''
    const schemaHtml = renderedSchema.html ?? ''

    expect(mainHtml).not.toMatch(/__LS_FILE_(START|END)__/)
    expect(schemaHtml).not.toMatch(/__LS_FILE_(START|END)__/)
    expect(schemaHtml).not.toContain('// @filename:')
    expect(schemaHtml).not.toContain('data-ls-owner')
    expect(schemaHtml).not.toContain('data-ls-marker')
    expect(schemaHtml).toContain('defineMaterializer(')
    expect(stripMarkup(schemaHtml)).toMatch(/export const schema = makeSchema/)
    expect(schemaHtml).not.toContain('const main = async () =>')

    const mainDataCode = mainHtml.match(/data-code="([^"]*)"/)?.[1] ?? ''
    const schemaDataCode = schemaHtml.match(/data-code="([^"]*)"/)?.[1] ?? ''
    const decodeDataCode = (value: string): string => value.replace(/\u007f/g, '\n')

    expect(mainDataCode).not.toMatch(/__LS_FILE_(START|END)__/)
    expect(schemaDataCode).not.toMatch(/__LS_FILE_(START|END)__/)
    expect(decodeDataCode(schemaDataCode)).toContain('defineMaterializer(events.todoCreated')
    expect(decodeDataCode(schemaDataCode)).not.toContain('__LS_FILE')
    expect(decodeDataCode(schemaDataCode)).not.toContain('const main = async () =>')
    expect(decodeDataCode(mainDataCode)).toContain('const main = async () =>')
    expect(decodeDataCode(mainDataCode)).not.toContain('defineMaterializer(')
  }, 15000) // needs higher timeout to avoid renderer flake on CI

  it('retains focus boundaries when snippets use cut markers', async () => {
    const entryFilePath = path.join(docsPaths.snippetAssetsRoot, 'reference/platform-adapters/node-adapter/adapter.ts')
    const bundle = buildSnippetBundle({ entryFilePath, baseDir: docsPaths.snippetAssetsRoot })

    const rendered = await Effect.runPromise(
      renderSnippet(requireRenderer(docsRenderer), bundle, 'reference/platform-adapters/node-adapter/adapter.ts'),
    )

    const html = rendered.html ?? ''
    expect(stripMarkup(html)).toMatch(/const adapter = makeAdapter/)
    expect(html).not.toMatch(/__LS_FILE_(START|END)__/)
    expect(html).not.toContain('// ---cut---')

    const dataCodeMatch = html.match(/data-code="([^"]*)"/)
    const dataCode = dataCodeMatch?.[1] ?? ''
    expect(dataCode).toContain('const adapter = makeAdapter')
    expect(dataCode).not.toMatch(/__LS_FILE_(START|END)__/)
  })
})

describe('Sentinel node removal regression', () => {
  it('should not remove <pre> element when it contains sentinel markers in aggregate text', async () => {
    // This is a regression test for a bug where removeSentinelNodes was called on the entire
    // <pre> element after filtering lines. Since the <pre> element's aggregate text contained
    // sentinel markers (from the __LS_FILE_START__/__LS_FILE_END__ markers), it would remove
    // the entire <pre> element, resulting in empty code blocks in the rendered HTML.

    const entryFilePath = path.join(docsPaths.snippetAssetsRoot, 'patterns/auth/store-with-auth.tsx')
    const bundle = buildSnippetBundle({ entryFilePath, baseDir: docsPaths.snippetAssetsRoot })

    const rendered = await Effect.runPromise(
      renderSnippet(requireRenderer(docsRenderer), bundle, 'patterns/auth/store-with-auth.tsx'),
    )

    const html = rendered.html ?? ''

    // Critical checks: The HTML must contain <pre> and <code> tags
    expect(html).toContain('<pre')
    expect(html).toContain('<code')

    // The <pre> tag should not be empty
    expect(html).not.toMatch(/<pre[^>]*>\s*<\/pre>/)

    // Should contain the actual code content
    expect(html).toContain('useAppStore')
    expect(html).toContain('StoreRegistryProvider')
    expect(html).toContain('syncPayload')

    // Should NOT contain sentinel markers in the final output
    expect(html).not.toContain('__LS_FILE_START__')
    expect(html).not.toContain('__LS_FILE_END__')
    expect(html).not.toContain('// ---cut---')
  })

  it('should not remove <pre> element for keep-payload-canonical snippet', async () => {
    const entryFilePath = path.join(docsPaths.snippetAssetsRoot, 'patterns/auth/keep-payload-canonical.ts')
    const bundle = buildSnippetBundle({ entryFilePath, baseDir: docsPaths.snippetAssetsRoot })

    const rendered = await Effect.runPromise(
      renderSnippet(requireRenderer(docsRenderer), bundle, 'patterns/auth/keep-payload-canonical.ts'),
    )

    const html = rendered.html ?? ''

    // Critical checks: The HTML must contain <pre> and <code> tags
    expect(html).toContain('<pre')
    expect(html).toContain('<code')

    // The <pre> tag should not be empty
    expect(html).not.toMatch(/<pre[^>]*>\s*<\/pre>/)

    // Should contain the actual code content
    expect(html).toContain('ensureAuthorized')
    expect(html).toContain('validatePayload')

    // Should NOT contain sentinel markers
    expect(html).not.toContain('__LS_FILE_START__')
    expect(html).not.toContain('__LS_FILE_END__')
  })
})
