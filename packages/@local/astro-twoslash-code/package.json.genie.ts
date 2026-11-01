import { catalog, effectDevDeps, localPackageDefaults, packageJson, workspaceMember } from '../../../genie/repo.ts'
import utilsPkg from '../../@livestore/utils/package.json.genie.ts'

const runtimeDeps = catalog.compose({
  workspace: workspaceMember('packages/@local/astro-twoslash-code'),
  dependencies: {
    workspace: [utilsPkg],
    external: {
      ...catalog.pick(
        '@effect/platform-node',
        'shiki',
        '@shikijs/twoslash',
        'twoslash-vue',
        '@vue/language-core',
        '@volar/typescript',
        'hast-util-to-html',
      ),
      // Twoslash requires TypeScript's legacy runtime API, which is absent from TypeScript 7.
      typescript: '6.0.3',
    },
  },
  devDependencies: {
    external: effectDevDeps('@astrojs/starlight', '@types/hast', '@types/node', 'astro', 'vitest', 'vue'),
  },
  peerDependencies: {
    external: {
      '@astrojs/starlight': '^0.42',
      astro: '^7',
    },
  },
})

export default packageJson(
  {
    name: '@local/astro-twoslash-code',
    exports: {
      '.': './src/mod.ts',
      './cli': './src/cli/snippets.ts',
      './integration': './src/integration/astro-twoslash-code.ts',
      './vite': './src/vite/vite-plugin-snippet.ts',
      './components/multi-code': './src/components/multi-code.ts',
      './components/MultiCode.astro': './src/components/MultiCode.astro',
    },
    ...localPackageDefaults,
  },
  runtimeDeps,
)
