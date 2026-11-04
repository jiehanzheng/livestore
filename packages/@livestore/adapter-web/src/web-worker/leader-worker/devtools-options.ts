import type { SqliteDb, UnknownError } from '@livestore/common'
import type { DevtoolsOptions } from '@livestore/common/leader-thread'
import { Effect, type Scope } from '@livestore/utils/effect'
import * as WebmeshWorker from '@livestore/webmesh/worker'

export const makeDevtoolsOptions = ({
  devtoolsEnabled,
  dbState,
  dbEventlog,
}: {
  devtoolsEnabled: boolean
  dbState: SqliteDb
  dbEventlog: SqliteDb
}): Effect.Effect<DevtoolsOptions, UnknownError, Scope.Scope | WebmeshWorker.CacheService> =>
  Effect.gen(function* () {
    if (devtoolsEnabled === false) {
      return { enabled: false }
    }

    const { node } = yield* WebmeshWorker.CacheService

    return {
      enabled: true,
      boot: Effect.succeed({
        node,
        persistenceInfo: {
          state: dbState.metadata.persistenceInfo,
          eventlog: dbEventlog.metadata.persistenceInfo,
        },
        mode: 'direct' as const,
      }),
    }
  })
