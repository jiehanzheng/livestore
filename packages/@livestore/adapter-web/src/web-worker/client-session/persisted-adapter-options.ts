import type * as WorkerSchema from '../common/worker-schema.ts'

export type WebAdapterOptions = {
  /**
   * A factory may return a dedicated Worker or an application-owned MessagePort.
   * For a MessagePort, configure the worker runner with the paired transport port;
   * the application owns and terminates the underlying Worker after joining cleanup.
   */
  worker:
    | ((options: { name: string }) => globalThis.Worker | MessagePort)
    | (new (options: { name: string }) => globalThis.Worker)
  /**
   * This is mostly an implementation detail and needed to be exposed into app code
   * due to a current Vite limitation (https://github.com/vitejs/vite/issues/8427).
   *
   * In most cases this should look like:
   * ```ts
   * import LiveStoreSharedWorker from '@livestore/adapter-web/shared-worker?sharedworker'
   *
   * const adapter = makePersistedAdapter({
   *   sharedWorker: LiveStoreSharedWorker,
   *   // ...
   * })
   * ```
   */
  sharedWorker:
    | ((options: { name: string }) => globalThis.SharedWorker)
    | (new (options: { name: string }) => globalThis.SharedWorker)
  /**
   * Specifies where to persist data for this adapter
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
   * store it in `localStorage` and restore it for subsequent client sessions. It's the same across all tabs/windows.
   */
  clientId?: string
  /**
   * By default the adapter will initially generate a random sessionId (via `nanoid(5)`),
   * store it in `sessionStorage` and restore it for subsequent client sessions in the same tab/window.
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
    /**
     * Controls whether to wait for the shared worker to be terminated when LiveStore gets shut down.
     * This prevents a race condition where a new LiveStore instance connects to a shutting-down shared
     * worker from a previous instance.
     *
     * @default false
     *
     * @remarks
     *
     * In multi-tab scenarios, we don't want to await shared worker termination because the shared worker
     * won't actually shut down when one tab closes - it stays alive to serve other tabs. Awaiting
     * termination would cause unnecessary blocking since the termination will never happen until all
     * tabs are closed.
     */
    awaitSharedWorkerTermination?: boolean
  }
}
