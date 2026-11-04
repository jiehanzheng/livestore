import { UnknownError } from '@livestore/common'
import { Effect, Stream } from '@livestore/utils/effect'
import { Opfs } from '@livestore/utils/effect/browser'

import { decodeAccessHandlePoolFilenameStrict } from './opfs-sah-pool.ts'

/** Shared read-only pool inventory; discovery must not inherit startup's ordinary repair policy. */
export const readOpfsSourceInventory = (
  directory: FileSystemDirectoryHandle,
): Effect.Effect<{ entries: readonly FileSystemHandle[]; filenames: readonly string[] }, UnknownError, Opfs.Opfs> =>
  Effect.gen(function* () {
    const opfs = yield* Opfs.Opfs
    const entries = yield* opfs.values(directory).pipe(Stream.runCollect)
    const filenames = yield* Stream.fromIterable(entries).pipe(
      Stream.filter((handle): handle is FileSystemFileHandle => handle.kind === 'file'),
      Stream.mapEffect((handle) =>
        opfs.getFile(handle).pipe(
          Effect.flatMap((file) =>
            Effect.tryPromise({
              try: () => decodeAccessHandlePoolFilenameStrict(file),
              catch: (cause) => new UnknownError({ cause }),
            }),
          ),
        ),
      ),
      Stream.runCollect,
    )
    return { entries, filenames }
  }).pipe(Effect.mapError((cause) => new UnknownError({ cause })))
