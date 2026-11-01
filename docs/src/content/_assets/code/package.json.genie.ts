import { livestoreContribPackageVersions } from '../../../../../genie/external.ts'
import { catalog, packageJson, utilsEffectPeerDeps, workspaceMember } from '../../../../../genie/repo.ts'
import adapterCloudflarePkg from '../../../../../packages/@livestore/adapter-cloudflare/package.json.genie.ts'
import adapterNodePkg from '../../../../../packages/@livestore/adapter-node/package.json.genie.ts'
import adapterWebPkg from '../../../../../packages/@livestore/adapter-web/package.json.genie.ts'
import livestorePkg from '../../../../../packages/@livestore/livestore/package.json.genie.ts'
import reactPkg from '../../../../../packages/@livestore/react/package.json.genie.ts'
import sqliteWasmPkg from '../../../../../packages/@livestore/sqlite-wasm/package.json.genie.ts'
import syncCfPkg from '../../../../../packages/@livestore/sync-cf/package.json.genie.ts'
import utilsPkg from '../../../../../packages/@livestore/utils/package.json.genie.ts'

const runtimeDeps = catalog.compose({
  workspace: workspaceMember('docs/src/content/_assets/code'),
  dependencies: {
    workspace: [adapterCloudflarePkg, adapterNodePkg, adapterWebPkg, livestorePkg, reactPkg, sqliteWasmPkg, syncCfPkg, utilsPkg],
    external: {
      ...Object.fromEntries(
        Object.entries(livestoreContribPackageVersions).filter(
          ([name]) => name !== '@livestore/cli' && name !== '@livestore/devtools-expo',
        ),
      ),
      ...catalog.pick(
        ...utilsEffectPeerDeps,
        'svelte',
        '@effect/atom-react',
        '@effect/ai-openai',
        'vue',
        '@vue/compiler-sfc',
        'scheduler',
        '@cloudflare/workers-types',
        '@opentelemetry/context-zone',
        '@opentelemetry/core',
        '@opentelemetry/exporter-trace-otlp-http',
        '@opentelemetry/sdk-trace-base',
        '@opentelemetry/sdk-trace-web',
        'react',
        'react-dom',
        'solid-js',
        'vite',
        '@livestore/devtools-vite',
        '@tanstack/react-router',
      ),
      '@automerge/automerge': '3.2.0',
      '@automerge/react': '2.5.0',
      '@vitejs/plugin-vue': '6.0.10',
      'fractional-indexing': '3.2.0',
      jose: '6.1.0',
      'react-error-boundary': '6.1.1',
      'vite-plugin-vue-devtools': '8.2.1',
    },
  },
  devDependencies: {
    external: catalog.pick('@types/node', '@types/react', '@types/react-dom', 'tsx', 'esbuild', 'miniflare', 'vitest'),
  },
  gvsTypeExtensions: {
    'react-error-boundary': catalog.pick('@types/react', '@types/react-dom'),
  },
  mode: 'install',
})

export default packageJson(
  {
    name: 'docs-code-snippets',
    version: '0.0.0',
    type: 'module',
    private: true,
  },
  runtimeDeps,
)
