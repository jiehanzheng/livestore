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
    plugins: [effectTsgoPluginFor('packages/@livestore/sync-cf')],
    ...packageTsconfigCompilerOptions,
    target: 'es2022',
  },
  include: ['./src'],
  exclude: [...packageTsconfigExclude],
  references: [refs.common, refs.utils, refs.utilsDev, refs.commonCf],
})
