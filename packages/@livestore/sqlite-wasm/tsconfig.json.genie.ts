import {
  baseTsconfigCompilerOptions,
  effectTsgoPluginFor,
  packageTsconfigCompilerOptions,
  packageTsconfigExclude,
  refs,
  tsconfigJson,
} from '../../../genie/repo.ts'

/**
 * sqlite-wasm needs allowJs because it extends classes from @rhashimoto/wa-sqlite
 * which are JavaScript modules without type declarations.
 */
export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    plugins: [effectTsgoPluginFor('packages/@livestore/sqlite-wasm')],
    ...packageTsconfigCompilerOptions,
    allowJs: true,
  },
  include: ['./src'],
  exclude: [...packageTsconfigExclude],
  references: [refs.common, refs.utils, refs.commonCf, refs.waSqlite],
})
