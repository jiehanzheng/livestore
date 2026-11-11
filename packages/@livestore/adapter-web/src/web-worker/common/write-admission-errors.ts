import { Schema } from '@livestore/utils/effect'

export class StaleWriteAdmission extends Schema.TaggedError<StaleWriteAdmission, { readonly brand: unique symbol }>()(
  'StaleWriteAdmission',
  {},
) {}

export class LeaderWriteUnconfirmed extends Schema.TaggedError<
  LeaderWriteUnconfirmed,
  { readonly brand: unique symbol }
>()('LeaderWriteUnconfirmed', {}) {}
