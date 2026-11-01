import { baseTsconfigCompilerOptions, domLib, packageTsconfigExclude, tsconfigJsonForNodeModules } from '../genie/repo.ts'

/**
 * Astro docs site tsconfig.
 * Uses bundler resolution for Astro compatibility.
 * @see https://github.com/withastro/astro/blob/main/packages/astro/tsconfigs/base.json
 */
export default tsconfigJsonForNodeModules({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    lib: [...domLib],
    types: ['astro/client', 'node'],
    outDir: './dist',
    rootDir: './src',
    resolveJsonModule: true,
    // Astro site: bundled app that emits no declarations, so it is not a valid
    // TypeScript project-reference target. `composite: false` both matches tsc's
    // requirement (referenced projects must be composite) and tells genie's
    // tsconfig-references validator to skip docs as a reference target, so
    // dependents (e.g. @local/scripts) are not required to reference it.
    composite: false,
    declaration: false,
    declarationMap: false,
    module: 'ESNext',
    moduleResolution: 'Bundler',
    target: 'ESNext',
    jsx: 'preserve',
    tsBuildInfoFile: './dist/.tsbuildinfo',
  },
  include: ['src'],
  exclude: [...packageTsconfigExclude, 'src/content/_assets/code/**/*'],
  // Astro forces ESNext onto referenced projects, invalidating SDK NodeNext test hosts.
  // This consumer checks docs and imported APIs; SDK tests and executable web/native
  // snippets retain their separate, required compiler projects.
  references: [],
})
