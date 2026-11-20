import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

import { Effect } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { buildSnippets } from './snippets.ts'

it('reuses fresh artifacts in an exclusively owned synthetic project', async ({ onTestFinished }) => {
  const scratchRoot = fileURLToPath(new URL('../../../../../temp_nocommit/', import.meta.url))
  const projectRoot = fs.mkdtempSync(path.join(scratchRoot, 'snippet-cache-'))
  let completed = false
  onTestFinished(() => {
    // Failed jobs may retain uncertain FDs. Keep their fixture/evidence until
    // ownership is resolved rather than deleting solely on observed child close.
    if (completed === true) fs.rmSync(projectRoot, { recursive: true, force: true })
  })
  const assets = path.join(projectRoot, 'src/content/_assets/code')
  fs.mkdirSync(assets, { recursive: true })
  fs.mkdirSync(path.join(projectRoot, 'src/pages'), { recursive: true })
  fs.writeFileSync(path.join(assets, 'example.ts'), 'export const value = 1\n')
  fs.writeFileSync(
    path.join(assets, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ESNext', module: 'NodeNext', moduleResolution: 'NodeNext', types: [], noEmit: true },
      include: ['./*.ts'],
    }),
  )
  fs.writeFileSync(
    path.join(projectRoot, 'src/pages/guide.mdx'),
    `---\ntitle: Cache fixture\n---\nimport Code from '../content/_assets/code/example.ts?snippet'\n\n<Code />\n`,
  )
  const run = () =>
    Effect.runPromise(buildSnippets({ projectRoot }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer)))
  expect(await run()).toBeGreaterThan(0)
  expect(await run()).toBe(0)
  completed = true
})
