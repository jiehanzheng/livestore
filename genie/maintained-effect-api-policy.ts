/** Capabilities owned by the normal maintained renderer projects; diagnostics stay strict. */
export const maintainedEffectApiPolicy = {
  'packages/@local/astro-twoslash-code': {
    runtime: [
      '@effect/platform-node/NodeFileSystem#layer',
      'effect/FileSystem#FileSystem',
      'effect/FileSystem#WatchEvent',
      'effect/PlatformError#PlatformError',
      'effect/cli/Command#make',
      'effect/cli/Command#withSubcommands',
    ],
    tests: ['effect/FileSystem#makeNoop', 'effect/PlatformError#systemError'],
  },
  'packages/@local/astro-tldraw': {
    runtime: [
      '@effect/platform-node/NodeFileSystem#layer',
      'effect/FileSystem#FileSystem',
      'effect/FileSystem#WatchEvent',
      'effect/PlatformError#PlatformError',
    ],
    tests: ['@effect/vitest#it', '@effect/vitest#live'],
  },
  'scripts/maintained-qualification': {
    runtime: [
      'effect/cli/Flag#Boolean',
      'effect/cli/Flag#Literals',
      'effect/cli/Flag#String',
      'effect/cli/Flag#optional',
      'effect/cli/Flag#withDefault',
      'effect/cli/Flag#withDescription',
      'effect/http/HttpClient#HttpClient',
      'effect/http/HttpClient#execute',
      'effect/http/HttpClient#filterStatusOk',
      'effect/http/HttpClientRequest#get',
      'effect/http/HttpClientRequest#post',
      'effect/http/HttpClientRequest#schemaBodyJson',
      'effect/http/HttpClientRequest#setHeader',
      'effect/http/HttpClientRequest#setHeaders',
      'effect/process/ChildProcess#make',

      'effect/FileSystem#FileSystem',
      'effect/PlatformError#PlatformError',
      'effect/cli/Command#make',
      'effect/cli/Command#withDescription',
      'effect/cli/Command#withSubcommands',
    ],
  },
} as const
