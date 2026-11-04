/// <reference types="node" />

import * as fs from 'node:fs'
import path from 'node:path'

import * as VFS from '@livestore/wa-sqlite/src/VFS.js'

import { FacadeVFS } from '../FacadeVFS.ts'
import type { NodeSourceCreation } from './source-creation.ts'

interface NodeFsFile {
  pathname: string
  flags: number
  fileHandle: number | null
  creation?: NodeSourceCreation
}

export class NodeFS extends FacadeVFS {
  // The upstream Base runtime provides these methods, but its declaration omits them.
  declare close: () => void
  declare isReady: () => boolean
  private mapIdToFile = new Map<number, NodeFsFile>()
  // For debugging.
  private lastError: Error | null = null
  private readonly directory: string
  private readonly pendingSources = new Map<string, NodeSourceCreation>()
  constructor(name: string, module: unknown, directory: string) {
    super(name, module)

    this.directory = directory
  }

  registerSourceCreation(creation: NodeSourceCreation, fileName = creation.storageName): void {
    const pathname = path.resolve(this.directory, fileName)
    if (pathname !== creation.storageName) throw new Error('SOURCE allocation belongs to a different SQLite main path')
    if (creation.disposition !== 'pending' || this.pendingSources.has(pathname) === true) {
      throw new Error('SOURCE descriptor is not an unclaimed allocation')
    }
    this.pendingSources.set(pathname, creation)
  }

  discardUnadoptedSource(creation: NodeSourceCreation): void {
    if (this.pendingSources.get(creation.storageName) === creation) {
      creation.closeUnadopted()
      this.pendingSources.delete(creation.storageName)
    }
  }

  trackDatabaseOpen(fileName: string, open: () => number): { dbPointer: number; assertClosed: () => void } {
    const pathname = path.resolve(this.directory, fileName)
    if (this.mapIdToFile.size !== 0) throw new Error('Node database VFS still owns file entries')
    const dbPointer = open()
    const opened = [...this.mapIdToFile].filter(
      ([, file]) =>
        file.pathname === pathname && file.fileHandle !== null && (file.flags & VFS.SQLITE_OPEN_MAIN_DB) !== 0,
    )
    if (opened.length !== 1) throw new Error('SQLite open lacks one exact owned Node MAIN_DB descriptor')
    const entry = opened[0]!
    return {
      dbPointer,
      assertClosed: () => {
        // SQLite may return success from close after xClose failed; the actual descriptor ledger is authoritative.
        if (this.mapIdToFile.size !== 0) {
          throw new Error(`Node SQLite descriptor close did not complete for ${entry[1].pathname}`, {
            cause: this.lastError,
          })
        }
      },
    }
  }

  protected openDescriptor(pathname: string, flags: number): number {
    return fs.openSync(pathname, flags)
  }

  override getFilename(fileId: number): string {
    const pathname = this.mapIdToFile.get(fileId)?.pathname
    return `NodeFS:${pathname}`
  }

  override jOpen(zName: string | null, fileId: number, flags: number, pOutFlags: DataView): number {
    try {
      const pathname =
        zName !== null && zName !== '' ? path.resolve(this.directory, zName) : Math.random().toString(36).slice(2)
      if (
        (flags & VFS.SQLITE_OPEN_MAIN_DB) !== 0 &&
        [...this.mapIdToFile.values()].some((file) => file.fileHandle !== null) === true
      ) {
        throw new Error('Node VFS already owns a physical database connection')
      }
      if (this.mapIdToFile.get(fileId)?.fileHandle != null) {
        throw new Error('SQLite file ID still owns an unreleased Node descriptor')
      }
      const file: NodeFsFile = { pathname, flags, fileHandle: null }
      this.mapIdToFile.set(fileId, file)

      const creation = this.pendingSources.get(pathname)
      if (creation !== undefined) {
        file.fileHandle = creation.adopt(pathname, flags)
        file.creation = creation
        this.pendingSources.delete(pathname)
      } else {
        const readwrite = (flags & VFS.SQLITE_OPEN_READWRITE) !== 0
        const create = (flags & VFS.SQLITE_OPEN_CREATE) !== 0
        const exclusive = (flags & VFS.SQLITE_OPEN_EXCLUSIVE) !== 0
        // CREATE must not truncate a file that appeared after discovery. Only the O_EXCL receipt grants freshness.
        const nativeFlags =
          (readwrite === true ? fs.constants.O_RDWR : fs.constants.O_RDONLY) |
          (create === true ? fs.constants.O_CREAT : 0) |
          (create === true && exclusive === true ? fs.constants.O_EXCL : 0)
        file.fileHandle = this.openDescriptor(pathname, nativeFlags)
      }
      pOutFlags.setInt32(0, flags, true)
      return VFS.SQLITE_OK
    } catch (e: any) {
      this.lastError = e
      return VFS.SQLITE_CANTOPEN
    }
  }

  override jRead(fileId: number, pData: Uint8Array<ArrayBuffer>, iOffset: number): number {
    try {
      const file = this.mapIdToFile.get(fileId)
      if (file?.fileHandle == null) return VFS.SQLITE_IOERR_READ

      // const view = new DataView(pData.buffer, pData.byteOffset, pData.length)
      // const bytesRead = fs.readSync(file.fileHandle, view, 0, pData.length, iOffset)
      const bytesRead = fs.readSync(file.fileHandle, pData.subarray(), { position: iOffset })

      if (bytesRead < pData.length) {
        pData.fill(0, bytesRead)
        return VFS.SQLITE_IOERR_SHORT_READ
      }
      return VFS.SQLITE_OK
    } catch (e: any) {
      this.lastError = e
      return VFS.SQLITE_IOERR_READ
    }
  }

  override jWrite(fileId: number, pData: Uint8Array<ArrayBuffer>, iOffset: number): number {
    try {
      const file = this.mapIdToFile.get(fileId)
      if (file?.fileHandle == null) return VFS.SQLITE_IOERR_WRITE

      // const view = new DataView(pData.buffer, pData.byteOffset, pData.length)
      // fs.writeSync(file.fileHandle, view, 0, pData.length, iOffset)
      fs.writeSync(file.fileHandle, Buffer.from(pData.subarray()), 0, pData.length, iOffset)
      return VFS.SQLITE_OK
    } catch (e: any) {
      this.lastError = e
      return VFS.SQLITE_IOERR_WRITE
    }
  }

  override jClose(fileId: number): number {
    try {
      const file = this.mapIdToFile.get(fileId)
      if (file == null) return VFS.SQLITE_OK

      if (file.fileHandle !== null) {
        if (file.creation !== undefined) file.creation.closeAdopted()
        else fs.closeSync(file.fileHandle)
      }
      // Preserve the actual descriptor/root if native close fails rather than claiming disposal.
      this.mapIdToFile.delete(fileId)

      if ((file.flags & VFS.SQLITE_OPEN_DELETEONCLOSE) !== 0) {
        fs.unlinkSync(file.pathname)
      }
      return VFS.SQLITE_OK
    } catch (e: any) {
      this.lastError = e
      return VFS.SQLITE_IOERR_CLOSE
    }
  }

  override jFileSize(fileId: number, pSize64: DataView): number {
    try {
      const file = this.mapIdToFile.get(fileId)
      if (file?.fileHandle == null) return VFS.SQLITE_IOERR_FSTAT

      const stats = fs.fstatSync(file.fileHandle)
      pSize64.setBigInt64(0, BigInt(stats.size), true)
      return VFS.SQLITE_OK
    } catch (e: any) {
      this.lastError = e
      return VFS.SQLITE_IOERR_FSTAT
    }
  }

  override jTruncate(fileId: number, iSize: number): number {
    try {
      const file = this.mapIdToFile.get(fileId)
      if (file?.fileHandle == null) return VFS.SQLITE_IOERR_TRUNCATE

      fs.ftruncateSync(file.fileHandle, iSize)
      return VFS.SQLITE_OK
    } catch (e: any) {
      this.lastError = e
      return VFS.SQLITE_IOERR_TRUNCATE
    }
  }

  override jSync(fileId: number, _flags: number): number {
    try {
      const file = this.mapIdToFile.get(fileId)
      if (file?.fileHandle == null) return VFS.SQLITE_OK

      // TODO do this out of band (for now we disable it to speed up the node vfs)
      // fs.fsyncSync(file.fileHandle)
      return VFS.SQLITE_OK
    } catch (e: any) {
      this.lastError = e
      return VFS.SQLITE_IOERR_FSYNC
    }
  }

  override jDelete(zName: string, _syncDir: number): number {
    try {
      const pathname = path.resolve(this.directory, zName)
      fs.unlinkSync(pathname)
      return VFS.SQLITE_OK
    } catch (e: any) {
      this.lastError = e
      return VFS.SQLITE_IOERR_DELETE
    }
  }

  override jAccess(zName: string, _flags: number, pResOut: DataView): number {
    try {
      const pathname = path.resolve(this.directory, zName)
      const exists = fs.existsSync(pathname)
      pResOut.setInt32(0, exists === true ? 1 : 0, true)
      return VFS.SQLITE_OK
    } catch (e: any) {
      this.lastError = e
      return VFS.SQLITE_IOERR_ACCESS
    }
  }

  deleteDb(fileName: string) {
    fs.unlinkSync(path.resolve(this.directory, fileName))
  }
}
