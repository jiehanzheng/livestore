import { effectV4Catalog, livestoreOnlyCatalog } from './genie/external.ts'
// @genie-bootstrap
import {
  commonPnpmPolicySettings,
  forkCompilerMinimumReleaseAgeExclude,
  pnpmWorkspaceYaml,
  repoPnpmAllowBuilds,
  repoPackageExtensions,
} from './genie/repo.ts'
import { rootWorkspacePackages } from './package.json.genie.ts'

// The exact reviewed registry family is shared by all supported owners.
// pnpm removes exact entries already covered by a package-wide inherited rule.
// Emit the same canonical policy so a frozen install does not rewrite it.
const inheritedAgeExclusions = new Set<string>(commonPnpmPolicySettings.minimumReleaseAgeExclude)
const effectV4MinimumReleaseAgeExclude = Object.entries(effectV4Catalog)
  .filter(([name]) => inheritedAgeExclusions.has(name) === false)
  .map(([name, version]) => `${name}@${version}`)

// The supported CF runtime was reviewed as one exact official release cohort, including its recent beta runtime.
const hostMinimumReleaseAgeExclude = (['miniflare', 'wrangler', '@cloudflare/workers-types'] as const).map(
  (name) => `${name}@${livestoreOnlyCatalog[name]}`,
)

// Reviewed with Volar 2.4.30 and the owned TS 6 compiler host; keep this exception version-specific.
const docsMinimumReleaseAgeExclude = ['@vue/language-core@3.3.14']

const examplesWorkspaceSettings = {
  // Published integrations must consume this workspace's matching SDK even through transitive dependencies.
  // pnpm's ordinary deep linking retains declared semver checks; it does not override upstream peers.
  linkWorkspacePackages: 'deep' as const,
}

export { repoPackageExtensions } from './genie/repo.ts'

export default pnpmWorkspaceYaml.root({
  packages: rootWorkspacePackages,
  repoName: 'livestore',
  extraMembers: ['examples/*'],
  ...commonPnpmPolicySettings,
  /**
   * LiveStore's live CI/dev workspace typechecks package source and generated
   * dist outputs together. pnpm's injected workspace snapshots are still used
   * by Nix/FOD package preparation, but enabling them for the live workspace
   * makes TypeScript see duplicate package identities across injected and
   * source workspace views.
   */
  injectWorkspacePackages: false,
  allowBuilds: repoPnpmAllowBuilds,
  packageExtensions: repoPackageExtensions,
  minimumReleaseAgeExclude: [
    ...commonPnpmPolicySettings.minimumReleaseAgeExclude,
    ...effectV4MinimumReleaseAgeExclude,
    ...hostMinimumReleaseAgeExclude,
    ...docsMinimumReleaseAgeExclude,
    ...forkCompilerMinimumReleaseAgeExclude,
  ],
  // Supported owners must declare mutually compatible peers during normal installs.
  strictPeerDependencies: true,
  ...examplesWorkspaceSettings,
})
