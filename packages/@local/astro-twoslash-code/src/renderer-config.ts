import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import * as ts from 'typescript'

import type { TwoslashProjectPaths } from './project-paths.ts'

export type LineOwnerMarker = 'start' | 'end'
export type LineOwnerMetadata = { owner: string | null; marker: LineOwnerMarker | null }
export type TwoslashRuntimeOptions = {
  snippetTsconfigPath?: string
  compilerOptions?: Partial<ts.CompilerOptions>
}

const hashString = (value: string): string => crypto.createHash('sha256').update(value).digest('hex')

const stableStringify = (value: unknown): string => {
  if (value === null) return 'null'
  const valueType = typeof value
  if (valueType === 'number' || valueType === 'boolean') {
    return JSON.stringify(value)
  }
  if (valueType === 'string') {
    return JSON.stringify(value)
  }
  if (valueType === 'undefined') {
    return '"__undefined__"'
  }
  if (Array.isArray(value) === true) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  }
  if (valueType === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`
  }

  throw new Error(`Unable to serialize value of type ${valueType}`)
}

const resolveTsconfigPath = (paths: TwoslashProjectPaths, overridePath: string | undefined): string => {
  if (overridePath === undefined) {
    return path.join(paths.snippetAssetsRoot, 'tsconfig.json')
  }
  if (path.isAbsolute(overridePath) === true) {
    return overridePath
  }
  return path.resolve(paths.projectRoot, overridePath)
}

const ensureSnippetWorkspace = (snippetRoot: string): void => {
  if (fs.existsSync(snippetRoot) === false) {
    throw new Error(`Unable to locate snippet workspace at ${snippetRoot}`)
  }
}

const parseSnippetTsconfig = (tsconfigPath: string): { source: string; options: ts.CompilerOptions } => {
  if (fs.existsSync(tsconfigPath) === false) {
    throw new Error(`Snippet tsconfig not found at ${tsconfigPath}`)
  }

  const source = fs.readFileSync(tsconfigPath, 'utf8')
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
  if (configFile.error !== undefined) {
    const message = ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')
    throw new Error(`Unable to read ${tsconfigPath}: ${message}`)
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(tsconfigPath),
    undefined,
    tsconfigPath,
  )

  // Keep TypeScript’s config validity rules for file-backed and virtual inputs.
  // Explicitly empty valid projects work without a diagnostic-code allowlist;
  // accidental empty discovery and invalid options must remain visible.
  if (parsed.errors.length > 0) {
    const diagnostics = parsed.errors
      .map((error) => `TS${error.code}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`)
      .join('\n')
    throw new Error(`Invalid snippet configuration ${tsconfigPath}:\n${diagnostics}`, { cause: parsed.errors })
  }
  return { source, options: parsed.options }
}

const mergeCompilerOptions = (
  base: ts.CompilerOptions,
  override: Partial<ts.CompilerOptions> | undefined,
): ts.CompilerOptions => {
  const merged: ts.CompilerOptions = {
    ...base,
    ...override,
    noEmit: true,
  }
  return merged
}

export const createRendererConfig = (paths: TwoslashProjectPaths, options: TwoslashRuntimeOptions = {}) => {
  ensureSnippetWorkspace(paths.snippetAssetsRoot)
  const snippetTsconfigPath = resolveTsconfigPath(paths, options.snippetTsconfigPath)
  const { source, options: baseCompilerOptions } = parseSnippetTsconfig(snippetTsconfigPath)
  const compilerOptions = mergeCompilerOptions(baseCompilerOptions, options.compilerOptions)
  const {
    incremental: _incremental,
    composite: _composite,
    tsBuildInfoFile: _tsBuildInfoFile,
    ...runtimeCompilerOptions
  } = compilerOptions
  return {
    compilerOptions: runtimeCompilerOptions,
    fingerprintHash: hashString(
      stableStringify({
        renderer: 'shiki-twoslash-v1',
        // This private tool runs from workspace source. Transitive renderer
        // dependency changes must invalidate HTML even when snippet text is stable.
        workspaceLockHash: hashString(fs.readFileSync(new URL('../../../../pnpm-lock.yaml', import.meta.url), 'utf8')),
        rendererManifestHash: hashString(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')),
        sourceHashes: Object.fromEntries(
          [
            'renderer-config.ts',
            'renderer-local.ts',
            'vue-script-boundary.cts',
            'renderer.ts',
            'renderer-job.ts',
            'renderer-child.ts',
            'renderer-child-job.ts',
            'renderer-protocol.ts',
            'renderer-owner.ts',
            'renderer-parent.ts',
            'renderer-failure.ts',
            'renderer-launch-resources.ts',
            'renderer-lifetime.ts',
            'renderer-publication.ts',
            'renderer-write.ts',
            'snippet-client.ts',
            'cli/snippet-build.ts',
            'cli/snippet-error.ts',
            'cli/snippet-source.ts',
            'cli/snippet-virtual-files.ts',
            'cli/snippet-hast.ts',
            'cli/snippet-diagnostics.ts',
            'cli/snippet-ownership.ts',
            'cli/snippet-import-restoration.ts',
            'cli/snippet-entries.ts',
            'cli/snippet-render.ts',
            'cli/snippet-artifacts.ts',
            'vite/snippet-graph.ts',
          ].map((file) => [file, hashString(fs.readFileSync(new URL(file, import.meta.url), 'utf8'))]),
        ),
        snippetRoot: paths.snippetAssetsRoot,
        snippetTsconfigPath,
        source,
        compilerOptions,
        typescriptVersion: ts.version,
      }),
    ),
  }
}

export const normalizeRuntimeOptions = (options: TwoslashRuntimeOptions = {}): TwoslashRuntimeOptions => ({
  ...options,
})
