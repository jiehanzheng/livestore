import { nativeExpoQualificationCatalog } from '../../../../../../genie/external.ts'
import {
  nativeExpoCatalog as catalog,
  packageJson,
  utilsEffectPeerDeps,
  workspaceMember,
} from '../../../../../../genie/repo.ts'
import adapterExpoPkg from '../../../../../../packages/@livestore/adapter-expo/package.json.genie.ts'
import commonPkg from '../../../../../../packages/@livestore/common/package.json.genie.ts'
import livestorePkg from '../../../../../../packages/@livestore/livestore/package.json.genie.ts'
import reactPkg from '../../../../../../packages/@livestore/react/package.json.genie.ts'
import syncCfPkg from '../../../../../../packages/@livestore/sync-cf/package.json.genie.ts'
import utilsPkg from '../../../../../../packages/@livestore/utils/package.json.genie.ts'

const runtimeDeps = catalog.compose({
  workspace: workspaceMember('docs/src/content/_assets/code/native'),
  dependencies: {
    workspace: [adapterExpoPkg, commonPkg, livestorePkg, reactPkg, syncCfPkg, utilsPkg],
    external: {
      ...catalog.pick(...utilsEffectPeerDeps, 'expo-crypto'),
      ...nativeExpoQualificationCatalog,
    },
  },
  devDependencies: {
    external: catalog.pick('@types/node', '@types/react', 'typescript'),
  },
  mode: 'install',
})

export default packageJson(
  {
    name: '@local/docs-native-code',
    version: '0.0.0',
    type: 'module',
    private: true,
    scripts: { check: 'tsc --build' },
    dependenciesMeta: { '@livestore/react': { injected: true } },
  },
  runtimeDeps,
)
