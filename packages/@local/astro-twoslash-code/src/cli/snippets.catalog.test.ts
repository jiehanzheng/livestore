import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTwoslasher } from 'twoslash-vue'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { buildSnippetBundle } from '../vite/snippet-graph.ts'
import { assembleSnippet, guessLanguage } from './snippet-source.ts'
import { createVirtualFiles, resolveFocusVirtualPath } from './snippet-virtual-files.ts'

const snippetRoot = fileURLToPath(new URL('./test-fixtures/catalog', import.meta.url))
const tsconfigPath = path.join(snippetRoot, 'tsconfig.json')
const loadCompilerOptions = () => {
  const configSource = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
  if (configSource.error !== undefined) {
    const message = ts.flattenDiagnosticMessageText(configSource.error.messageText, '\n')
    throw new Error(`Unable to read test fixture tsconfig: ${message}`)
  }

  const parsed = ts.parseJsonConfigFileContent(
    configSource.config,
    ts.sys,
    path.dirname(tsconfigPath),
    undefined,
    tsconfigPath,
  )

  if (parsed.errors.length > 0)
    throw new Error(
      ts.formatDiagnostics(parsed.errors, {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => snippetRoot,
        getNewLine: () => '\n',
      }),
    )

  const {
    incremental: _incremental,
    composite: _composite,
    tsBuildInfoFile: _tsBuildInfoFile,
    ...options
  } = parsed.options

  return {
    ...options,
    noEmit: true,
  }
}

const runTwoslashOnFixture = (entryRelativePath: string) => {
  const entryFilePath = path.join(snippetRoot, entryRelativePath)
  const bundle = buildSnippetBundle({ entryFilePath, baseDir: snippetRoot })
  const virtualFiles = createVirtualFiles(bundle.files, bundle.fileOrder)
  const focusVirtualPath = resolveFocusVirtualPath(virtualFiles, bundle.mainFileRelativePath)
  const assembled = assembleSnippet(
    virtualFiles.map((file) => ({ virtualPath: file.virtualPath, content: file.content })),
    focusVirtualPath,
  )
  const compilerOptions = loadCompilerOptions()
  const tsLibDirectory = path.dirname(ts.getDefaultLibFilePath(compilerOptions))

  const twoslasher = createTwoslasher({
    vfsRoot: snippetRoot,
    tsModule: ts,
    tsLibDirectory,
    compilerOptions,
  })
  return twoslasher(assembled.code, guessLanguage(entryRelativePath, 'ts'), { compilerOptions })
}

describe('Twoslash renderer fixtures', () => {
  it('successfully renders a basic bundle with local imports', async () => {
    const result = runTwoslashOnFixture('basic/store.ts')
    expect(result.errors).toHaveLength(0)
  })

  it('handles worker query imports present in docs snippets', async () => {
    const result = runTwoslashOnFixture('worker-loader/app/store.ts')
    expect(result.errors).toHaveLength(0)
  })

  it('resolves canonical LiveStore schema pattern without TypeScript diagnostics', () => {
    const result = runTwoslashOnFixture('reference/solid-integration/app.tsx')
    expect(result.errors.map((error) => error.text)).toEqual([])
  })
})
