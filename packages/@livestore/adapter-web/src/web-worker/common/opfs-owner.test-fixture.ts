import { Effect } from '@livestore/utils/effect'
import { Opfs } from '@livestore/utils/effect/browser'

type Gate = { entered: Promise<void>; release: () => void }
type OwnedOpfsFixture = {
  events: string[]
  rootDirectory: FileSystemDirectoryHandle
  service: Effect.Success<typeof Opfs.Opfs>
  activeHandles: () => number
  pauseNextAcquisition: () => Gate
  seedEmptyFile: (directory: string, name: string) => Promise<void>
  failAcquisition: () => void
  failPhysicalClose: () => void
}
export const makeOwnedOpfsFixture = (): OwnedOpfsFixture => {
  const events: string[] = []
  const handles = new Set<{ closed: boolean }>()
  let pause: { enter: () => void; wait: Promise<void> } | undefined
  let failAcquire = false
  let failClose = false
  const invalid = () => new DOMException('Synthetic access handle is closed', 'InvalidStateError')
  class FileHandle {
    readonly kind = 'file'
    bytes = new Uint8Array(0)
    active = false
    constructor(readonly name: string) {}
    async getFile() {
      return new File([new Uint8Array(this.bytes)], this.name)
    }
    async createSyncAccessHandle() {
      const gate = pause
      pause = undefined
      if (gate !== undefined) {
        gate.enter()
        await gate.wait
      }
      if (failAcquire === true) throw new DOMException('Synthetic acquisition failure', 'NoModificationAllowedError')
      if (this.active === true)
        throw new DOMException('Synthetic exclusive handle is already active', 'NoModificationAllowedError')
      this.active = true
      const state = { closed: false }
      handles.add(state)
      events.push(`handle-open:${this.name}`)
      const requireOpen = () => {
        if (state.closed === true) throw invalid()
      }
      const resize = (size: number) => {
        const next = new Uint8Array(size)
        next.set(this.bytes.subarray(0, size))
        this.bytes = next
      }
      return {
        read: (buffer: ArrayBufferView, options: { at?: number } = {}) => {
          requireOpen()
          const target = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
          const offset = options.at ?? 0
          const count = Math.max(0, Math.min(target.byteLength, this.bytes.byteLength - offset))
          target.set(this.bytes.subarray(offset, offset + count))
          return count
        },
        write: (buffer: ArrayBufferView, options: { at?: number } = {}) => {
          requireOpen()
          const source = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
          const offset = options.at ?? 0
          if (offset + source.byteLength > this.bytes.byteLength) resize(offset + source.byteLength)
          this.bytes.set(source, offset)
          return source.byteLength
        },
        getSize: () => {
          requireOpen()
          return this.bytes.byteLength
        },
        truncate: (size: number) => {
          requireOpen()
          resize(size)
        },
        flush: () => {
          requireOpen()
          const header = new TextDecoder().decode(this.bytes.subarray(0, 512)).split('\0')[0]
          events.push(`handle-flush:${this.name}:${header}`)
        },
        close: () => {
          requireOpen()
          events.push(`handle-close:${this.name}`)
          if (failClose === true) throw new DOMException('Synthetic close failure', 'InvalidStateError')
          state.closed = true
          this.active = false
        },
      }
    }
  }
  class DirectoryHandle {
    readonly kind = 'directory'
    readonly directories = new Map<string, DirectoryHandle>()
    readonly files = new Map<string, FileHandle>()
    constructor(readonly name: string) {}
    async getDirectoryHandle(name: string, options: { create?: boolean } = {}) {
      let directory = this.directories.get(name)
      if (directory === undefined && options.create === true) {
        directory = new DirectoryHandle(name)
        this.directories.set(name, directory)
      }
      if (directory === undefined) throw new DOMException('Synthetic directory not found', 'NotFoundError')
      return directory
    }
    async getFileHandle(name: string, options: { create?: boolean } = {}) {
      let file = this.files.get(name)
      if (file === undefined && options.create === true) {
        file = new FileHandle(name)
        this.files.set(name, file)
      }
      if (file === undefined) throw new DOMException('Synthetic file not found', 'NotFoundError')
      return file
    }
    async *values() {
      yield* this.directories.values()
      yield* this.files.values()
    }
    async removeEntry(name: string, options: { recursive?: boolean } = {}) {
      const file = this.files.get(name)
      if (file?.active === true)
        throw new DOMException('Synthetic file has an active handle', 'NoModificationAllowedError')
      if (file !== undefined) {
        this.files.delete(name)
        return
      }
      if (this.directories.has(name) === true && options.recursive === true) {
        this.directories.delete(name)
        return
      }
      throw new DOMException('Synthetic entry not found', 'NotFoundError')
    }
  }
  const root = new DirectoryHandle('root')
  const native = Effect.runSync(Opfs.Opfs.pipe(Effect.provide(Opfs.layer)))
  // Native-shaped byte storage is synthetic; classification/acquisition/finalizers use the real public Opfs service.
  const service = { ...native, getRootDirectoryHandle: Effect.succeed(root as unknown as FileSystemDirectoryHandle) }
  return {
    events,
    rootDirectory: root as unknown as FileSystemDirectoryHandle,
    service,
    activeHandles: () => [...handles].filter((handle) => handle.closed === false).length,
    pauseNextAcquisition: (): Gate => {
      let enter!: () => void, release!: () => void
      const entered = new Promise<void>((resolve) => {
        enter = resolve
      })
      const wait = new Promise<void>((resolve) => {
        release = resolve
      })
      pause = { enter, wait }
      return { entered, release }
    },
    seedEmptyFile: async (directory: string, name: string) => {
      const parent = await root.getDirectoryHandle(directory, { create: true })
      await parent.getFileHandle(name, { create: true })
    },
    failAcquisition: () => {
      failAcquire = true
    },
    failPhysicalClose: () => {
      failClose = true
    },
  }
}
