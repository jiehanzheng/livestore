import path from 'node:path'

import type { Duration } from '@livestore/utils/effect'
import { Deferred, Effect, FileSystem, type PlatformError, Result, Stream } from '@livestore/utils/effect'

import type { TwoslashProjectPaths } from '../project-paths.ts'
import { SUPPORTED_SOURCE_EXTENSIONS, isWithinDirectory } from './snippet-entries.ts'
import type { SnippetBuildError } from './snippet-error.ts'

export type SnippetWatchOptions = {
  debounce: Duration.Input
  onRebuild: (info: WatchSnippetsRebuildInfo) => Effect.Effect<void>
}

type WatchScope = 'snippet' | 'source'

type WatchEventSummary = {
  absolutePath: string
  relativePath: string
  scope: WatchScope
  kind: FileSystem.WatchEvent['_tag']
}

export type WatchSnippetsRebuildInfo = {
  reason: 'initial' | 'watch'
  event: WatchEventSummary | null
  renderedCount: number
  durationMs: number
}

const toPosix = (value: string): string => value.replace(/\\/g, '/')

const summarizeWatchEvent = (
  scope: WatchScope,
  root: string,
  cacheRoot: string,
  event: FileSystem.WatchEvent,
): WatchEventSummary | null => {
  const rootAbsolute = path.resolve(root)
  const rawPath = event.path
  const absolutePath = path.resolve(path.isAbsolute(rawPath) === true ? rawPath : path.join(rootAbsolute, rawPath))

  if (scope === 'snippet' && isWithinDirectory(absolutePath, cacheRoot) === true) {
    return null
  }

  if (isWithinDirectory(absolutePath, rootAbsolute) === false) {
    return null
  }

  const extension = path.extname(absolutePath).toLowerCase()
  if (scope === 'source' && extension.length > 0 && SUPPORTED_SOURCE_EXTENSIONS.has(extension) === false) {
    return null
  }

  const relativeRaw = path.relative(rootAbsolute, absolutePath)
  const relativePath = relativeRaw.length === 0 ? '.' : toPosix(relativeRaw)

  return {
    absolutePath,
    relativePath,
    scope,
    kind: event._tag,
  }
}

const createWatchStream = (
  fs: FileSystem.FileSystem,
  scope: WatchScope,
  root: string,
  cacheRoot: string,
  ready: Deferred.Deferred<void, PlatformError.PlatformError>,
): Stream.Stream<WatchEventSummary, PlatformError.PlatformError> =>
  fs
    .watch(root, {
      recursive: true,
      onReady: () => {
        Deferred.doneUnsafe(ready, Effect.void)
      },
    })
    .pipe(
      Stream.onError((cause) => Deferred.failCause(ready, cause)),
      Stream.map((event) => summarizeWatchEvent(scope, root, cacheRoot, event)),
      Stream.filter((summary): summary is WatchEventSummary => summary !== null),
    )

export const watchSnippetChanges = (
  paths: TwoslashProjectPaths,
  options: SnippetWatchOptions,
  build: Effect.Effect<number | undefined, SnippetBuildError>,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const snippetRootExists = yield* fs.exists(paths.snippetAssetsRoot)
    const sourceRootExists = yield* fs.exists(paths.srcRoot)

    const watchStreams: Array<Stream.Stream<WatchEventSummary, PlatformError.PlatformError>> = []
    const readySignals: Deferred.Deferred<void, PlatformError.PlatformError>[] = []
    const addWatch = (scope: WatchScope, root: string) => {
      const ready = Deferred.makeUnsafe<void, PlatformError.PlatformError>()
      readySignals.push(ready)
      watchStreams.push(createWatchStream(fs, scope, root, paths.cacheRoot, ready))
    }
    if (snippetRootExists === true) {
      addWatch('snippet', paths.snippetAssetsRoot)
    }
    if (sourceRootExists === true) {
      addWatch('source', paths.srcRoot)
    }

    const notify = (info: WatchSnippetsRebuildInfo) => options.onRebuild(info)

    const runRebuild = (reason: WatchSnippetsRebuildInfo['reason'], event: WatchEventSummary | null) =>
      Effect.gen(function* () {
        const startedAt = Date.now()
        if (event !== null) {
          yield* Effect.log(
            `Snippets watch: ${event.scope} ${event.kind.toLowerCase()} at ${event.relativePath}, rebuilding...`,
          )
        } else {
          yield* Effect.log('Snippets watch: running initial build')
        }

        const result = yield* build.pipe(Effect.result)
        const durationMs = Date.now() - startedAt

        if (Result.isFailure(result) === true) {
          const error = result.failure
          yield* Effect.logError(
            `Snippets watch: build failed${event !== null ? ` (trigger: ${event.relativePath})` : ''}: ${error.message}`,
          )
          yield* notify({ reason, event, renderedCount: -1, durationMs })
          return
        }

        const renderedCount = result.success ?? 0
        yield* Effect.log(
          `Snippets watch: rendered ${renderedCount} bundle${renderedCount === 1 ? '' : 's'} in ${durationMs}ms`,
        )
        yield* notify({ reason, event, renderedCount, durationMs })
      })

    if (watchStreams.length === 0) {
      yield* runRebuild('initial', null)
      yield* Effect.logWarning('Snippets watch: no watchable directories found; waiting for manual interruption')
      return yield* Effect.never
    }

    const merged =
      watchStreams.length === 1 ? watchStreams[0]! : Stream.mergeAll(watchStreams, { concurrency: watchStreams.length })

    // Readiness must precede the initial notification: callers may edit as soon
    // as they receive it. A single buffered event suffices because every rebuild
    // reads the full current source tree, including changes during a build.
    const changes = yield* Stream.toQueue(
      merged.pipe(Stream.onError((cause) => Effect.forEach(readySignals, (ready) => Deferred.failCause(ready, cause)))),
      { capacity: 1, strategy: 'sliding' },
    )
    yield* Effect.forEach(readySignals, (ready) => Deferred.await(ready))
    yield* runRebuild('initial', null)
    const debounced = Stream.debounce(options.debounce)(Stream.fromQueue(changes))

    const streamEffect = debounced.pipe(
      Stream.mapEffect((event) => runRebuild('watch', event), {
        concurrency: 1,
      }),
      Stream.runDrain,
    )

    yield* streamEffect
    // Scoped watchers close before their original typed failure reaches the caller.
    // An individual build failure is handled above; a dead watch stream is terminal.
  }).pipe(Effect.scoped)
