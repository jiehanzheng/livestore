/** Resource evidence supplements the joined SDK scope; it never owns that scope. */
export const createResourceLedger = function () {
  const active = new Set<object>()
  const failures: unknown[] = []
  return {
    acquire(resource: object) {
      active.add(resource)
    },
    release(resource: object) {
      active.delete(resource)
    },
    failed(cause: unknown) {
      failures.push(cause)
    },
    assertClosed() {
      const causes = [...failures]
      if (active.size > 0) causes.push(new Error(`${active.size} native database handle(s) have not closed.`))
      if (causes.length > 0) throw new AggregateError(causes, 'Native storage closure is unconfirmed.')
    },
  }
}
export type ResourceLedger = ReturnType<typeof createResourceLedger>

/** Preserve the operation error when cleanup also fails, including thrown undefined. */
export const withCleanup = function <T>(run: () => T, close: () => void): T {
  let failed = false
  let original: unknown
  let result!: T
  try {
    result = run()
  } catch (cause) {
    failed = true
    original = cause
  }
  try {
    close()
  } catch (cause) {
    if (failed === true) throw new AggregateError([original, cause], 'Native operation and cleanup failed.', { cause })
    throw cause
  }
  if (failed === true) throw original
  return result
}
