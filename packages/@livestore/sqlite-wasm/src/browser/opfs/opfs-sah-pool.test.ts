import { describe, expect, it } from 'vitest'

import { decodeAccessHandlePoolFilename, decodeAccessHandlePoolFilenameStrict } from './opfs-sah-pool.ts'

// wa-sqlite's free-handle format: zero corpus, native uint32 digest, one sector, no payload.
const freeHeader = () => {
  const bytes = new Uint8Array(4096)
  new Uint32Array(bytes.buffer, 516, 2).set([0xfecc5f80, 0xaccec037])
  return bytes
}
const associatedHeader = () => {
  const bytes = freeHeader()
  new TextEncoder().encodeInto('/eventlog.db', bytes)
  new DataView(bytes.buffer).setUint32(512, 0x100)
  // Fixed fixture digest for '/eventlog.db' with SQLITE_OPEN_MAIN_DB, independent of the reader.
  new Uint32Array(bytes.buffer, 516, 2).set([3306171757, 1434404358])
  return bytes
}
const asFile = (bytes: Uint8Array<ArrayBuffer>) => new File([bytes], 'opaque-pool-handle')

describe('strict read-only OPFS association decoding', () => {
  it('recognizes a valid unassociated handle', async () => {
    expect(await decodeAccessHandlePoolFilenameStrict(asFile(freeHeader()))).toBe('')
  })

  it('recognizes a source reservation with zero database payload', async () => {
    expect(await decodeAccessHandlePoolFilenameStrict(asFile(associatedHeader()))).toBe('/eventlog.db')
  })

  it('rejects a truncated header instead of interpreting absent digest words as valid', async () => {
    await expect(decodeAccessHandlePoolFilenameStrict(asFile(freeHeader().slice(0, 516)))).rejects.toThrow('Truncated')
  })

  it('distinguishes corrupt associations from valid free handles without changing legacy decoding', async () => {
    const bytes = associatedHeader()
    bytes[516] = bytes[516]! ^ 1
    await expect(decodeAccessHandlePoolFilenameStrict(asFile(bytes))).rejects.toThrow('digest')
    expect(await decodeAccessHandlePoolFilename(asFile(bytes))).toBe('')
  })

  it('refuses an associated file with valid digest but nonpersistent flags', async () => {
    const bytes = associatedHeader()
    new DataView(bytes.buffer).setUint32(512, 0)
    new Uint32Array(bytes.buffer, 516, 2).set([3963323730, 745072878])
    await expect(decodeAccessHandlePoolFilenameStrict(asFile(bytes))).rejects.toThrow('flags')
  })

  it('refuses invalid free flags and interrupted disassociation with retained payload', async () => {
    const flags = freeHeader()
    new DataView(flags.buffer).setUint32(512, 0x100)
    await expect(decodeAccessHandlePoolFilenameStrict(asFile(flags))).rejects.toThrow('disassociation')
    await expect(
      decodeAccessHandlePoolFilenameStrict(new File([freeHeader(), new Uint8Array([1])], 'retained-payload')),
    ).rejects.toThrow('disassociation')
  })
})
