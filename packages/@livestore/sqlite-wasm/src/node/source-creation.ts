import * as fs from 'node:fs'
import path from 'node:path'

import * as VFS from '@livestore/wa-sqlite/src/VFS.js'

export interface NodeSourceCreationBoundary {
  readonly storageName: string
  readonly kind: 'exclusive-node-file-creation'
  readonly isHeld: () => boolean
}

/** The exact O_EXCL descriptor, not a pathname/existence observation, crosses into SQLite. */
export class NodeSourceCreation {
  readonly storageName: string
  #descriptor: number
  #phase: 'pending' | 'adopted' | 'open' | 'closed' | 'uncertain' = 'pending'

  private constructor(storageName: string, descriptor: number) {
    this.storageName = storageName
    this.#descriptor = descriptor
  }

  static reserve(storageName: string): NodeSourceCreation {
    const resolved = path.resolve(storageName)
    return new NodeSourceCreation(resolved, fs.openSync(resolved, 'wx+'))
  }

  get disposition() {
    return this.#phase
  }

  adopt(storageName: string, flags: number): number {
    if (
      this.#phase !== 'pending' ||
      path.resolve(storageName) !== this.storageName ||
      (flags & VFS.SQLITE_OPEN_MAIN_DB) === 0 ||
      (flags & VFS.SQLITE_OPEN_READWRITE) === 0 ||
      (flags & VFS.SQLITE_OPEN_DELETEONCLOSE) !== 0
    ) {
      throw new Error('SOURCE descriptor cannot be adopted by this SQLite open')
    }
    this.#phase = 'adopted'
    return this.#descriptor
  }

  opened(): NodeSourceCreationBoundary {
    if (this.#phase !== 'adopted') throw new Error('SOURCE descriptor was not adopted by SQLite')
    this.#phase = 'open'
    return Object.freeze({
      storageName: this.storageName,
      kind: 'exclusive-node-file-creation' as const,
      isHeld: () => this.#phase === 'open',
    })
  }

  closeUnadopted(): void {
    if (this.#phase === 'pending') this.#close()
  }

  closeAdopted(): void {
    if (this.#phase !== 'adopted' && this.#phase !== 'open') {
      throw new Error('SOURCE descriptor is not a live adopted SQLite file')
    }
    this.#close()
  }

  #close(): void {
    try {
      fs.closeSync(this.#descriptor)
      this.#phase = 'closed'
    } catch (cause) {
      // An uncertain descriptor is retained by its VFS owner; it cannot mint or regain freshness.
      this.#phase = 'uncertain'
      throw cause
    }
  }
}

/** Caller owns the replica namespace; failure leaves any existing/created path untouched. */
export const reserveNodeSource = (storageName: string): NodeSourceCreation => NodeSourceCreation.reserve(storageName)
