import {
  baseTsconfigCompilerOptions,
  effectTsgoPluginFor,
  domLib,
  packageTsconfigCompilerOptions,
  packageTsconfigExclude,
  refs,
  tsconfigJson,
} from '../../../genie/repo.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    plugins: [effectTsgoPluginFor('packages/@livestore/framework-toolkit')],
    ...packageTsconfigCompilerOptions,
    lib: [...domLib],
  },
  include: ['./src'],
  exclude: packageTsconfigExclude,
  references: [refs.common, refs.adapterWeb, refs.livestore, refs.utils, refs.utilsDev],
})
