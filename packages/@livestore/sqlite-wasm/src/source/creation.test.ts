import { describe, expect, test } from 'vitest'

import { inspectSourceExistence, startSourceAuthority, type SourceAuthority } from './creation.ts'

const deferred = <A = void>() => Promise.withResolvers<A>()
const outcome = <A>(promise: Promise<A>) =>
  promise.then(
    (value) => ({ success: true as const, value }),
    (error) => ({ success: false as const, error }),
  )
const owned = () => {
  let held = true
  const authority: SourceAuthority = {
    storageName: 'source-test',
    isHeld: () => held,
    release: async () => {
      held = false
    },
  }
  return {
    authority,
    lose: () => {
      held = false
    },
  }
}
const probe = () => {
  const calls: string[] = []
  let abortError: Error | undefined
  const raw = {
    error: null as DOMException | null,
    result: {
      close: () => {
        calls.push('close')
      },
    },
    transaction: {
      abort: () => {
        calls.push('abort')
        if (abortError !== undefined) throw abortError
      },
    },
    onblocked: null,
    onupgradeneeded: null,
    onerror: null,
    onsuccess: null,
  }
  const request = raw as unknown as IDBOpenDBRequest
  const factory = {
    open: (name: string) => {
      calls.push(`open:${name}`)
      return request
    },
  } as unknown as IDBFactory
  return {
    factory,
    calls,
    setAbortError: (error: Error) => {
      abortError = error
    },
    upgrade: (oldVersion: number) => request.onupgradeneeded?.({ oldVersion } as IDBVersionChangeEvent),
    blocked: () => request.onblocked?.({} as IDBVersionChangeEvent),
    error: (name = 'AbortError') => {
      raw.error = new DOMException('controlled native request', name)
      request.onerror?.({} as Event)
    },
    success: () => request.onsuccess?.({} as Event),
  }
}

describe('exact-name SOURCE existence probe under owned authority', () => {
  test('absence requires upgrade-zero, returned abort, and joined native AbortError', async () => {
    const native = probe(),
      owner = owned()
    let settled = false
    const result = outcome(inspectSourceExistence(native.factory, owner.authority, 'absent')).then((value) => {
      settled = true
      return value
    })
    native.upgrade(0)
    await Promise.resolve()
    expect(native.calls).toEqual(['open:source-test', 'abort'])
    expect(settled).toBe(false)
    native.error()
    expect(await result).toMatchObject({ success: true })
  })

  test.each(['empty', 'populated'])('an existing %s database never grants freshness', async () => {
    const native = probe()
    const result = outcome(inspectSourceExistence(native.factory, owned().authority, 'absent'))
    native.success()
    expect(await result).toMatchObject({ success: false })
    expect(native.calls).toEqual(['open:source-test', 'close'])
  })

  test('retained mode accepts an existing database and closes only the probe connection', async () => {
    const native = probe()
    const result = inspectSourceExistence(native.factory, owned().authority, 'retained')
    native.success()
    await result
    expect(native.calls).toEqual(['open:source-test', 'close'])
  })

  test('retained mode aborts absent storage and refuses initialization', async () => {
    const native = probe()
    const result = outcome(inspectSourceExistence(native.factory, owned().authority, 'retained'))
    native.upgrade(0)
    native.error()
    expect(await result).toMatchObject({ success: false })
    expect(native.calls).toEqual(['open:source-test', 'abort'])
  })

  test('blocked requests remain owned until terminal and cannot be revived by later events', async () => {
    const native = probe()
    let settled = false
    const result = outcome(inspectSourceExistence(native.factory, owned().authority, 'absent')).then((value) => {
      settled = true
      return value
    })
    native.blocked()
    await Promise.resolve()
    expect(settled).toBe(false)
    native.upgrade(0)
    native.error()
    expect(await result).toMatchObject({ success: false, error: { message: expect.stringContaining('blocked') } })
    native.success()
    expect(await result).toMatchObject({ success: false })
    expect(native.calls.at(-1)).toBe('close')
  })

  test('blocked retained requests cannot become accepted on a later success', async () => {
    const native = probe()
    const result = outcome(inspectSourceExistence(native.factory, owned().authority, 'retained'))
    native.blocked()
    native.success()
    expect(await result).toMatchObject({ success: false })
    expect(native.calls.at(-1)).toBe('close')
  })

  test('abort failure, nonzero upgrade, and unrelated native errors do not prove absence', async () => {
    for (const mode of ['abort-throws', 'old-version', 'wrong-error', 'no-upgrade']) {
      const native = probe()
      const result = outcome(inspectSourceExistence(native.factory, owned().authority, 'absent'))
      if (mode === 'abort-throws') native.setAbortError(new Error('native abort failed'))
      if (mode !== 'no-upgrade') native.upgrade(mode === 'old-version' ? 5 : 0)
      native.error(mode === 'wrong-error' ? 'UnknownError' : 'AbortError')
      expect(await result, mode).toMatchObject({ success: false })
    }
  })

  test('authority loss before either native terminal result refuses admission', async () => {
    for (const expected of ['absent', 'retained'] as const) {
      const native = probe(),
        owner = owned()
      const result = outcome(inspectSourceExistence(native.factory, owner.authority, expected))
      if (expected === 'absent') native.upgrade(0)
      owner.lose()
      if (expected === 'absent') native.error()
      else native.success()
      expect(await result).toMatchObject({ success: false })
    }
  })

  test('an unheld authority never opens IndexedDB', async () => {
    const native = probe(),
      owner = owned()
    owner.lose()
    expect(await outcome(inspectSourceExistence(native.factory, owner.authority, 'absent'))).toMatchObject({
      success: false,
    })
    expect(native.calls).toEqual([])
  })
})

const lockRequest = () => {
  const finished = deferred<void>()
  let callback!: (lock: Lock | null) => Promise<unknown>
  let options!: LockOptions
  let name = ''
  const locks = {
    request: (input: string, opts: LockOptions, body: typeof callback) => {
      name = input
      options = opts
      callback = body
      return finished.promise
    },
  } as unknown as LockManager
  return {
    locks,
    finished,
    get options() {
      return options
    },
    get name() {
      return name
    },
    grant: () => callback({ name, mode: 'exclusive' } as Lock),
  }
}

describe('physical SOURCE authority native request lifetime', () => {
  test('queued cancellation aborts and joins native rejection before it completes', async () => {
    const native = lockRequest(),
      attempt = startSourceAuthority(native.locks, 'source-test')
    const acquired = outcome(attempt.acquired)
    let joined = false
    const cancellation = attempt.cancelAndJoin().then(() => {
      joined = true
    })
    expect(native.options.signal?.aborted).toBe(true)
    expect(native.name).toBe('livestore-source-authority:source-test')
    await Promise.resolve()
    expect(joined).toBe(false)
    native.finished.reject(new DOMException('queued request cancelled', 'AbortError'))
    await cancellation
    expect(await acquired).toMatchObject({ success: false })
  })

  test('a late native callback after cancellation cannot grant an owner', async () => {
    const native = lockRequest(),
      attempt = startSourceAuthority(native.locks, 'source-test')
    const acquired = outcome(attempt.acquired),
      cancellation = attempt.cancelAndJoin()
    const late = await outcome(native.grant())
    expect(late).toMatchObject({ success: false, error: { name: 'AbortError' } })
    native.finished.reject(new DOMException('cancelled', 'AbortError'))
    await cancellation
    expect(await acquired).toMatchObject({ success: false })
  })

  test('granted release is memoized and joins callback and native request completion', async () => {
    const native = lockRequest(),
      attempt = startSourceAuthority(native.locks, 'source-test')
    const callback = native.grant(),
      owner = await attempt.acquired
    expect(owner.isHeld()).toBe(true)
    const released = owner.release()
    expect(owner.release()).toBe(released)
    let joined = false
    const completion = released.then(() => {
      joined = true
    })
    await callback
    expect(owner.isHeld()).toBe(false)
    expect(joined).toBe(false)
    native.finished.resolve()
    await completion
  })

  test('cancelling a granted owner also joins physical lease completion', async () => {
    const native = lockRequest(),
      attempt = startSourceAuthority(native.locks, 'source-test')
    const callback = native.grant(),
      owner = await attempt.acquired
    const cancelled = attempt.cancelAndJoin()
    await callback
    expect(owner.isHeld()).toBe(false)
    native.finished.resolve()
    await cancelled
  })

  test('native request failure revokes a granted authority and cannot become a successful release', async () => {
    const native = lockRequest(),
      attempt = startSourceAuthority(native.locks, 'source-test')
    const callback = native.grant(),
      owner = await attempt.acquired
    native.finished.reject(new Error('authority lost'))
    await Promise.resolve()
    expect(owner.isHeld()).toBe(false)
    const released = outcome(owner.release())
    await callback
    expect(await released).toMatchObject({ success: false, error: { message: 'authority lost' } })
  })

  test('unexpected native failure is propagated rather than normalized as cancellation', async () => {
    const native = lockRequest(),
      attempt = startSourceAuthority(native.locks, 'source-test')
    const acquired = outcome(attempt.acquired),
      cancelled = outcome(attempt.cancelAndJoin())
    native.finished.reject(new Error('native request failed'))
    expect(await acquired).toMatchObject({ success: false, error: { message: 'native request failed' } })
    expect(await cancelled).toMatchObject({ success: false, error: { message: 'native request failed' } })
  })
})
