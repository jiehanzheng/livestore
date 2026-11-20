import crypto from 'node:crypto'
import path from 'node:path'

import { Cause, Effect, type FileSystem, Result, Schema } from '@livestore/utils/effect'

import type { TwoslashProjectPaths } from '../project-paths.ts'
import { buildSnippetBundle } from '../vite/snippet-graph.ts'
import { isWithinDirectory, type TSnippetEntry } from './snippet-entries.ts'
import { SnippetBuildError } from './snippet-error.ts'
import { renderSnippet, type TRenderedSnippet, type TSnippetRenderer } from './snippet-render.ts'

const jsonStringify = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const jsonParse = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))
const jsonStringifyPretty = (value: unknown): string => JSON.stringify(value, null, 2)
const hashString = (value: string): string => crypto.createHash('sha256').update(value).digest('hex')

type TSnippetArtifact = {
  version: 1
  entryFile: string
  mainFilename: string
  bundleHash: string
  generatedAt: string
  fileOrder: readonly string[]
  files: Record<
    string,
    {
      content: string
      isMain: boolean
      hash: string
    }
  >
  rendered: Record<string, TRenderedSnippet>
}

export type TSnippetManifest = {
  version: 1
  generatedAt: string
  configHash: string
  baseStyles: string
  themeStyles: string
  jsModules: readonly string[]
  entries: readonly {
    entryFile: string
    mainFilename: string
    artifactPath: string
    bundleHash: string
  }[]
}

export type TManifestEntry = {
  entryFile: string
  mainFilename: string
  artifactPath: string
  bundleHash: string
}

type TPreviousManifest = {
  entries: Map<string, TManifestEntry>
}

type ArtifactBuildContext = {
  fs: FileSystem.FileSystem
  paths: TwoslashProjectPaths
  renderer: TSnippetRenderer
  previousEntries: Map<string, TManifestEntry>
  inputBudget: { remaining: number }
}

export const loadPreviousManifest = (
  fs: FileSystem.FileSystem,
  paths: TwoslashProjectPaths,
  expectedConfigHash: string,
): Effect.Effect<TPreviousManifest | null> =>
  Effect.gen(function* () {
    const manifestExistsResult = yield* fs.exists(paths.manifestPath).pipe(Effect.result)
    if (Result.isFailure(manifestExistsResult) === true) {
      yield* Effect.logWarning(
        `Unable to check existing snippet manifest at ${paths.manifestPath}: ${String(manifestExistsResult.failure)}`,
      )
      return null
    }
    if (manifestExistsResult.success === false) {
      return null
    }

    const manifestSourceResult = yield* fs.readFileString(paths.manifestPath).pipe(Effect.result)
    if (Result.isFailure(manifestSourceResult) === true) {
      yield* Effect.logWarning(
        `Unable to read existing snippet manifest at ${paths.manifestPath}: ${String(manifestSourceResult.failure)}`,
      )
      return null
    }

    const manifestSource = manifestSourceResult.success
    const parsedResult = yield* Effect.try({
      try: () => jsonParse(manifestSource) as TSnippetManifest,
      catch: (cause) => new Cause.UnknownError(cause),
    }).pipe(Effect.result)
    if (Result.isFailure(parsedResult) === true) {
      yield* Effect.logWarning(
        `Unable to parse existing snippet manifest at ${paths.manifestPath}: ${String(parsedResult.failure)}`,
      )
      return null
    }
    const parsed = parsedResult.success

    if (parsed.version !== 1 || parsed.configHash !== expectedConfigHash) {
      return null
    }

    const entries = new Map<string, TManifestEntry>()
    for (const entry of parsed.entries ?? []) {
      if (entry?.entryFile == null) continue
      entries.set(entry.entryFile, {
        entryFile: entry.entryFile,
        mainFilename: entry.mainFilename,
        artifactPath: entry.artifactPath,
        bundleHash: entry.bundleHash,
      })
    }

    return { entries }
  })

export const buildSnippetArtifact = (
  entry: TSnippetEntry,
  { fs, paths, renderer, previousEntries, inputBudget }: ArtifactBuildContext,
) =>
  Effect.gen(function* () {
    const bundle = buildSnippetBundle({
      entryFilePath: entry.entryPath,
      baseDir: paths.snippetAssetsRoot,
    })
    if (bundle.fileOrder.length > inputBudget.remaining) {
      return yield* new SnippetBuildError({
        message: 'Snippet owner batch exceeds its render-input count bound.',
        entry: entry.entryPath,
      })
    }
    inputBudget.remaining -= bundle.fileOrder.length

    if (isWithinDirectory(bundle.entryFilePath, paths.snippetAssetsRoot) === false) {
      return yield* new SnippetBuildError({
        message: `Snippet entry ${bundle.entryFilePath} is outside the snippet root (${paths.snippetAssetsRoot}). Copy the file into the docs snippet assets and import it from there.`,
        entry: entry.entryPath,
      })
    }

    for (const file of Object.values(bundle.files)) {
      if (isWithinDirectory(file.absolutePath, paths.snippetAssetsRoot) === false) {
        return yield* new SnippetBuildError({
          message: `Snippet file ${file.absolutePath} is outside the snippet root (${paths.snippetAssetsRoot}). Move or copy it under the snippet assets directory.`,
          entry: entry.entryPath,
        })
      }
    }

    const entryFileRelative = path.relative(paths.snippetAssetsRoot, bundle.entryFilePath).replace(/\\/g, '/')

    const filesWithHash = bundle.fileOrder.map((filename, index) => {
      const file = bundle.files[filename]
      if (file == null) {
        throw new SnippetBuildError({
          message: `Snippet bundle missing file record for ${filename}`,
          entry: entry.entryPath,
        })
      }
      return {
        filename,
        content: file.content,
        isMain: index === 0,
        hash: hashString(file.content),
      }
    })

    const bundleHash = hashString(
      jsonStringify({
        files: filesWithHash.map((file) => ({
          filename: file.filename,
          hash: file.hash,
        })),
        meta: 'twoslash',
      }),
    )

    const cachedEntry = previousEntries.get(entryFileRelative)
    if (cachedEntry !== undefined && cachedEntry.bundleHash === bundleHash) {
      const cachedArtifactPath = path.join(paths.cacheRoot, cachedEntry.artifactPath)
      const cachedArtifactExists = yield* fs.exists(cachedArtifactPath)
      if (cachedArtifactExists === true) {
        return {
          rendered: false,
          entry: {
            entryFile: cachedEntry.entryFile,
            mainFilename: cachedEntry.mainFilename,
            artifactPath: cachedEntry.artifactPath,
            bundleHash: cachedEntry.bundleHash,
          },
        }
      }
    }

    yield* Effect.log(`Rendering snippet bundle for ${entry.entryPath}`)

    const renderedSnippets: Record<string, TRenderedSnippet> = {}
    for (const filename of bundle.fileOrder) {
      const rendered = yield* renderSnippet(renderer, bundle, filename)
      if (rendered.html === null && rendered.diagnostics.length > 0) {
        yield* Effect.logWarning(`Twoslash pre-rendering skipped for ${entry.entryPath}: ${rendered.diagnostics[0]}`)
      }
      renderedSnippets[filename] = rendered
    }

    const artifact: TSnippetArtifact = {
      version: 1,
      entryFile: entryFileRelative,
      mainFilename: bundle.mainFileRelativePath,
      bundleHash,
      generatedAt: new Date().toISOString(),
      fileOrder: bundle.fileOrder,
      files: filesWithHash.reduce<
        Record<
          string,
          {
            content: string
            isMain: boolean
            hash: string
          }
        >
      >((acc, file) => {
        acc[file.filename] = {
          content: file.content,
          isMain: file.isMain,
          hash: file.hash,
        }
        return acc
      }, {}),
      rendered: renderedSnippets,
    }

    const artifactPath = path.resolve(paths.cacheRoot, `${bundle.mainFileRelativePath}.json`)
    if (isWithinDirectory(artifactPath, paths.cacheRoot) === false) {
      return yield* new SnippetBuildError({
        message: `Resolved artefact path escapes cache root: ${artifactPath}`,
        entry: entry.entryPath,
      })
    }
    yield* fs.makeDirectory(path.dirname(artifactPath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new SnippetBuildError({
            message: `Failed to create cache path for ${artifactPath}`,
            cause,
          }),
      ),
    )

    yield* fs.writeFileString(artifactPath, `${jsonStringifyPretty(artifact)}\n`).pipe(
      Effect.mapError(
        (cause) =>
          new SnippetBuildError({
            message: `Unable to write artifact ${artifactPath}`,
            cause,
          }),
      ),
    )

    return {
      rendered: true,
      entry: {
        entryFile: artifact.entryFile,
        mainFilename: artifact.mainFilename,
        artifactPath: path.relative(paths.cacheRoot, artifactPath).replace(/\\/g, '/'),
        bundleHash: artifact.bundleHash,
      },
    }
  }).pipe(
    Effect.withSpan(`buildSnippet:${entry.entryPath}`, {
      attributes: { entryPath: entry.entryPath },
    }),
  )
