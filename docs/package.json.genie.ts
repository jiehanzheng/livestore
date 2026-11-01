import { livestoreContribPackageVersions } from '../genie/external.ts'
import { catalog, packageJson, workspaceMember } from '../genie/repo.ts'
import adapterCloudflarePkg from '../packages/@livestore/adapter-cloudflare/package.json.genie.ts'
import adapterNodePkg from '../packages/@livestore/adapter-node/package.json.genie.ts'
import adapterWebPkg from '../packages/@livestore/adapter-web/package.json.genie.ts'
import commonPkg from '../packages/@livestore/common/package.json.genie.ts'
import livestorePkg from '../packages/@livestore/livestore/package.json.genie.ts'
import reactPkg from '../packages/@livestore/react/package.json.genie.ts'
import syncCfPkg from '../packages/@livestore/sync-cf/package.json.genie.ts'
import utilsPkg from '../packages/@livestore/utils/package.json.genie.ts'
import localAstroTldrawPkg from '../packages/@local/astro-tldraw/package.json.genie.ts'
import localAstroTwoslashCodePkg from '../packages/@local/astro-twoslash-code/package.json.genie.ts'
import localSharedPkg from '../packages/@local/shared/package.json.genie.ts'

const runtimeDeps = catalog.compose({
  workspace: workspaceMember('docs', {
    extraMemberPaths: ['docs/src/content/_assets/code', 'docs/src/content/_assets/code/native'],
  }),
  dependencies: {
    workspace: [
      adapterCloudflarePkg,
      adapterNodePkg,
      adapterWebPkg,
      commonPkg,
      livestorePkg,
      reactPkg,
      syncCfPkg,
      utilsPkg,
      localAstroTldrawPkg,
      localAstroTwoslashCodePkg,
      localSharedPkg,
    ],
    external: {
      ...catalog.pick(
        'solid-js',
        '@astrojs/starlight',
        'astro',
        'typedoc',
        'react',
        'react-dom',
        'tailwindcss',
        '@tailwindcss/vite',
        'vite',
        '@standard-schema/spec',
      ),
      ...Object.fromEntries(
        Object.entries(livestoreContribPackageVersions).filter(
          ([name]) => name !== '@livestore/cli' && name !== '@livestore/devtools-expo',
        ),
      ),
      ...catalog.pick('@livestore/devtools-vite'),
      // TypeDoc requires TypeScript's legacy runtime API, which is absent from TypeScript 7.
      typescript: '6.0.3',
      '@astrojs/check': '0.9.12',
      '@astrojs/markdown-remark': '7.3.5',
      '@astrojs/netlify': '8.2.10',
      '@astrojs/react': '7.1.2',
      '@astrojs/starlight-tailwind': '5.0.0',
      '@mixedbread/cli': '2.3.2',
      '@mixedbread/sdk': '0.78.0',
      'astro-d2': '0.13.1',
      'astro-og-canvas': '0.13.2',
      'canvaskit-wasm': '0.42.0',
      'github-slugger': '2.0.0',
      'rehype-mermaid': '3.0.0',
      'remark-custom-header-id': '1.0.0',
      'remove-markdown': '0.6.2',
      sharp: '0.34.3',
      'starlight-auto-sidebar': '0.4.1',
      'starlight-links-validator': '0.27.0',
      'starlight-sidebar-topics': '0.9.0',
      'starlight-typedoc': '0.23.0',
      'terrastruct-d2-bin': '0.7.1',
      'typedoc-plugin-markdown': '4.8.1',
      'unist-util-visit': '5.0.0',
    },
  },
  devDependencies: {
    external: catalog.pick('@playwright/test', '@types/react', '@types/react-dom', '@types/hast', 'vitest'),
  },
  mode: 'install',
})

export default packageJson(
  {
    name: '@local/docs',
    version: '0.1.1',
    type: 'module',
    private: true,
    exports: {
      './multi-code-markdown': './src/utils/multi-code-markdown.ts',
      './sidebar': './src/data/sidebar.ts',
    },
    scripts: {
      astro: 'astro',
      check: 'astro check',
      build: 'pnpm check && astro build',
      dev: 'astro dev',
      'dev:docs:sync':
        'mxbai store sync "livestore-docs-dev" "./src/content/**/*.mdx" "./src/content/**/*.md"  --yes --strategy fast',
      'prod:docs:sync':
        'mxbai store sync "livestore-docs" "./src/content/**/*.mdx" "./src/content/**/*.md" --yes --strategy fast',
      'dev:docs:sync:dry-run':
        'mxbai store sync "livestore-docs-dev" "./src/content/**/*.mdx" "./src/content/**/*.md" --dry-run',
      preview: 'astro preview',
      start: 'astro dev',
    },
  },
  runtimeDeps,
)
