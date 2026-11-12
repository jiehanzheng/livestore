import { baseTsconfigCompilerOptions, packageTsconfigExclude, tsconfigJson } from '../../genie/repo.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    module: 'NodeNext',
    // The checked producer also owns the sibling fork-qualification sources.
    rootDir: '..',
    resolveJsonModule: true,
    types: ['node'],
    noEmit: true,
    declaration: false,
    declarationMap: false,
  },
  include: [
    './export-sdk.ts',
    './export-sdk.test.ts',
    './qualification-source-contract.ts',
    './stage-source-directory.ts',
    './stage-source-directory.test.ts',
    '../fork-qualification/qualification-observations.mts',
    '../fork-qualification/qualification-recipe.mts',
    '../fork-qualification/qualification-runtime.mts',
  ],
  exclude: [...packageTsconfigExclude],
  references: [{ path: '../../packages/@livestore/utils' }],
})
