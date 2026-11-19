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
