import path from 'node:path'

import type { Duration } from '@livestore/utils/effect'
import { Effect } from '@livestore/utils/effect'
import { Cli, NodeFileSystem } from '@livestore/utils/node'

import { resolveProjectPaths, type TwoslashProjectPaths } from '../project-paths.ts'
import { normalizeRuntimeOptions, type TwoslashRuntimeOptions } from '../renderer-config.ts'
import { runRendererJob } from '../renderer-job.ts'
import { watchSnippetChanges, type SnippetWatchOptions, type WatchSnippetsRebuildInfo } from './snippet-watch.ts'
export type { WatchSnippetsRebuildInfo } from './snippet-watch.ts'
import { SnippetBuildError } from './snippet-error.ts'

export type BuildSnippetsOptions = {
  projectRoot?: string
  runtime?: TwoslashRuntimeOptions
}

type ResolvedBuildOptions = {
  paths: TwoslashProjectPaths
  runtimeOptions: TwoslashRuntimeOptions
}

const DEFAULT_WATCH_DEBOUNCE: Duration.Input = '150 millis'

export type WatchSnippetsOptions = BuildSnippetsOptions & {
  debounce?: Duration.Input
  onRebuild?: (info: WatchSnippetsRebuildInfo) => Effect.Effect<void>
}

const resolveOptions = (options: BuildSnippetsOptions = {}): ResolvedBuildOptions => {
  const projectRoot = options.projectRoot !== undefined ? path.resolve(options.projectRoot) : process.cwd()
  const runtimeOptions = normalizeRuntimeOptions(options.runtime)
  return {
    paths: resolveProjectPaths(projectRoot),
    runtimeOptions,
  }
}

const normalizeWatchOptions = (
  options: Partial<Pick<WatchSnippetsOptions, 'debounce' | 'onRebuild'>> = {},
): SnippetWatchOptions => ({
  debounce: options.debounce ?? DEFAULT_WATCH_DEBOUNCE,
  onRebuild: options.onRebuild ?? (() => Effect.void),
})

const normalizeOptions = (options: BuildSnippetsOptions = {}): BuildSnippetsOptions => {
  const normalized: BuildSnippetsOptions = {}
  if (options.projectRoot !== undefined) {
    normalized.projectRoot = options.projectRoot
  }
  if (options.runtime !== undefined) {
    normalized.runtime = normalizeRuntimeOptions(options.runtime)
  }
  return normalized
}

const runBuildSnippets = (resolved: ResolvedBuildOptions) => {
  return runRendererJob({
    mode: 'build',
    projectRoot: resolved.paths.projectRoot,
    ownerRoot: resolved.paths.snippetAssetsRoot,
    runtime: resolved.runtimeOptions,
  }).pipe(
    Effect.mapError((cause) => new SnippetBuildError({ message: String(cause), cause })),
    Effect.filterOrFail(
      (value): value is number | undefined => typeof value === 'number' || value === undefined,
      () => new SnippetBuildError({ message: 'Renderer child returned an invalid build result.' }),
    ),
  )
}

export const buildSnippets = (options: BuildSnippetsOptions = {}) => {
  const resolved = resolveOptions(normalizeOptions(options))
  return Effect.withSpan('astro-twoslash-code/build-snippets')(runBuildSnippets(resolved))
}

export const watchSnippets = (options: WatchSnippetsOptions = {}) => {
  const { debounce, onRebuild, ...baseOptions } = options
  const resolved = resolveOptions(normalizeOptions(baseOptions))
  const normalizedWatch = normalizeWatchOptions({
    ...(debounce !== undefined ? { debounce } : {}),
    ...(onRebuild !== undefined ? { onRebuild } : {}),
  })
  return watchSnippetChanges(resolved.paths, normalizedWatch, runBuildSnippets(resolved)).pipe(
    Effect.withSpan('astro-twoslash-code/watch-snippets'),
    Effect.provide(NodeFileSystem.layer),
  )
}

export type CreateSnippetsCommandOptions = BuildSnippetsOptions & {
  commandName?: string
}

export const createSnippetsCommand = ({
  projectRoot,
  runtime,
  commandName = 'snippets',
}: CreateSnippetsCommandOptions = {}) => {
  const resolved = resolveOptions(
    normalizeOptions({
      ...(projectRoot !== undefined ? { projectRoot } : {}),
      ...(runtime !== undefined ? { runtime } : {}),
    }),
  )

  const buildHandler = Effect.withSpan('astro-twoslash-code/cli/snippets-build')(runBuildSnippets(resolved)).pipe(
    Effect.asVoid,
  )

  const watchHandler = watchSnippetChanges(resolved.paths, normalizeWatchOptions({}), runBuildSnippets(resolved)).pipe(
    Effect.withSpan('astro-twoslash-code/cli/snippets-watch'),
    Effect.provide(NodeFileSystem.layer),
    Effect.asVoid,
  )

  const buildCommand = Cli.Command.make('build', {}, () => buildHandler)
  const watchCommand = Cli.Command.make('watch', {}, () => watchHandler)

  return Cli.Command.make(commandName).pipe(Cli.Command.withSubcommands([buildCommand, watchCommand]))
}
