import { Effect, Fiber } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  makeSourceDb,
  type AsyncSourceDriver,
  type SourceDbError,
  type SourceRow,
  type SourceTransaction,
} from './role.ts'

const signal = <A = void>() => {
  let resolve!: (value: A | PromiseLike<A>) => void
  const promise = new Promise<A>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const controlledDriver = () => {
  const calls: string[] = []
  let execute = async (_sql: string) => {}
  let close = async () => {}
  let selected: ReadonlyArray<SourceRow> = [{ value: 1, blob: new Uint8Array([7]) }]
  let exported = new Uint8Array([9])
  const driver: AsyncSourceDriver = {
    execute: async (sql) => {
      calls.push(sql)
      await execute(sql)
    },
    select: async <Row extends object>() => {
      calls.push('SELECT')
      return selected as ReadonlyArray<Row>
    },
    export: async () => {
      calls.push('EXPORT')
      return exported
    },
    import: async (bytes) => {
      calls.push('IMPORT')
      bytes[0] = 99
    },
    close: async () => {
      calls.push('CLOSE')
      await close()
    },
  }
  return {
    driver,
    calls,
    setExecute: (action: typeof execute) => {
      execute = action
    },
    setClose: (action: typeof close) => {
      close = action
    },
    selected,
    exported,
  }
}

// These controllers exercise native completion ordering; real SQLite transactions are covered by helper tests.
describe('opaque asynchronous SOURCE owner', () => {
  test('holds the full transaction permit until COMMIT completes', async () => {
    const fixture = controlledDriver(),
      committing = signal(),
      commit = signal()
    fixture.setExecute(async (sql) => {
      if (sql === 'COMMIT') {
        committing.resolve()
        await commit.promise
      }
    })
    const source = await Effect.runPromise(makeSourceDb(fixture.driver))
    const transaction = Effect.runPromise(source.transaction((tx) => tx.execute('WRITE')))
    await committing.promise
    const outside = Effect.runPromise(source.select('outside'))
    expect(fixture.calls).toEqual(['BEGIN IMMEDIATE', 'WRITE', 'COMMIT'])
    commit.resolve()
    await transaction
    await outside
    expect(fixture.calls).toEqual(['BEGIN IMMEDIATE', 'WRITE', 'COMMIT', 'SELECT'])
    await Effect.runPromise(source.close)
  })

  test('joins an in-flight operation before cancellation rollback and permit release', async () => {
    const fixture = controlledDriver(),
      entered = signal(),
      nativeDone = signal()
    fixture.setExecute(async (sql) => {
      if (sql === 'WRITE') {
        entered.resolve()
        await nativeDone.promise
      }
    })
    const source = await Effect.runPromise(makeSourceDb(fixture.driver))
    const fiber = Effect.runFork(source.transaction((tx) => tx.execute('WRITE')))
    await entered.promise
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber))
    const outside = Effect.runPromise(source.select('outside'))
    expect(fixture.calls).toEqual(['BEGIN IMMEDIATE', 'WRITE'])
    nativeDone.resolve()
    await interrupted
    await outside
    expect(fixture.calls).toEqual(['BEGIN IMMEDIATE', 'WRITE', 'ROLLBACK', 'SELECT'])
    await Effect.runPromise(source.close)
  })

  test('expires the transaction capability and never calls the driver for late use', async () => {
    const fixture = controlledDriver()
    const source = await Effect.runPromise(makeSourceDb(fixture.driver))
    let retained!: SourceTransaction
    await Effect.runPromise(
      source.transaction((tx) =>
        Effect.sync(() => {
          retained = tx
        }),
      ),
    )
    await expect(Effect.runPromise(retained.execute('LATE'))).rejects.toThrow('SOURCE execute failed')
    expect(fixture.calls).toEqual(['BEGIN IMMEDIATE', 'COMMIT'])
    await Effect.runPromise(source.select('still usable'))
    await Effect.runPromise(source.close)
  })

  test('drains an already-started detached native call before COMMIT', async () => {
    const fixture = controlledDriver(),
      entered = signal(),
      done = signal(),
      bodyReturned = signal()
    fixture.setExecute(async (sql) => {
      if (sql === 'WRITE') {
        entered.resolve()
        await done.promise
      }
    })
    const source = await Effect.runPromise(makeSourceDb(fixture.driver))
    let nativeFiber!: Fiber.Fiber<void, SourceDbError>
    const transaction = Effect.runPromise(
      source.transaction((tx) =>
        Effect.gen(function* () {
          nativeFiber = yield* Effect.forkDetach(tx.execute('WRITE'))
          yield* Effect.promise(() => entered.promise)
          bodyReturned.resolve()
        }),
      ),
    )
    await bodyReturned.promise
    expect(fixture.calls).toEqual(['BEGIN IMMEDIATE', 'WRITE'])
    done.resolve()
    await transaction
    await Effect.runPromise(Fiber.join(nativeFiber))
    expect(fixture.calls).toEqual(['BEGIN IMMEDIATE', 'WRITE', 'COMMIT'])
    await Effect.runPromise(source.close)
  })

  test('successful rollback preserves an ordinary callback failure and permits later work', async () => {
    const fixture = controlledDriver()
    const source = await Effect.runPromise(makeSourceDb(fixture.driver))
    const result = await Effect.runPromise(source.transaction(() => Effect.fail('body failure')).pipe(Effect.flip))
    expect(result).toBe('body failure')
    await Effect.runPromise(source.select('usable'))
    expect(fixture.calls).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK', 'SELECT'])
    await Effect.runPromise(source.close)
  })

  test('native operation failure poisons even when the callback catches it', async () => {
    const fixture = controlledDriver()
    fixture.setExecute(async (sql) => {
      if (sql === 'WRITE') throw new Error('native failed')
    })
    const source = await Effect.runPromise(makeSourceDb(fixture.driver))
    await expect(
      Effect.runPromise(source.transaction((tx) => tx.execute('WRITE').pipe(Effect.ignore))),
    ).rejects.toThrow('SOURCE transaction failed')
    await expect(Effect.runPromise(source.select('refused'))).rejects.toThrow('SOURCE select failed')
    expect(fixture.calls).toEqual(['BEGIN IMMEDIATE', 'WRITE', 'ROLLBACK'])
    await Effect.runPromise(source.close)
  })

  test('unknown COMMIT is poisoned without a speculative rollback or retry', async () => {
    const fixture = controlledDriver()
    fixture.setExecute(async (sql) => {
      if (sql === 'COMMIT') throw new Error('outcome unknown')
    })
    const source = await Effect.runPromise(makeSourceDb(fixture.driver))
    await expect(Effect.runPromise(source.transaction((tx) => tx.execute('WRITE')))).rejects.toThrow(
      'SOURCE commit failed',
    )
    await expect(Effect.runPromise(source.transaction(() => Effect.void))).rejects.toThrow('SOURCE transaction failed')
    expect(fixture.calls).toEqual(['BEGIN IMMEDIATE', 'WRITE', 'COMMIT'])
    await Effect.runPromise(source.close)
  })

  test('rollback failure poisons admission and retains the original failure in the cause', async () => {
    const fixture = controlledDriver()
    fixture.setExecute(async (sql) => {
      if (sql === 'ROLLBACK') throw new Error('rollback failed')
    })
    const source = await Effect.runPromise(makeSourceDb(fixture.driver))
    const failed = await Effect.runPromiseExit(source.transaction(() => Effect.fail('original')))
    expect(JSON.stringify(failed)).toContain('original')
    expect(JSON.stringify(failed)).toContain('rollback')
    await expect(Effect.runPromise(source.export)).rejects.toThrow('SOURCE export failed')
    expect(fixture.calls).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK'])
    await Effect.runPromise(source.close)
  })

  test('copies row blobs, exported bytes and imported bytes across the driver boundary', async () => {
    const fixture = controlledDriver()
    const source = await Effect.runPromise(makeSourceDb(fixture.driver))
    const rows = await Effect.runPromise(source.select<{ value: number; blob: Uint8Array }>('query'))
    rows[0]!.blob[0] = 33
    expect((fixture.selected[0]!.blob as Uint8Array)[0]).toBe(7)
    const bytes = await Effect.runPromise(source.export)
    bytes[0] = 44
    expect(fixture.exported[0]).toBe(9)
    const imported = new Uint8Array([1])
    await Effect.runPromise(source.import(imported))
    expect(imported[0]).toBe(1)
    await Effect.runPromise(source.close)
  })

  test('memoizes a joined close and refuses admission while it is pending', async () => {
    const fixture = controlledDriver(),
      entered = signal(),
      done = signal()
    fixture.setClose(async () => {
      entered.resolve()
      await done.promise
    })
    const source = await Effect.runPromise(makeSourceDb(fixture.driver))
    const first = Effect.runPromise(source.close)
    await entered.promise
    const second = Effect.runPromise(source.close)
    const refused = Effect.runPromise(source.select('after close'))
    expect(fixture.calls).toEqual(['CLOSE'])
    done.resolve()
    await first
    await second
    await expect(refused).rejects.toThrow('SOURCE select failed')
    expect(fixture.calls).toEqual(['CLOSE'])
  })

  test('interrupting a close caller still joins native close before the caller settles', async () => {
    const fixture = controlledDriver(),
      entered = signal(),
      done = signal()
    fixture.setClose(async () => {
      entered.resolve()
      await done.promise
    })
    const source = await Effect.runPromise(makeSourceDb(fixture.driver))
    const fiber = Effect.runFork(source.close)
    await entered.promise
    let joined = false
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      joined = true
    })
    expect(joined).toBe(false)
    expect(fixture.calls).toEqual(['CLOSE'])
    done.resolve()
    await interrupted
    await Effect.runPromise(source.close)
    expect(fixture.calls).toEqual(['CLOSE'])
  })

  test('memoizes close failure without retrying a native owner of uncertain disposition', async () => {
    const fixture = controlledDriver()
    fixture.setClose(async () => {
      throw new Error('native close failed')
    })
    const source = await Effect.runPromise(makeSourceDb(fixture.driver))
    await expect(Effect.runPromise(source.close)).rejects.toThrow('SOURCE close failed')
    await expect(Effect.runPromise(source.close)).rejects.toThrow('SOURCE close failed')
    await expect(Effect.runPromise(source.select('refused'))).rejects.toThrow('SOURCE select failed')
    expect(fixture.calls).toEqual(['CLOSE'])
  })
  test.each(['select', 'close', 'transaction'] as const)(
    'refuses same-fiber %s through the outer owner inside a write',
    async (operation) => {
      const fixture = controlledDriver()
      const source = await Effect.runPromise(makeSourceDb(fixture.driver))
      const attempted =
        operation === 'select'
          ? source.select('SELECT nested')
          : operation === 'close'
            ? source.close
            : source.transaction(() => Effect.void)
      await expect(Effect.runPromise(source.transaction(() => attempted.pipe(Effect.ignore)))).rejects.toThrow(
        'SOURCE transaction failed',
      )
      expect(fixture.calls).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK'])
      await Effect.runPromise(source.close)
      expect(fixture.calls).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK', 'CLOSE'])
    },
  )
  test.each(['select', 'close', 'transaction'] as const)(
    'refuses child %s through the outer owner before parent-child join can deadlock',
    async (operation) => {
      const fixture = controlledDriver(),
        source = await Effect.runPromise(makeSourceDb(fixture.driver))
      const attempted =
        operation === 'select'
          ? source.select('CHILD')
          : operation === 'close'
            ? source.close
            : source.transaction(() => Effect.void)
      await expect(
        Effect.runPromise(
          source.transaction(() =>
            Effect.gen(function* () {
              const child = yield* Effect.forkDetach(attempted.pipe(Effect.ignore))
              yield* Fiber.join(child)
            }),
          ),
        ),
      ).rejects.toThrow('SOURCE transaction failed')
      expect(fixture.calls).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK'])
      await Effect.runPromise(source.close)
    },
  )

  test('unrelated siblings queue and a detached descendant may enter after its callback expires', async () => {
    const fixture = controlledDriver(),
      source = await Effect.runPromise(makeSourceDb(fixture.driver))
    const callbackEntered = signal(),
      callbackDone = signal(),
      childReady = signal(),
      releaseChild = signal()
    let child!: Fiber.Fiber<ReadonlyArray<SourceRow>, SourceDbError>
    const transaction = Effect.runPromise(
      source.transaction(() =>
        Effect.gen(function* () {
          child = yield* Effect.forkDetach(
            Effect.gen(function* () {
              childReady.resolve()
              yield* Effect.promise(() => releaseChild.promise)
              return yield* source.select('LATE CHILD')
            }),
          )
          yield* Effect.promise(() => childReady.promise)
          callbackEntered.resolve()
          yield* Effect.promise(() => callbackDone.promise)
        }),
      ),
    )
    await callbackEntered.promise
    const sibling = Effect.runPromise(source.select('UNRELATED'))
    expect(fixture.calls).toEqual(['BEGIN IMMEDIATE'])
    callbackDone.resolve()
    await transaction
    await sibling
    releaseChild.resolve()
    await Effect.runPromise(Fiber.join(child))
    expect(fixture.calls).toEqual(['BEGIN IMMEDIATE', 'COMMIT', 'SELECT', 'SELECT'])
    await Effect.runPromise(source.close)
  })
})
