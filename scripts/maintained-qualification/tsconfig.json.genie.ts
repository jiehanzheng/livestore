import {
  baseTsconfigCompilerOptions,
  effectTsgoPluginFor,
  packageTsconfigExclude,
  tsconfigJson,
} from '../../genie/repo.ts'

// The maintained docs commands own this program; the monolithic CLI also admits
// release/infrastructure/provider owners outside the approved finite workflow.
export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    plugins: [effectTsgoPluginFor('scripts/maintained-qualification')],
    rootDir: '../..',
    noEmit: true,
    declaration: false,
    declarationMap: false,
  },
  files: ['../src/commands/docs.ts', '../src/commands/docs-export.ts'],
  include: [],
  exclude: [...packageTsconfigExclude],
  references: [
    { path: '../../packages/@livestore/utils' },
    { path: '../../packages/@livestore/utils-dev' },
    { path: '../../packages/@local/shared' },
    { path: '../../packages/@local/astro-tldraw' },
    { path: '../../packages/@local/astro-twoslash-code' },
  ],
})
