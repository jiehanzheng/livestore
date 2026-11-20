# Docs — Spec

This document specifies the documentation system. It builds on
[requirements.md](./requirements.md).

## Status

Draft.

## Scope

Defines: the derivation mechanics, information architecture, snippet
pipeline, and diagram policy. Does not define example apps
([01-examples/](./01-examples/requirements.md)), search
([02-search/](./02-search/requirements.md)), docs operations
([03-operations/](./03-operations/requirements.md)), or contribution
workflow (`05-contributing/`).

## Derivation Mechanics (LS.DOCS-R01, R02)

- VRS nodes are the source; docs pages render their content for users.
- `01-product/spec.md` maintains the mapping for overview pages; system
  nodes own the pages describing their subsystem.
- When a VRS contract changes, the derived pages change in the same PR or a
  follow-up docs PR referencing the VRS change.
- Term usage follows the root ontology; `overview/concepts` is a derived
  rendering of it.

## Information Architecture (LS.DOCS-R06)

| Section (`docs/src/content/docs/`)                                 | Audience path                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------------- |
| `overview/`, `index.mdx`                                           | Orientation: what/why/when, concepts                          |
| `getting-started/`, `tutorial/`                                    | Adoption                                                      |
| `building-with-livestore/`                                         | Building: store, events, state, reactivity, syncing, devtools |
| `understanding-livestore/`                                         | Depth: event sourcing, design rationale                       |
| `platform-adapters/`, `sync-providers/`, `framework-integrations/` | One page per realization of each pluggable dimension          |
| `examples/`                                                        | Learning by example (see `01-examples/`)                      |
| `patterns/`, `api/`, `misc/`                                       | Reference and cross-cutting topics                            |
| `sustainable-open-source/`                                         | Derived from `06-sustainability/` and `05-contributing/`      |

## Snippet Pipeline (LS.DOCS-R04)

- Snippet sources live in the snippet workspace
  `docs/src/content/_assets/code/**`; imports are relative with explicit
  extensions; no `@ts-ignore`/`as any` workarounds.
- Snippets are pre-rendered with Shiki and Twoslash via
  `@local/astro-twoslash-code`; docs import them with `?snippet`.
- TypeScript's runtime API and the Vue language plugin check the actual
  snippet graph, including Vue templates. Native snippets have a separate
  owner with real Expo and React Native dependencies.
- The renderer preserves per-file ownership, author-written imports, type
  hovers, diagnostics and copy text. A rendering/type error fails the build;
  cached artifacts are invalidated when renderer or snippet inputs change.
- Runnable schema examples, including inline tutorial code, declare
  `projectionRevision`. Tutorial steps that change materialization advance that
  revision while retaining the event contracts they still consume.
- `mono docs dev|build` builds snippets and diagrams by default;
  `mono docs snippets build` renders bundles + manifest for CI; docs CI fails
  when snippets stop compiling.
- The authoritative pipeline contract is the header comment of
  `packages/@local/astro-twoslash-code/src/cli/snippet-build.ts`.

## Effect Application Pattern

The default Effect guide teaches the current public LiveStore integration rather
than introducing a parallel Atom store lifetime. In React, one `StoreRegistry`
owns each store; public `useStore`/`useQuery` hooks own reactive reads and
`store.commit` owns event writes. Ordinary Effect services can operate on the
actual store supplied by the application. `Store.Tag` is the alternative owner
for an Effect-managed application, not another owner around a React store.

Examples retain actual OPFS workers and persistence, subscription release,
boot/service error handling, one-commit bulk updates, derived values, and public
query tracing options. Uncommitted drafts remain distinct from committed
local-first events and remote synchronization. Do not manufacture running-stage
context flags or depend on private SDK state. Atom-specific interoperability is
outside this default guide; removing it is an integration-design choice, not a
diagnostic-policy exception.

## Diagram Policy (LS.DOCS-R05)

- New diagrams use D2 (`...@base.d2` include); legacy diagrams remain as
  TLDraw sources (`docs/src/content/_assets/diagrams/*.tldr`) and inline
  Mermaid blocks in MDX pages.
- Diagram sources are versioned next to the docs content that uses them.

## Versioning Policy

The docs site tracks the latest release only; there are no per-release
snapshots (policy captured 2026-07-15; tradeoff LS.DOCS-T01).
