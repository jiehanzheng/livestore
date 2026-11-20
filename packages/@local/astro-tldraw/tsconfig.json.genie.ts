import {
  baseTsconfigCompilerOptions,
  effectTsgoPluginFor,
  packageTsconfigExclude,
  tsconfigJson,
} from '../../../genie/repo.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    plugins: [effectTsgoPluginFor('packages/@local/astro-tldraw')],
    composite: true,
    rootDir: '.',
    outDir: 'dist',
    tsBuildInfoFile: './dist/.tsbuildinfo',
    types: ['node'],
  },
  include: ['src'],
  exclude: [...packageTsconfigExclude],
  references: [{ path: '../../@livestore/utils' }],
})
