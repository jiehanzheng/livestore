import type {
  Element as THastElement,
  ElementContent as THastElementContent,
  Parent as THastParent,
  Properties as THastProperties,
  RootContent as THastRootContent,
} from 'hast'

export const isElementNode = (node: THastElementContent | THastRootContent | undefined): node is THastElement =>
  Boolean(node && node.type === 'element')

export const extractText = (node: THastElementContent | THastRootContent | null | undefined): string => {
  if (node == null) return ''
  if (node.type === 'text') {
    return node.value ?? ''
  }
  if (node.type === 'comment') {
    return ''
  }
  if (Array.isArray((node as THastParent).children) === true) {
    return (node as THastParent).children
      .map((child) => extractText(child as THastElementContent | THastRootContent))
      .join('')
  }
  return ''
}

/**
 * Helper for walking the HAST emitted by Shiki. We only care about a
 * couple of wrapper nodes (figure/pre/code), so a shallow scan is sufficient.
 */
export const findChildByTag = (parent: THastParent | null | undefined, tagName: string): THastElement | null => {
  if (parent?.children == null) return null
  for (const child of parent.children) {
    if (isElementNode(child) === true && child.tagName === tagName) {
      return child
    }
  }
  return null
}

export const toClassList = (value: unknown): string[] => {
  if (Array.isArray(value) === true) {
    return value.flatMap((item) => toClassList(item))
  }
  if (typeof value === 'string') {
    return value.split(/\s+/).filter((item) => item.length > 0)
  }
  return []
}
