const generatedCatalogFixtureConfig = 'packages/@local/astro-twoslash-code/src/cli/test-fixtures/catalog/tsconfig.json'
export const fullSetupInput = (name: string) =>
  name.endsWith('.nix') ||
  /^(Dockerfile|compose\.yaml|\.github\/)/.test(name) ||
  /^packages\/@livestore\/wa-sqlite\/(src\/|dist\/|Makefile|build)/.test(name) ||
  // This exact canonical compiler projection is shared metadata; its generator and renderer remain excluded.
  (/^packages\/@local\/astro-(tldraw|twoslash-code)\/src\//.test(name) && name !== generatedCatalogFixtureConfig) ||
  name === 'docs/astro.config.ts'
export const shared = (name: string) =>
  /^(genie\/|pnpm-|package\.json|tsconfig\.|\.ox)/.test(name) ||
  /\/(package|tsconfig)\.json(?:\.genie\.ts)?$/.test(name)
import assert from 'node:assert/strict'

export interface SharedInputReview {
  path: string
  review: { path: string; sha256: string }
}

const record = (value: unknown): Record<string, unknown> => {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Missing shared-input review object')
  return Object.fromEntries(Object.entries(value))
}

/** Staging and final commit use the same exact shared-input authority, without widening either source scope. */
export const verifySharedInputReviews = (
  changed: readonly { path: string }[],
  tree: readonly { path: string; sha256?: string }[],
  reviews: readonly SharedInputReview[],
  readReview: (reference: SharedInputReview['review']) => unknown,
) => {
  assert(new Set(reviews.map((row) => row.path)).size === reviews.length, 'Duplicate shared-input review')
  const paths = reviews.map((row) => row.path).sort()
  const expected = changed
    .filter((row) => shared(row.path))
    .map((row) => row.path)
    .sort()
  assert(
    paths.length === expected.length && paths.every((name, index) => name === expected[index]),
    'Missing shared/direct-transitive input review',
  )
  for (const row of reviews) {
    const proof = record(readReview(row.review))
    assert(proof.contract === 'livestore-fork-shared-input-v1', 'Wrong shared-input review')
    assert(Array.isArray(proof.inputs), 'Missing shared input hashes')
    const inputs: readonly unknown[] = proof.inputs
    const current = tree.find((entry) => entry.path === row.path)
    assert(
      typeof current?.sha256 === 'string' &&
        inputs.map(record).some((input) => input.path === row.path && input.sha256 === current.sha256),
      'Stale or deleted shared input',
    )
    assert(
      proof.finiteSdkOnly === true && proof.fullSetupRetained === true,
      'Excluded owners cannot be qualified implicitly',
    )
    for (const field of ['affectedOwners', 'unqualifiedOwners']) {
      const owners = proof[field]
      assert(Array.isArray(owners), `Shared review needs ${field}`)
      assert(
        owners.every((owner: unknown) => typeof owner === 'string' && owner.length > 0),
        'Invalid shared owner limits',
      )
    }
    assert(Array.isArray(proof.affectedOwners) && proof.affectedOwners.length > 0, 'Empty shared closure review')
  }
}
