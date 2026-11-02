/// <reference lib="webworker" />

import { Cause, Context, Effect, Exit, Fiber, Logger, Schema, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import * as WebError from '../WebError.ts'
import * as Opfs from './Opfs.ts'

const opfs = Effect.runSync(Opfs.Opfs.pipe(Effect.provide(Opfs.layer)))
const file = (methods: Partial<FileSystemFileHandle>) => methods as FileSystemFileHandle
const directory = (methods: Partial<FileSystemDirectoryHandle>) => methods as FileSystemDirectoryHandle
const syncHandle = (methods: Partial<FileSystemSyncAccessHandle>) => methods as FileSystemSyncAccessHandle
const writable = (methods: Partial<FileSystemWritableFileStream>) => methods as FileSystemWritableFileStream

const failureOf = async <A, E>(effect: Effect.Effect<A, E>) => {
  const exit = await Effect.runPromiseExit(effect)
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isSuccess(exit) === true) throw new Error('Expected failure')
  return exit.cause
}

const nativeFailure = () =>
  new WebError.InvalidStateError({ cause: new DOMException('synthetic', 'InvalidStateError') })

describe('OPFS native failure identity diagnostics', () => {
  it('retains failure identity and method across the VFS Promise/squash boundary and logger', async () => {
    const failure = nativeFailure()
    const original = failure.cause
    const input = file({
      createSyncAccessHandle: async () => {
        throw failure
      },
    })
    const services = Context.empty()
    const bridge = Effect.promise(() =>
      Effect.runPromiseWith(services)(opfs.createSyncAccessHandle(input).pipe(Effect.scoped)),
    )
    const observations: unknown[] = []
    const logger = Logger.make((options) => observations.push(Cause.squash(options.cause)))
    const cause = await failureOf(
      bridge.pipe(
        Effect.tapCause((cause) => Effect.logError(cause)),
        Effect.provide(Logger.layer([logger])),
      ),
    )
    expect(cause.reasons.map((reason) => reason._tag)).toEqual(['Die'])
    expect(Cause.squash(cause)).toBe(failure)
    expect(observations).toEqual([failure])
    expect(failure.cause).toBe(original)
    expect(Opfs.getNativeFailureOperation(failure)).toBe('FileSystemFileHandle.createSyncAccessHandle')
    expect(Opfs.getNativeFailureOperation(original)).toBeUndefined()
    expect(Object.keys(failure)).not.toContain('operation')
  })

  it('keeps typed failures and the existing serialized error wire unchanged', async () => {
    const failure = nativeFailure()
    const schema = Schema.Defect()
    const before = Schema.encodeSync(schema)(failure)
    const cause = await failureOf(
      opfs
        .createSyncAccessHandle(
          file({
            createSyncAccessHandle: async () => {
              throw failure
            },
          }),
        )
        .pipe(Effect.scoped),
    )
    expect(cause.reasons.map((reason) => reason._tag)).toEqual(['Fail'])
    expect(Cause.squash(cause)).toBe(failure)
    expect(Schema.encodeSync(schema)(failure)).toEqual(before)
    expect(Opfs.getNativeFailureOperation(Schema.decodeSync(schema)(before))).toBeUndefined()
  })

  it('does not log handled errors or invent an operation for untracked values', async () => {
    const error = new WebError.NotFoundError({ cause: new DOMException('absent', 'NotFoundError') })
    const logs: unknown[] = []
    const value = await Effect.runPromise(
      opfs
        .getFile(
          file({
            getFile: async () => {
              throw error
            },
          }),
        )
        .pipe(
          Effect.orElseSucceed(() => 'fallback'),
          Effect.provide(Logger.layer([Logger.make((options) => logs.push(options.cause))])),
        ),
    )
    expect(value).toBe('fallback')
    expect(logs).toEqual([])
    expect(Opfs.getNativeFailureOperation(error)).toBe('FileSystemFileHandle.getFile')
    for (const input of [undefined, null, 11, 'error', {}, new Error('untracked')]) {
      expect(Opfs.getNativeFailureOperation(input)).toBeUndefined()
    }
  })

  it('makes conflicting reuse permanently ambiguous, including a return to the first method', async () => {
    const error = nativeFailure()
    await failureOf(
      opfs.syncRead(
        syncHandle({
          read: () => {
            throw error
          },
        }),
        new Uint8Array(1),
      ),
    )
    expect(Opfs.getNativeFailureOperation(error)).toBe('FileSystemSyncAccessHandle.read')
    await failureOf(
      opfs.syncRead(
        syncHandle({
          read: () => {
            throw error
          },
        }),
        new Uint8Array(1),
      ),
    )
    expect(Opfs.getNativeFailureOperation(error)).toBe('FileSystemSyncAccessHandle.read')
    await failureOf(
      opfs.syncWrite(
        syncHandle({
          write: () => {
            throw error
          },
        }),
        new Uint8Array(1),
      ),
    )
    expect(Opfs.getNativeFailureOperation(error)).toBe('unknown')
    await failureOf(
      opfs.syncRead(
        syncHandle({
          read: () => {
            throw error
          },
        }),
        new Uint8Array(1),
      ),
    )
    expect(Opfs.getNativeFailureOperation(error)).toBe('unknown')
  })

  it('records the child native call rather than the composite append operation', async () => {
    const calls: string[] = []
    const error = nativeFailure()
    const stream = writable({
      close: async () => {
        calls.push('close')
      },
    })
    const input = file({
      createWritable: async () => {
        calls.push('create')
        return stream
      },
      getFile: async () => {
        calls.push('getFile')
        throw error
      },
    })
    const cause = await failureOf(opfs.appendToFile(input, 'synthetic'))
    expect(Opfs.getNativeFailureOperation(Cause.squash(cause))).toBe('FileSystemFileHandle.getFile')
    expect(calls).toEqual(['create', 'getFile', 'close'])
  })

  it('records a rejected iterator step without changing eager iterator creation', async () => {
    const failure = nativeFailure()
    const input = directory({
      values: () => ({
        [Symbol.asyncIterator]() {
          return this
        },
        [Symbol.asyncDispose]: async () => {},
        next: async () => {
          throw failure
        },
      }),
    })
    const cause = await failureOf(Stream.runCollect(opfs.values(input)))
    const wrapped = Cause.squash(cause)
    expect(wrapped).toBeInstanceOf(WebError.UnknownError)
    if (!(wrapped instanceof WebError.UnknownError)) throw new Error('Expected the existing iterator error wrapper')
    expect(wrapped.cause).toBe(failure)
    expect(Opfs.getNativeFailureOperation(wrapped)).toBe('FileSystemDirectoryHandle.values.next')
  })

  it('records an eager values throw synchronously without replacing or deferring it', () => {
    const eager = new DOMException('eager creation failure', 'InvalidStateError')
    let calls = 0
    let caught: unknown
    let returned: unknown
    try {
      returned = opfs.values(
        directory({
          values: () => {
            calls++
            throw eager
          },
        }),
      )
    } catch (failure) {
      caught = failure
    }
    expect(caught).toBe(eager)
    expect(returned).toBeUndefined()
    expect(calls).toBe(1)
    expect(Opfs.getNativeFailureOperation(eager)).toBe('FileSystemDirectoryHandle.values')
  })

  it('preserves successful values, native call counts and reverse finalizer order', async () => {
    const calls: string[] = []
    const open = (name: string) =>
      opfs.createSyncAccessHandle(
        file({
          createSyncAccessHandle: async () => {
            calls.push(`open:${name}`)
            return syncHandle({
              close: () => {
                calls.push(`close:${name}`)
              },
            })
          },
        }),
      )
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* open('first')
          yield* open('second')
          return yield* opfs.syncRead(
            syncHandle({
              read: () => {
                calls.push('read')
                return 7
              },
            }),
            new Uint8Array(8),
          )
        }),
      ),
    )
    expect(result).toBe(7)
    expect(calls).toEqual(['open:first', 'open:second', 'read', 'close:second', 'close:first'])
  })

  it('preserves a close defect and remaining resource finalizers', async () => {
    const closeError = new DOMException('synthetic close', 'InvalidStateError')
    const calls: string[] = []
    const cause = await failureOf(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              calls.push('outer')
            }),
          )
          yield* opfs.createSyncAccessHandle(
            file({
              createSyncAccessHandle: async () =>
                syncHandle({
                  close: () => {
                    calls.push('close')
                    throw closeError
                  },
                }),
            }),
          )
        }),
      ),
    )
    expect(cause.reasons.map((reason) => reason._tag)).toEqual(['Die'])
    expect(Cause.squash(cause)).toBe(closeError)
    expect(Opfs.getNativeFailureOperation(closeError)).toBe('FileSystemSyncAccessHandle.close')
    expect(calls).toEqual(['close', 'outer'])
  })

  it('retains separate body/cleanup reasons without choosing a global operation', async () => {
    const body = nativeFailure()
    const close = new Error('close')
    const cause = await failureOf(
      Effect.scoped(
        Effect.gen(function* () {
          yield* opfs.createSyncAccessHandle(
            file({
              createSyncAccessHandle: async () =>
                syncHandle({
                  close: () => {
                    throw close
                  },
                }),
            }),
          )
          yield* opfs.syncRead(
            syncHandle({
              read: () => {
                throw body
              },
            }),
            new Uint8Array(1),
          )
        }),
      ),
    )
    const baseline = await failureOf(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(Effect.void, () =>
            Effect.sync(() => {
              throw close
            }),
          )
          return yield* body
        }),
      ),
    )
    expect(cause.reasons.map((reason) => reason._tag)).toEqual(baseline.reasons.map((reason) => reason._tag))
    expect(
      cause.reasons.map((reason) =>
        reason._tag === 'Fail' ? reason.error : reason._tag === 'Die' ? reason.defect : undefined,
      ),
    ).toEqual([body, close])
    expect(Opfs.getNativeFailureOperation(body)).toBe('FileSystemSyncAccessHandle.read')
    expect(Opfs.getNativeFailureOperation(close)).toBe('FileSystemSyncAccessHandle.close')
  })

  it('joins cancelled acquisition and closes a late acquired handle exactly once', async () => {
    let release!: (handle: FileSystemSyncAccessHandle) => void
    const acquired = new Promise<FileSystemSyncAccessHandle>((resolve) => {
      release = resolve
    })
    let start!: () => void
    const started = new Promise<void>((resolve) => {
      start = resolve
    })
    const calls: string[] = []
    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          yield* opfs.createSyncAccessHandle(
            file({
              createSyncAccessHandle: () => {
                start()
                return acquired
              },
            }),
          )
          calls.push('body')
        }),
      ),
    )
    await started
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber))
    release(
      syncHandle({
        close: () => {
          calls.push('close')
        },
      }),
    )
    await interrupted
    expect(calls).toEqual(['close'])
    const exit = await Effect.runPromise(Fiber.await(fiber))
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  })
})
