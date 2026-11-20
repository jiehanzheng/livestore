import { expect, it } from 'vitest'

import { Deferred, Effect, FileSystem, PlatformError, Queue, Result, Stream } from '@livestore/utils/effect'

import { resolveProjectPaths } from '../project-paths.ts'
import { SnippetBuildError } from './snippet-error.ts'
import { watchSnippetChanges, type WatchSnippetsRebuildInfo } from './snippet-watch.ts'

it.each([false, true])(
  'propagates the exact terminal stream error after cleanup; recoverable build failure=%s',
  async (recoverBuild) => {
    const paths = resolveProjectPaths('/injected/watch-owner')
    const underlying = new Error('native watch failed')
    const terminal = PlatformError.systemError({
      module: 'FileSystem',
      method: 'watch',
      _tag: 'Unknown',
      pathOrDescriptor: paths.snippetAssetsRoot,
      cause: underlying,
    })
    let opened = 0,
      closed = 0,
      builds = 0
    const notifications: WatchSnippetsRebuildInfo[] = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const afterInitial = yield* Deferred.make<void>()
        const failStream = yield* Deferred.make<void>()
        const fs = FileSystem.makeNoop({
          exists: () => Effect.succeed(true),
          watch: (root, options) =>
            Stream.callback<FileSystem.WatchEvent, PlatformError.PlatformError>((queue) =>
              Effect.gen(function* () {
                yield* Effect.acquireRelease(
                  Effect.sync(() => {
                    opened++
                    options?.onReady?.()
                  }),
                  () =>
                    Effect.sync(() => {
                      closed++
                    }),
                )
                if (recoverBuild === true && root === paths.snippetAssetsRoot) {
                  yield* Deferred.await(afterInitial)
                  yield* Queue.offer(queue, { _tag: 'Update', path: 'example.ts' })
                }
                yield* Deferred.await(failStream)
                return yield* terminal
              }),
            ),
        })
        const build = Effect.suspend(() => {
          builds++
          return recoverBuild === true && builds === 1
            ? Effect.fail(new SnippetBuildError({ message: 'Recoverable snippet compilation failure' }))
            : Effect.succeed(1)
        })
        return yield* watchSnippetChanges(
          paths,
          {
            debounce: 0,
            onRebuild: (info) =>
              Effect.gen(function* () {
                notifications.push(info)
                if (recoverBuild === true && info.reason === 'initial') yield* Deferred.succeed(afterInitial, undefined)
                else yield* Deferred.succeed(failStream, undefined)
              }),
          },
          build,
        ).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.result)
      }),
    )
    if (Result.isFailure(result) === false) throw new Error('Expected a terminal watcher failure.')
    expect(result.failure).toBe(terminal)
    expect(result.failure.cause).toBe(underlying)
    expect(opened).toBe(2)
    expect(closed).toBe(2)
    expect(builds).toBe(recoverBuild === true ? 2 : 1)
    expect(notifications.map(({ reason, renderedCount }) => [reason, renderedCount])).toEqual(
      recoverBuild === true
        ? [
            ['initial', -1],
            ['watch', 1],
          ]
        : [['initial', 1]],
    )
  },
)
