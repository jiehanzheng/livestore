import {
  baseTsconfigCompilerOptions,
  effectTsgoPluginFor,
  domLib,
  packageTsconfigCompilerOptions,
  packageTsconfigExclude,
  tsconfigJson,
} from '../../../genie/repo.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    plugins: [effectTsgoPluginFor('packages/@livestore/utils')],
    ...packageTsconfigCompilerOptions,
    lib: [...domLib],
  },
  include: ['./src'],
  exclude: [...packageTsconfigExclude],
  references: [],
})
