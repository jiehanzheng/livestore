import { Effect, Stream } from '@livestore/utils/effect'

import * as Client from '../schema/LiveStoreEvent/client.ts'
import { readCaptureArchive } from './archive.ts'
import { digest, ownJson } from './codec.ts'
import { verifyDefinitions } from './definitions.ts'
import { noSourceOpen } from './no-source-open.ts'
import {
  type SourceCaptureInput,
  type InspectedSourceCapture,
  type SourceEventDefinitionWitness,
  SourceMaintenanceError,
} from './types.ts'

/** A stopped operator can inspect/reconstruct without a target backend, SOURCE open or adoption intent. */
export const inspectSourceCapture = (
  capture: SourceCaptureInput,
): Effect.Effect<InspectedSourceCapture, SourceMaintenanceError> =>
  Effect.gen(function* () {
    const verified = yield* readCaptureArchive(capture)
    const receipt = ownJson(verified.receipt)
    return {
      receipt,
      rows: Stream.fromIterable(verified.rows).pipe(Stream.map(ownJson)),
      readCanonicalPrefix: (
        definitions: readonly SourceEventDefinitionWitness[],
        options?: { readonly through?: number },
      ) =>
        Effect.gen(function* () {
          const through = options?.through ?? receipt.coverage.provenThrough
          if (Number.isSafeInteger(through) === false || through < 0 || through > receipt.coverage.provenThrough)
            return yield* Effect.fail(
              new SourceMaintenanceError(
                'capture-prefix-bound',
                'Requested prefix exceeds the proven acknowledged prefix',
              ),
            )
          const prefixRows = verified.decoded.filter(
            (row) => row.event.seqNum.client === 0 && row.event.seqNum.global <= through,
          )
          const selected = prefixRows.filter(
            (row, index) => index === 0 || row.event.seqNum.global !== prefixRows[index - 1]!.event.seqNum.global,
          )
          const events = selected.map((row) => Client.toGlobal(row.event))
          const eventDefinitionsDigest = yield* verifyDefinitions(definitions, prefixRows, events)
          let prefixDigest = yield* digest(['source-recovery-target-prefix', 1])
          for (const event of events)
            prefixDigest = yield* digest(['source-recovery-target-prefix', 1, event.seqNum, prefixDigest, event])
          return {
            coverage: receipt.coverage,
            through,
            prefixDigest,
            eventDefinitionsDigest,
            events: Stream.fromIterable(events).pipe(Stream.map(ownJson)),
          }
        }).pipe(noSourceOpen),
    }
  }).pipe(noSourceOpen)
