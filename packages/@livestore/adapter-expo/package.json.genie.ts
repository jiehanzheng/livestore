import {
  nativeExpoCatalog,
  getUtilsPeerDeps,
  livestorePackageDefaults,
  packageJson,
  workspaceMember,
} from '../../../genie/repo.ts'
import commonPkg from '../common/package.json.genie.ts'
import livestorePkg from '../livestore/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const runtimeDeps = nativeExpoCatalog.compose({
  workspace: workspaceMember('packages/@livestore/adapter-expo'),
  dependencies: { workspace: [commonPkg, utilsPkg] },
  devDependencies: {
    workspace: [livestorePkg],
    external: nativeExpoCatalog.pick(
      'vitest',
      'expo-sqlite',
      'expo-file-system',
      'expo',
      'react-native',
      'react',
      'react-dom',
    ),
  },
  peerDependencies: {
    external: { ...getUtilsPeerDeps(), ...nativeExpoCatalog.peers('expo-sqlite', 'expo-file-system') },
  },
})

export default packageJson(
  {
    name: '@livestore/adapter-expo',
    ...livestorePackageDefaults,
    exports: { '.': './src/mod.ts' },
    publishConfig: { access: 'public', exports: { '.': './dist/mod.js' } },
  },
  runtimeDeps,
)
