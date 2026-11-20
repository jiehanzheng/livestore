/**
 * Astro-Twoslash-Code snippets virtual-filesystem specification
 *
 * Why this exists
 * ----------------
 *   Docs authors scatter runnable examples across `docs/src/content/_assets/code/**` and
 *   reference them via `?snippet` imports.  At build time we have to aggregate those loose
 *   files, give Twoslash a coherent (TypeScript-compatible) virtual filesystem, and then ship
 *   pre-rendered artefacts plus a manifest that Astro can hydrate.  The machinery below is the
 *   canonical description of how physical files are converted into virtual paths, how we guard
 *   against ambiguous aliases, and which invariants consumers can rely on.
 *
 * Source directory model
 * ----------------------
 *   - `resolveProjectPaths(projectRoot)` anchors every run in a single snippet root
 *     (`{projectRoot}/src/content/_assets/code`).  All bundle operations happen inside this root.
 *   - `buildSnippetBundle` follows relative `./` and `../` imports.  Anything outside the snippet
 *     root is intentionally ignored; authors must copy supporting files into the docs repo.
 *   - Triple-slash references are stripped (`sanitizeSnippetContent`) so that Twoslash does not
 *     accidentally traverse "real" project dependencies.
 *
 * Canonical virtual paths
 * -----------------------
 *   - Every collected file receives a canonical virtual path that mirrors its relative path from
 *     the snippet root (e.g. `reference/solid-integration/livestore/schema.ts →
 *     ./reference/solid-integration/livestore/schema.ts`).  Dot-segments are collapsed, but parent
 *     traversals are preserved to keep cross-directory references resolvable.
 *   - We record these canonical paths once per file.  Duplicates (such as `./schema.ts` and
 *     `./reference/.../schema.ts`) are not emitted because TypeScript would otherwise drop the
 *     duplicate from program state, leading to the "Cannot find module" errors that motivated this
 *     rewrite.
 *
 * Specifier rewrites & focus handling
 * -----------------------------------
 *   - `normalizeRelativeSpecifiers` walks each file, captures the author-written specifier
 *     (`raw`), normalises it relative to the source file (`normalized`), and resolves a canonical
 *     target (`canonical`).  This table is the ground truth for later transformations.
 *   - When we render a focus file, its content is rewritten to canonical specifiers only for the
 *     Twoslash compilation (`focusTwoslashContent`).  Supporting files retain their canonical
 *     source unchanged, ensuring a stable view of the module graph.
 *   - `assembleSnippet` prefixes every virtual file with ownership sentinels (`// __LS_FILE_START__` /
 *     `// __LS_FILE_END__`) and records the owning virtual path for each line.  The focus file is
 *     concatenated after the supporting files so its boundaries remain explicit after Twoslash
 *     removes cut regions.
 *   - A Shiki transformer (`livestore-line-ownership`) mirrors the recorded ownership onto
 *     the rendered Shiki AST via `data-ls-owner` / `data-ls-marker` attributes.  After Twoslash finishes,
 *     `trimRenderedAst` uses that structured metadata to keep only focus-owned rows, scrub the
 *     helper attributes, remove any remaining sentinel artefacts (including inside tooltips), and
 *     rebuild the copy payload without touching support files.  `restoreFocusSpecifiers` then walks
 *     the AST to swap the canonical strings back to the author-written forms so the docs match the
 *     prose.
 *
 * Artefact manifest contract
 * --------------------------
 *   - Each snippet bundle yields a JSON artefact stored under
 *     `{projectRoot}/.cache/snippets/<main-file>.json`.  The payload lists:
 *       * `files`: hashed source files with their relative (on-disk) paths.
 *       * `rendered`: per-file HTML/diagnostics keyed by the original relative filename.
 *   - The manifest (`.cache/snippets/manifest.json`) aggregates bundle hashes and the renderer
 *     assets (base styles, theme styles, JS modules).  Astro consumes this manifest to inline
 *     static assets without re-running Twoslash.
 *
 * Design decisions & unsupported patterns
 * ---------------------------------------
 *   - One bundle ↔ one authoritative path per file.  We deliberately avoid alias files or
 *     duplicate `// @filename` sections; doing so keeps TypeScript's incremental compiler stable.
 *   - Import specifiers must remain relative (`./` or `../`).  Absolute, package-based, or runtime
 *     dynamic imports are rejected by the crawler and therefore unsupported.
 *   - References that escape the snippet root (`../..`) are normalised but still trimmed to their
 *     canonical representation; if the resolved file lives outside the root it is skipped.  This
 *     prevents unintentional leakage of monorepo sources into the docs build.
 *   - Worker query parameters (`?worker`, `?sharedworker`) and similar suffixes are preserved.  We
 *     treat everything after `?`/`#` as a transparent suffix when rewriting specifiers.
 *   - The tooling assumes NodeNext-style resolution with explicit extensions.  Files without an
 *     extension or specifiers resolved via index files are not supported.
 *
 * This comment is the authoritative spec for the path handling layer—keep it in sync with any
 * behavioural changes so downstream consumers understand the guarantees they receive.  If you touch
 * any code in this module, update this spec first; drift here will guarantee regressions the next
 * time someone tweaks Twoslash or the docs build.
 */
/**
 * CLI entrypoint that keeps docs snippets warm.
 *
 * Workflow overview:
 *   1. Crawl doc sources for `?snippet` imports and resolve each entry file.
 *   2. Build a multi-file bundle per entry, render it through Shiki/Twoslash, and capture HTML + styles.
 *   3. Emit per-snippet artefacts and a manifest (including global styles/modules) into the cache directory.
 *
 * The pre-rendered output is consumed by Astro at build time so code examples render instantly without running
 * Twoslash in the browser.
 */
import path from 'node:path'

import { Effect, FileSystem } from '@livestore/utils/effect'

import type { TwoslashProjectPaths } from '../project-paths.ts'
import type { TwoslashRuntimeOptions } from '../renderer-config.ts'
import { renderInputLimit } from '../renderer-protocol.ts'
import {
  buildSnippetArtifact,
  loadPreviousManifest,
  type TManifestEntry,
  type TSnippetManifest,
} from './snippet-artifacts.ts'
import { collectSourceFiles, collectSnippetEntries } from './snippet-entries.ts'
import { SnippetBuildError } from './snippet-error.ts'
import { loadSnippetRenderer } from './snippet-render.ts'

export type ResolvedBuildOptions = { paths: TwoslashProjectPaths; runtimeOptions: TwoslashRuntimeOptions }
const jsonStringifyPretty = (value: unknown): string => JSON.stringify(value, null, 2)

export const buildSnippetArtifacts = ({ paths, runtimeOptions }: ResolvedBuildOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    yield* fs.makeDirectory(paths.cacheRoot, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new SnippetBuildError({
            message: `Failed to ensure cache directory: ${paths.cacheRoot}`,
            cause,
          }),
      ),
    )

    const sourceFiles = yield* collectSourceFiles(fs, paths.srcRoot)
    const snippetEntries = yield* collectSnippetEntries(fs, sourceFiles)

    if (snippetEntries.length === 0) {
      yield* Effect.log('No ?snippet imports found in docs source')
      return
    }

    const { renderer, configHash } = yield* loadSnippetRenderer(paths, runtimeOptions)
    yield* Effect.addFinalizer(() => Effect.sync(renderer.dispose))
    const previousManifest = yield* loadPreviousManifest(fs, paths, configHash)
    const previousEntries = previousManifest?.entries ?? new Map<string, TManifestEntry>()
    const artifactEntries: Array<TSnippetManifest['entries'][number]> = []
    const inputBudget = { remaining: renderInputLimit }
    let renderedCount = 0

    yield* Effect.log(`Rendering ${snippetEntries.length} snippet bundles`)

    for (const entry of snippetEntries) {
      const built = yield* buildSnippetArtifact(entry, { fs, paths, renderer, previousEntries, inputBudget })
      artifactEntries.push(built.entry)
      if (built.rendered === true) renderedCount += 1
    }

    const manifest: TSnippetManifest = {
      version: 1,
      generatedAt: new Date().toISOString(),
      configHash,
      baseStyles: renderer.baseStyles,
      themeStyles: renderer.themeStyles,
      jsModules: renderer.jsModules,
      entries: artifactEntries,
    }

    yield* fs.writeFileString(path.join(paths.cacheRoot, 'manifest.json'), `${jsonStringifyPretty(manifest)}\n`).pipe(
      Effect.mapError(
        (cause) =>
          new SnippetBuildError({
            message: 'Unable to write snippets manifest',
            cause,
          }),
      ),
    )

    const cacheHits = snippetEntries.length - renderedCount
    yield* Effect.log(`Rendered ${renderedCount} snippet bundles (${cacheHits} cache hits)`)

    return renderedCount
  }).pipe(Effect.scoped)
