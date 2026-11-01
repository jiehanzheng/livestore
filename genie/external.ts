/**
 * Stable composition contract for peer repos.
 *
 * Keep this file self-contained (no nested repo imports) so composed megarepos
 * can import it without requiring nested megarepo sync.
 */

import { livestoreCurrentPackageNames, workspaceCatalogForPackageNames } from './repo-topology.ts'

/** One maintained runtime cohort is shared by all supported repository owners. */
export const effectVersion = '4.1.0'
export const effectV4Catalog = {
  effect: effectVersion,
  '@effect/ai-openai': effectVersion,
  '@effect/opentelemetry': effectVersion,
  '@effect/platform-browser': effectVersion,
  '@effect/platform-bun': effectVersion,
  '@effect/platform-node': effectVersion,
  '@effect/platform-node-shared': effectVersion,
  '@effect/sql-sqlite-node': effectVersion,
  '@effect/vitest': effectVersion,
} as const

export {
  livestoreCorePackageNames,
  livestoreCurrentPackageNames,
  livestoreEffectUtilsPackageNames,
  livestorePackageTopology,
  packageDescriptorForPackageName,
  packageDirForPackageName,
  packageJsonNameForPackageName,
  packageNamesForOwner,
  workspaceCatalogForPackageNames,
  type LivestorePackageName,
  type LivestorePackageOwner,
  type LivestorePackageTopologyEntry,
} from './repo-topology.ts'

export const livestoreContribPackageJsonNames = [
  '@livestore/cli',
  '@livestore/devtools-expo',
  '@livestore/graphql',
  '@livestore/solid',
  '@livestore/svelte',
  '@livestore/sync-electric',
  '@livestore/sync-s2',
] as const

/** Native modules and their renderer are qualified as one consumer-owned Expo cohort. */
export const nativeExpoQualificationCatalog = {
  expo: '58.0.21',
  'expo-sqlite': '58.0.14',
  'expo-file-system': '58.0.13',
  'react-native': '0.88.1',
  react: '19.3.0',
  // Expo's router server is part of its CLI graph and must share this consumer's React patch.
  'react-dom': '19.3.0',
} as const

export const livestoreContribPackageVersions = Object.fromEntries(
  livestoreContribPackageJsonNames.map((name) => [name, '0.5.0']),
) as Record<(typeof livestoreContribPackageJsonNames)[number], '0.5.0'>

/** Workspace packages exposed by LiveStore. */
export const livestoreWorkspaceCatalog = {
  ...workspaceCatalogForPackageNames(livestoreCurrentPackageNames),
  '@local/astro-tldraw': 'workspace:*',
  '@local/astro-twoslash-code': 'workspace:*',
  '@local/shared': 'workspace:*',
  '@local/docs': 'workspace:*',
  '@local/docs-native-code': 'workspace:*',
  '@local/scripts': 'workspace:*',
  '@local/tests-integration': 'workspace:*',
  '@local/tests-package-common': 'workspace:*',
  '@local/tests-perf': 'workspace:*',
  '@local/tests-perf-streaming-loopback': 'workspace:*',
  '@local/tests-sync-provider': 'workspace:*',
  '@local/tests-wa-sqlite': 'workspace:*',
} as const

/** LiveStore-only versions not provided by effect-utils base catalog. */
export const livestoreOnlyCatalog = {
  '@babel/parser': '7.29.11',
  miniflare: '5.20261023.3-beta',
  scheduler: '0.28.0',
  '@effect/atom-react': '4.1.0',
  '@vue/compiler-sfc': '3.5.44',
  vue: '3.5.44',
  'twoslash-vue': '0.3.9',
  '@vue/language-core': '3.3.14',
  '@volar/typescript': '2.4.30',
  '@shikijs/twoslash': '4.5.0',
  shiki: '4.5.0',
  '@types/react-dom': '19.3.0',
  'react-virtualized-auto-sizer': '2.0.4',
  /**
   * LiveStore republishes DevTools artifacts under the LiveStore release version.
   * The source artifact carries its own metadata for artifact lineage and protocol compatibility.
   */
  '@livestore/devtools-vite': process.env.LIVESTORE_RELEASE_VERSION ?? '0.5.0',
  /** Tanstack router sub-packages not in effect-utils catalog (react-router/react-start/router-plugin are there) */
  '@tanstack/router-core': '1.171.39',
  '@tanstack/history': '1.162.5',
  '@tanstack/router-devtools': '1.167.2',
  '@tanstack/router-devtools-core': '1.168.2',
  '@tanstack/react-router-devtools': '1.167.2',
  '@tanstack/start-plugin-core': '1.171.55',
  '@tanstack/start-server-core': '1.169.45',
  '@tanstack/start-client-core': '1.170.39',
  '@types/chrome': '0.1.4',
  '@types/web': '0.0.264',
  '@types/hast': '3.0.4',
  '@types/jasmine': '5.1.4',
  '@types/jsdom': '21.1.7',
  '@types/react-window': '1.8.8',
  '@types/wicg-file-system-access': '2023.10.6',
  '@vitest/ui': '5.0.5',
  vitest: '5.0.5',
  'solid-js': '1.9.10',
  '@solidjs/testing-library': '0.8.10',
  '@testing-library/dom': '10.4.1',
  '@testing-library/jest-dom': '6.6.3',
  '@testing-library/svelte': '5.3.1',
  '@web/dev-server': '0.4.6',
  '@web/test-runner': '0.20.0',
  '@web/test-runner-core': '0.13.4',
  'jasmine-core': '4.5.0',
  jsdom: '26.1.0',
  'web-test-runner-jasmine': '0.0.6',
  '@opentelemetry/context-zone': '2.2.0',
  '@opentelemetry/core': '2.2.0',
  '@opentelemetry/exporter-metrics-otlp-grpc': '0.208.0',
  '@opentelemetry/exporter-metrics-otlp-http': '0.208.0',
  '@opentelemetry/exporter-trace-otlp-grpc': '0.208.0',
  '@opentelemetry/exporter-trace-otlp-http': '0.208.0',
  '@opentelemetry/otlp-exporter-base': '0.208.0',
  '@opentelemetry/otlp-transformer': '0.208.0',
  graphql: '16.11.0',
  comlink: '4.4.1',
  'react-window': '2.5.1',
  'monaco-editor': '0.34.1',
  nanoid: '5.0.9',
  'pretty-bytes': '7.0.1',
  'qrcode-generator': '2.0.4',
  '@iarna/toml': '3.0.0',
  '@graphql-typed-document-node/core': '3.2.0',
  'astro-expressive-code': '0.44.3',
  'expressive-code': '0.44.3',
  'expressive-code-twoslash': '0.5.3',
  hast: '1.0.0',
  'hast-util-to-html': '9.0.4',
  '@kitschpatrol/tldraw-cli': '5.0.16',
  puppeteer: '24.43.1',
  rollup: '4.49.0',
  '@rollup/plugin-commonjs': '28.0.6',
  '@rollup/plugin-node-resolve': '16.0.1',
  '@rollup/plugin-terser': '0.4.4',
  svelte: '5.43.14',
  '@sveltejs/vite-plugin-svelte': '6.2.1',
  astro: '7.4.4',
  '@astrojs/starlight': '0.42.7',
  typedoc: '0.28.20',
  expo: nativeExpoQualificationCatalog.expo,
  'expo-application': '7.0.7',
  'expo-sqlite': nativeExpoQualificationCatalog['expo-sqlite'],
  'expo-file-system': nativeExpoQualificationCatalog['expo-file-system'],
  'expo-crypto': '58.0.7',
  'react-native': nativeExpoQualificationCatalog['react-native'],
  tsx: '4.22.3',
  wrangler: '4.156.0',
  '@cloudflare/workers-types': '5.20261030.1',
  husky: '9.1.7',
  madge: '8.0.0',
  yaml: '2.8.1',
  /**
   * Supported docs and demos use the same reviewed Vite/React toolchain as the SDK.
   * Runtime API/compiler versions with separate compatibility requirements stay
   * explicitly owned by their tooling consumer instead of being globally coerced.
   */
  '@opentelemetry/api': '1.9.0',
  '@opentelemetry/resources': '2.2.0',
  '@opentelemetry/sdk-metrics': '2.2.0',
  '@opentelemetry/sdk-trace-base': '2.2.0',
  '@opentelemetry/sdk-trace-node': '2.2.0',
  '@opentelemetry/sdk-trace-web': '2.2.0',
  '@tailwindcss/vite': '4.3.3',
  tailwindcss: '4.3.3',
  '@tanstack/react-router': '1.170.46',
  '@tanstack/react-start': '1.169.4',
  '@tanstack/router-plugin': '1.168.48',
  '@testing-library/react': '16.3.1',
  '@types/bun': '1.3.10',
  '@types/node': '25.3.3',
  '@types/react': '19.3.0',
  '@vitejs/plugin-react': '6.1.2',
  esbuild: '0.28.0',
  react: '19.3.1',
  'react-dom': '19.3.1',
  vite: '8.3.5',
} as const

const toCamelCase = (value: string) => value.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())

/** Internal refs for consumers that need path mappings to @livestore packages. */
export const createLivestoreRefs = (basePath: string) =>
  Object.fromEntries(livestoreCurrentPackageNames.map((name) => [toCamelCase(name), { path: `${basePath}/${name}` }]))
