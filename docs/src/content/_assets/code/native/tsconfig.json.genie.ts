import { baseTsconfigCompilerOptions, domLib, reactJsx, tsconfigJson } from '../../../../../../genie/repo.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...reactJsx,
    composite: true,
    lib: [...domLib],
    rootDir: '.',
    outDir: './dist',
    tsBuildInfoFile: './dist/.tsbuildinfo',
    module: 'Preserve',
    moduleResolution: 'Bundler',
    types: ['node', 'react'],
  },
  include: ['./**/*.ts', './**/*.tsx', './**/*.d.ts'],
  exclude: ['./node_modules', './dist', '**/*.genie.ts'],
  references: [
    { path: '../../../../../../packages/@livestore/adapter-expo' },
    { path: '../../../../../../packages/@livestore/common' },
    { path: '../../../../../../packages/@livestore/livestore' },
    { path: '../../../../../../packages/@livestore/react' },
    { path: '../../../../../../packages/@livestore/sync-cf' },
    { path: '../../../../../../packages/@livestore/utils' },
  ],
})
