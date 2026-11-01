import { type WebChannel, Schema } from '@livestore/utils/effect'

import {
  LegacyStorageFormatError,
  ProjectionMismatchError,
  LiveDatabaseImportRefusedError,
  BackendIdMismatchError,
  IntentionalShutdownCause,
  MaterializeError,
  UnknownError,
} from '../index.ts'
import { MaterializationJournalError } from '../MaterializationJournal.ts'

export const All = Schema.Union([
  IntentionalShutdownCause,
  UnknownError,
  LegacyStorageFormatError,
  ProjectionMismatchError,
  LiveDatabaseImportRefusedError,
  BackendIdMismatchError,
  MaterializeError,
  MaterializationJournalError,
])

/**
 * Used internally by an adapter to shutdown gracefully.
 */
export type ShutdownChannel = WebChannel.WebChannel<typeof All.Type, typeof All.Type>
