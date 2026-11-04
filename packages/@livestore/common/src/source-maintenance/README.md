# Retained SOURCE maintenance

The common domain owns raw format-7 rows, canonical decoding, contiguous prefix
coverage, commitments, position-preserving adoption and SOURCE incarnation changes.
The application owns the opaque location/authorization context, its actual durable
intent receipt, current access checks and its real exclusive location owner. JSON
and hashes bind those decisions; neither authenticates them.

`captureSource` stages every retained generation and residual row under one SOURCE
transaction. A completed capture is published only after that transaction and the
actual resource scope/location owner join. A capture can be complete as an export
while its acknowledged-prefix coverage is incomplete; those are separate claims.

`inspectSourceCapture` verifies the immutable archive without opening SOURCE or a
target server. Its raw stream includes unknown events. `readCanonicalPrefix` needs
reviewed event definitions and can select a bounded subprefix; original coverage
and acknowledged head remain explicit. `deriveSourceEventDefinitions` uses exactly
`Schema.hash(eventDefinition.schema)`, the per-event argument-codec hash used by
normal materialization. A current name never authenticates an older unknown hash.

Preparation produces a compact immutable plan, not a second operation journal.
The application's existing durable intent must exist before `adoptSource`. One
SOURCE transaction accepts only its exact original preimage or planned postimage.
It preserves rows, bodies, attribution, coordinates and acknowledged head; changes
the backend pin, clears obsolete transport metadata, and rotates to the planned
SOURCE incarnation so old STATE provenance cannot survive. Exact postimage resume
is idempotent; mixed state is refused.

Normal shared pending events already have global/client coordinates `(H+1,0)`;
client-only events have `(H,client+1)`. Recovery does not invent a normalization,
relocate occurrences, deduplicate action IDs, or upload client-only work. Unknown
producer classification remains exportable and blocks activation.

`SourceMaintenanceError.closure` describes the actual SDK resource scope separately
from `commitStatus`. A body refusal after acquired resources close is `joined`;
failed teardown or an opaque incomplete acquisition is `unknown`. Publication
failure after successful teardown is still `joined`. The real application owner
uses that outcome to decide whether its borrower can be released. No rejected
write or close is retried, and no timeout proves physical release.

Retained platform openers reuse the selected normal providers: OPFS, Expo, Node,
and native shared hosts where supplied. The isolated experimental IndexedDB SOURCE
factory was retired; its preserved upstream diagnostics do not qualify these
providers. Native browser/device failure and handover evidence remains separate
from modeled tests and local SDK qualification.

`inspectSourceAdoption` resolves local outcome using the same exact original and
planned postimage classifier as adoption. It requires the original validated plan,
immutable intent and actual location-owner admission, but no target/network proof
or event definitions: every raw row and metadata commitment is compared directly.
Its consistent outer transaction performs only SELECTs. Only joined resource and
location closure publishes `applied`, `not-applied` or `foreign`; unreadable or
malformed SOURCE fails rather than being classified. This is local evidence, not
a grant, activation, cancellation or intent-finalization receipt. In particular,
a revoked graph stays denied even when local outcome is `applied`. The application
may finalize its existing intent only under its own reviewed protocol; uncertain
closure retains its owner. Read-only inspection errors have `commitStatus`
`not-started`, describing this invocation rather than the earlier adoption.

Pre-open SDK refusals (pure plan decoding/preparation/archive inspection and
adoption target validation) report `closure: joined` and `commitStatus:
not-started`: no SDK SOURCE resource was acquired. This does not attest closure
of caller-owned stream or sink resources. Their original error stays nested in
the cause chain, including any `unknown` closure, for the actual caller owner to
retain. After entering location acquisition, only its real joined scope result
can attest closure; the default error constructor stays conservative.
