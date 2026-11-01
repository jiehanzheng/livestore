// @genie-bootstrap
import { tsconfigJson } from './genie/repo.ts'

// Keep the actual SDK/test project graph; references bring their own Effect diagnostics.
export default tsconfigJson({
  files: [],
  references: [
    { path: './packages/@livestore/adapter-expo' },
    { path: './packages/@livestore/adapter-node' },
    { path: './packages/@livestore/adapter-web' },
    { path: './packages/@livestore/common' },
    { path: './packages/@livestore/common-cf' },
    { path: './packages/@livestore/framework-toolkit' },
    { path: './packages/@livestore/livestore' },
    { path: './packages/@livestore/react' },
    { path: './packages/@livestore/sqlite-wasm' },
    { path: './packages/@livestore/utils' },
    { path: './packages/@livestore/utils-dev' },
    { path: './packages/@livestore/wa-sqlite' },
    { path: './packages/@livestore/webmesh' },
    { path: './packages/@livestore/adapter-cloudflare' },
    { path: './packages/@livestore/sync-cf' },
    { path: './packages/@livestore/effect-playwright' },
    { path: './tests/package-common' },
    { path: './tests/integration' },
    { path: './tests/wa-sqlite' },
  ],
})
