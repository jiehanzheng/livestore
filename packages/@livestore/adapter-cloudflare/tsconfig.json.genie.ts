import {
  baseTsconfigCompilerOptions,
  effectTsgoPluginFor,
  packageTsconfigCompilerOptions,
  packageTsconfigExclude,
  refs,
  tsconfigJson,
} from '../../../genie/repo.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    plugins: [effectTsgoPluginFor('packages/@livestore/adapter-cloudflare')],
    ...packageTsconfigCompilerOptions,
    resolveJsonModule: true,
    types: ['@cloudflare/workers-types'],
  },
  include: ['./src'],
  exclude: [...packageTsconfigExclude],
  references: [refs.common, refs.utils, refs.livestore, refs.sqliteWasm, refs.syncCf, refs.commonCf],
})
