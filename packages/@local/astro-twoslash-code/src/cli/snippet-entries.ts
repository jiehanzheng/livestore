import path from 'node:path'

import { Effect, type FileSystem } from '@livestore/utils/effect'

import { SnippetBuildError } from './snippet-error.ts'

const SNIPPET_IMPORT_REGEX = /['"]([^'"\n]+\?snippet[^'"]*)['"]/g
export const SUPPORTED_SOURCE_EXTENSIONS = new Set([
  '.astro',
  '.md',
  '.mdx',
  '.ts',
  '.mts',
  '.tsx',
  '.js',
  '.mjs',
  '.jsx',
])
const EXCLUDED_DIRECTORIES = new Set(['node_modules', '.git', '.cache', 'dist', '.astro', '.netlify', 'logs'])

export const isWithinDirectory = (candidate: string, directory: string): boolean => {
  const normalizedDirectory = path.resolve(directory)
  const normalizedCandidate = path.resolve(candidate)
  return (
    normalizedCandidate === normalizedDirectory || normalizedCandidate.startsWith(`${normalizedDirectory}${path.sep}`)
  )
}

export const collectSourceFiles = (
  fs: FileSystem.FileSystem,
  directory: string,
): Effect.Effect<readonly string[], SnippetBuildError> =>
  Effect.gen(function* () {
    const entries = yield* fs.readDirectory(directory)
    const files: string[] = []

    for (const name of entries) {
      if (EXCLUDED_DIRECTORIES.has(name) === true) continue
      if (name.startsWith('.') === true) {
        if (!(name === '.gitignore' || name === '.eslintrc' || name === '.prettierrc')) continue
      }

      const fullPath = path.join(directory, name)
      const info = yield* fs.stat(fullPath)

      if (info.type === 'Directory') {
        const nested = yield* collectSourceFiles(fs, fullPath)
        files.push(...nested)
        continue
      }

      if (info.type !== 'File') continue

      if (SUPPORTED_SOURCE_EXTENSIONS.has(path.extname(name)) === false) continue
      files.push(fullPath)
    }

    return files
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SnippetBuildError({
          message: `Failed to scan directory: ${directory}`,
          cause,
        }),
    ),
  )

export type TSnippetEntry = {
  entryPath: string
  importers: readonly string[]
}

/**
 * Parses all documentation sources and returns the set of snippet entrypoints.
 * Each entry retains the list of files that import it, which is useful for diagnostics.
 */
export const collectSnippetEntries = (
  fs: FileSystem.FileSystem,
  files: readonly string[],
): Effect.Effect<readonly TSnippetEntry[], SnippetBuildError> =>
  Effect.gen(function* () {
    const entries = new Map<string, { entryPath: string; importers: Set<string> }>()

    for (const filePath of files) {
      const source = yield* fs.readFileString(filePath).pipe(
        Effect.mapError(
          (cause) =>
            new SnippetBuildError({
              message: `Unable to read ${filePath}`,
              cause,
            }),
        ),
      )

      const dir = path.dirname(filePath)
      let match: RegExpExecArray | null = SNIPPET_IMPORT_REGEX.exec(source)
      while (match !== null) {
        const specifier = match[1]
        if (typeof specifier !== 'string') {
          match = SNIPPET_IMPORT_REGEX.exec(source)
          continue
        }
        const [rawPath] = specifier.split('?')
        if (rawPath == null || !(rawPath.startsWith('./') === true || rawPath.startsWith('../') === true)) {
          match = SNIPPET_IMPORT_REGEX.exec(source)
          continue
        }

        const resolved = path.resolve(dir, rawPath)
        const exists = yield* fs.exists(resolved).pipe(
          Effect.mapError(
            (cause) =>
              new SnippetBuildError({
                message: `Failed to resolve ${resolved}`,
                cause,
              }),
          ),
        )
        if (exists === false) {
          match = SNIPPET_IMPORT_REGEX.exec(source)
          continue
        }

        const record = entries.get(resolved)
        if (record !== undefined) {
          record.importers.add(filePath)
        } else {
          entries.set(resolved, {
            entryPath: resolved,
            importers: new Set([filePath]),
          })
        }

        match = SNIPPET_IMPORT_REGEX.exec(source)
      }
      SNIPPET_IMPORT_REGEX.lastIndex = 0
    }

    return Array.from(entries.values()).map(({ entryPath, importers }) => ({
      entryPath,
      importers: Array.from(importers).toSorted(),
    }))
  })
