# Browser SQLite ownership

`yield* sqliteDbFactory({ sqlite3 })` acquires one scoped physical factory owner.
Its API must be fresh: it cannot belong to another physical owner or the shared
memory-only category. The factory is callable and exposes a joined, memoized
`close` Effect; its parent scope also closes it. No API is loaded per database.

The owner retains every acquisition fiber and every connection, including calls
from unrelated scopes. A database child's scope closes that connection only.
The owner rejects new opens, joins pending native initialization and connection
cleanup, then closes pool handles only when every native connection closed
successfully. A failed connection close immediately quarantines admission and
retains its pools/handles because the native database may still reference its
VFS. The close failure is memoized; it does not imply successful physical cleanup
or retry native closure. Acquisition failure alone does not retain pools after
all connections have successfully closed. A closed
API cannot acquire another owner because native VFS registrations survive scope
closure; deleting a JavaScript cache entry would not unregister them.

Pools use exact directory keys and owner-local registration names. They capture
the owner's resource scope rather than the first database child's scope. OPFS
calls within one owner must use the same Opfs service. An interrupted acquisition
cannot abandon a native initialization Promise or a newly opened pointer before
ownership is published. Configuration runs only after connection adoption.

`yield* inMemorySqliteDbFactory({ sqlite3 })` is memory-only and requires no OPFS
service or physical owner. Many graphs/sessions can share its API. It can never
claim an API that has been a physical owner. Memory VFS metadata is API-local.
Both web frontend adapters keep one eagerly loaded shared memory API; physical
leaders already load their fresh API inside the dedicated worker context. The
persisted frontend snapshot reader imports File bytes into memory and does not
create a physical pool; it retains memory sharing with the later session.

Each dedicated physical leader keeps one API for all state/eventlog/memory children.
Directly invoking the VFS compatibility `close()` helper is not a factory-lifetime
operation; physical authority comes from the joined owner cleanup. No worker
protocol, source format, or generation wire field is added by this ownership API.
