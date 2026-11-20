import type {
  Element as THastElement,
  ElementContent as THastElementContent,
  Parent as THastParent,
  Properties as THastProperties,
  RootContent as THastRootContent,
} from 'hast'

import { isElementNode, extractText, toClassList } from './snippet-hast.ts'

export const collectDiagnostics = (node: THastElement): string[] => {
  const diagnostics: string[] = []

  const walk = (current: THastElementContent | THastRootContent | undefined) => {
    if (isElementNode(current) === false) return

    const element = current
    const classList = toClassList(element.properties?.className ?? element.properties?.class)
    if (classList.includes('twoslash-error-line') === true || classList.includes('twoslash-popup-error') === true) {
      const message = extractText(element).trim()
      if (message.length > 0) {
        diagnostics.push(message)
      }
    }

    if (Array.isArray(element.children) === true) {
      for (const child of element.children) {
        walk(child as THastElementContent | THastRootContent)
      }
    }
  }

  walk(node as unknown as THastElementContent)
  return diagnostics
}
