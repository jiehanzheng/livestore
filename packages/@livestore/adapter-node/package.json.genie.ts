import {
  catalog,
  getUtilsPeerDeps,
  livestorePackageDefaults,
  packageJson,
  workspaceMember,
} from '../../../genie/repo.ts'
import commonPkg from '../common/package.json.genie.ts'
import livestorePkg from '../livestore/package.json.genie.ts'
import sqlitewasmPkg from '../sqlite-wasm/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const runtimeDeps = catalog.compose({
  workspace: workspaceMember('packages/@livestore/adapter-node'),
  dependencies: { workspace: [commonPkg, utilsPkg, sqlitewasmPkg] },
  devDependencies: { workspace: [livestorePkg], external: catalog.pick('vitest', '@types/node') },
  peerDependencies: { external: getUtilsPeerDeps() },
})

export default packageJson(
  {
    name: '@livestore/adapter-node',
    ...livestorePackageDefaults,
    exports: { '.': './src/mod.ts' },
    publishConfig: { access: 'public', exports: { '.': './dist/mod.js' } },
  },
  runtimeDeps,
)
