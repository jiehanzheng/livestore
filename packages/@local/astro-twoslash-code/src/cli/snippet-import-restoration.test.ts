import type { Element } from 'hast'
import { describe, expect, it } from 'vitest'

import { restoreFocusSpecifiers } from './snippet-import-restoration.ts'

const rewrites = [{ raw: './schema.ts', normalized: './schema.ts', canonical: './guide/schema.ts' }]

const fixture = (key: string): Element => ({
  type: 'element',
  tagName: 'div',
  properties: {},
  children: [
    {
      type: 'element',
      tagName: 'span',
      properties: {},
      children: [{ type: 'text', value: "import { schema } from './guide/schema.ts'" }],
    },
    {
      type: 'element',
      tagName: 'button',
      properties: { [key]: "import { schema } from './guide/schema.ts'", 'aria-label': 'Copy code' },
      children: [{ type: 'text', value: 'Copy' }],
    },
    {
      type: 'element',
      tagName: 'a',
      properties: { href: './guide/schema.ts', title: 'Definition link' },
      children: [{ type: 'text', value: 'Definition' }],
    },
  ],
})

describe('author imports in rendered and copied snippets', () => {
  it.each(['dataCode', 'data-code'])('restores the %s copy payload together with visible imports', (key) => {
    const root = fixture(key)
    restoreFocusSpecifiers(root, rewrites)
    const visible = root.children[0]
    const copy = root.children[1]
    if (visible?.type !== 'element' || copy?.type !== 'element') throw new Error('Invalid test fixture.')
    expect(visible.children).toEqual([{ type: 'text', value: "import { schema } from './schema.ts'" }])
    expect(copy.properties[key]).toBe("import { schema } from './schema.ts'")
    expect(copy.properties['aria-label']).toBe('Copy code')
  })

  it('preserves link destinations and unrelated metadata', () => {
    const root = fixture('dataCode')
    restoreFocusSpecifiers(root, rewrites)
    const link = root.children[2]
    if (link?.type !== 'element') throw new Error('Invalid test fixture.')
    expect(link.properties).toEqual({ href: './guide/schema.ts', title: 'Definition link' })
  })
})
