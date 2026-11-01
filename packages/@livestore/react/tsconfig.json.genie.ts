import {
  baseTsconfigCompilerOptions,
  effectTsgoPluginFor,
  domLib,
  packageTsconfigCompilerOptions,
  packageTsconfigExclude,
  reactJsx,
  refs,
  tsconfigJson,
} from '../../../genie/repo.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    plugins: [effectTsgoPluginFor('packages/@livestore/react')],
    ...packageTsconfigCompilerOptions,
    lib: domLib, // Need DOM for test files using testing-library
    ...reactJsx,
  },
  include: ['./src'],
  exclude: [...packageTsconfigExclude],
  references: [refs.common, refs.adapterWeb, refs.frameworkToolkit, refs.livestore, refs.utils, refs.utilsDev],
})
