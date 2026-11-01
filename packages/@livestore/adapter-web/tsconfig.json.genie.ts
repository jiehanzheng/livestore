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
    plugins: [effectTsgoPluginFor('packages/@livestore/adapter-web')],
    ...packageTsconfigCompilerOptions,
    resolveJsonModule: true,
  },
  include: ['./src'],
  exclude: [...packageTsconfigExclude],
  references: [refs.common, refs.utils, refs.sqliteWasm, refs.webmesh],
})
