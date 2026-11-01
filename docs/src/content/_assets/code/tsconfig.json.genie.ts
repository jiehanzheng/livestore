import { baseTsconfigCompilerOptions, domLib, effectTsgoPluginFor, reactJsx, tsconfigJson } from '../../../../../genie/repo.ts'

/**
 * Docs code snippets tsconfig.
 * Used for TypeScript snippets embedded in documentation.
 * Uses noEmit since these are just for type checking/editor support.
 * Includes DOM lib since snippets may use browser APIs.
 */
export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    plugins: [effectTsgoPluginFor('docs/src/content/_assets/code')],
    lib: [...domLib],
    rootDir: './',
    ...reactJsx,
    types: ['vite/client', 'node', '@cloudflare/workers-types', '@types/react', '@types/react-dom'],
    noEmit: true,
    declaration: false,
    declarationMap: false,
  },
  include: ['./**/*.ts', './**/*.tsx', './**/*.d.ts'],
  exclude: ['./node_modules', './dist', '**/*.genie.ts', './native/**'],
  references: [
    { path: '../../../../../packages/@livestore/sqlite-wasm' },
    { path: '../../../../../packages/@livestore/adapter-node' },
    { path: './native' },
    { path: '../../../../../packages/@livestore/adapter-cloudflare' },
    { path: '../../../../../packages/@livestore/adapter-web' },
    { path: '../../../../../packages/@livestore/common' },
    { path: '../../../../../packages/@livestore/livestore' },
    { path: '../../../../../packages/@livestore/react' },
    { path: '../../../../../packages/@livestore/sync-cf' },
    { path: '../../../../../packages/@livestore/utils' },
  ],
})
