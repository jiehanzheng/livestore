import type * as WorkerSchema from '../web-worker/common/worker-schema.ts'

/**
 * Options for the single-tab adapter.
 *
 * This adapter is designed for browsers without SharedWorker support (e.g. Android Chrome).
 * It provides OPFS persistence but without multi-tab synchronization.
 *
 * @see https://github.com/livestorejs/livestore/issues/321
 * @see https://issues.chromium.org/issues/40290702
 */
export type SingleTabAdapterOptions = {
  /**
   * The dedicated web worker that runs the LiveStore leader thread.
   *
   * @example
   * ```ts
   * import LiveStoreWorker from './livestore.worker.ts?worker'
   *
   * const adapter = makeSingleTabAdapter({
   *   worker: LiveStoreWorker,
   *   storage: { type: 'opfs' },
   * })
   * ```
   *
   * A factory may return a dedicated Worker or an application-owned MessagePort.
   * For a MessagePort, configure the worker runner with the paired transport port;
   * the application owns and terminates the underlying Worker after joining cleanup.
   */
  worker:
    | ((options: { name: string }) => globalThis.Worker | MessagePort)
    | (new (options: { name: string }) => globalThis.Worker)

  /**
   * Storage configuration. Currently only OPFS is supported.
   */
  storage: WorkerSchema.StorageTypeEncoded

  /**
   * Warning: This will reset both the app and eventlog database.
   * This should only be used during development.
   *
   * @default false
   */
  resetPersistence?: boolean

  /**
   * By default the adapter will initially generate a random clientId (via `nanoid(5)`),
   * store it in `localStorage` and restore it for subsequent client sessions.
   */
  clientId?: string

  /**
   * By default the adapter will initially generate a random sessionId (via `nanoid(5)`),
   * store it in `sessionStorage` and restore it for subsequent client sessions in the same tab.
   */
  sessionId?: string

  experimental?: {
    /**
     * When set to `true`, the adapter will always start with a snapshot from the leader
     * instead of trying to load a snapshot from storage.
     *
     * @default false
     */
    disableFastPath?: boolean
  }
}
