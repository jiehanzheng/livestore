import type { Element, ElementContent, RootContent } from 'hast'

import type { TVirtualFileRecord } from './snippet-virtual-files.ts'

/**
 * Canonical paths belong to compilation. Restore author paths in both visible
 * source and copy metadata, while preserving destinations of documentation links.
 */
export const restoreFocusSpecifiers = (root: Element, rewrites: TVirtualFileRecord['relativeImports']): Element => {
  const replacements = rewrites.filter((rewrite) => rewrite.canonical !== rewrite.raw)
  if (replacements.length === 0) return root

  const restore = (value: string): string => {
    let current = value
    for (const rewrite of replacements) current = current.split(rewrite.canonical).join(rewrite.raw)
    return current
  }
  const walk = (node: ElementContent | RootContent): void => {
    if (node.type === 'text') {
      node.value = restore(node.value)
      return
    }
    if (node.type !== 'element') return
    for (const key of ['dataCode', 'data-code']) {
      const value = node.properties[key]
      if (typeof value === 'string') node.properties[key] = restore(value)
    }
    for (const child of node.children) walk(child)
  }
  walk(root)
  return root
}

export const sanitizeRenderedHtml = (html: string): string =>
  html.replace(/<figcaption[^>]*>[\s\S]*?<\/figcaption>/g, '')
