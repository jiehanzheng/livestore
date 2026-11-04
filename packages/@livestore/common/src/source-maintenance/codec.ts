import { sha256 } from '@noble/hashes/sha2.js'

import { Effect, Schema } from '@livestore/utils/effect'

import { SourceMaintenanceError, type Json, type ApplicationBinding } from './types.ts'

const canonical = (value: Json): Json => {
  if (Array.isArray(value) === true) return value.map(canonical)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      (Object.entries(value) as Array<[string, Json]>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    )
  return value
}
export const encode = (value: unknown): string =>
  JSON.stringify(canonical(Schema.decodeUnknownSync(Schema.Json)(value)))
export const equal = (left: unknown, right: unknown): boolean => encode(left) === encode(right)
/** Maintenance receipts must not depend on provider-specific WebCrypto support; keep the same SHA256 on every provider. */
export const digest = (value: unknown): Effect.Effect<string, SourceMaintenanceError> =>
  Effect.try({
    try: () =>
      [...sha256(new TextEncoder().encode(encode(value)))].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    catch: (cause) => new SourceMaintenanceError('digest', cause),
  })

/** Own JSON evidence before yielding or handing it to a staging callback. */
export const ownJson = <A>(value: A): A => {
  const owned = JSON.parse(encode(value)) as A
  const freeze = (node: unknown): void => {
    if (node !== null && typeof node === 'object') {
      for (const child of Object.values(node)) freeze(child)
      Object.freeze(node)
    }
  }
  freeze(owned)
  return owned
}
export const boundedBinding = (binding: ApplicationBinding) => {
  if (
    typeof binding.operationId !== 'string' ||
    binding.operationId.trim().length === 0 ||
    new TextEncoder().encode(encode(binding)).length > 1024 * 1024
  )
    throw new SourceMaintenanceError(
      'application-binding',
      'Nonempty operation ID and bounded opaque JSON context required',
    )
  return ownJson(binding)
}

export const parseJson = <A>(text: string): Effect.Effect<A, SourceMaintenanceError> =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.map((value) => value as A),
    Effect.mapError((cause) => new SourceMaintenanceError('json-evidence', cause)),
  )
