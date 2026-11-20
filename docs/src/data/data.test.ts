import { afterEach, expect, test, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

test('an unpublished build branch cannot produce edit or template links', async () => {
  vi.stubEnv('GITHUB_BRANCH_NAME', 'private/unpublished-preview')
  vi.stubEnv('LIVESTORE_DOCS_PUBLICATION_REF', undefined)
  const data = await import('./data.ts')

  expect(data.docsSourceUrl).toBe('https://github.com/jiehanzheng/livestore')
  expect(data.docsEditLink).toBeUndefined()
  expect(data.hasPublishedTemplate('web-todomvc-sync-cf')).toBe(false)
  expect(() => data.makeTiged('web-todomvc-sync-cf', 'pnpm dlx')).toThrow('No qualified published template')
})

test('source and templates use explicit publication metadata, with native templates still unavailable', async () => {
  const ref = '0123456789abcdef0123456789abcdef01234567'
  vi.stubEnv('GITHUB_BRANCH_NAME', 'private/unpublished-preview')
  vi.stubEnv('LIVESTORE_DOCS_PUBLICATION_REF', ref)
  const data = await import('./data.ts')

  expect(data.docsSourceUrl).toBe(`https://github.com/jiehanzheng/livestore/tree/${ref}`)
  expect(data.docsEditLink).toEqual({ baseUrl: `https://github.com/jiehanzheng/livestore/edit/${ref}/docs/` })
  expect(data.makeTiged('web-todomvc-sync-cf', 'pnpm dlx')).toBe(
    `pnpm dlx tiged "github:jiehanzheng/livestore/examples/web-todomvc-sync-cf#${ref}" livestore-app`,
  )
  expect(data.hasPublishedTemplate('expo-todomvc-sync-cf')).toBe(false)
  expect(data.hasPublishedTemplate('node-todomvc-sync-cf')).toBe(false)
})
