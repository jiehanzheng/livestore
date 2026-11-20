import {
  baseTsconfigCompilerOptions,
  effectTsgoPluginFor,
  domLib,
  packageTsconfigExclude,
  tsconfigJson,
} from '../../../genie/repo.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    plugins: [effectTsgoPluginFor('packages/@local/astro-twoslash-code')],
    lib: [...domLib],
    composite: true,
    rootDir: '.',
    outDir: './dist',
    types: ['node', 'astro'],
  },
  include: ['src', 'tests', 'examples'],
  exclude: [...packageTsconfigExclude, 'dist', 'src/cli/test-fixtures'],
  references: [{ path: '../../@livestore/utils' }],
})
