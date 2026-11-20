import path from 'node:path'

import type {
  Element as THastElement,
  ElementContent as THastElementContent,
  Parent as THastParent,
  Properties as THastProperties,
  RootContent as THastRootContent,
} from 'hast'

import type { LineOwnerMarker } from '../renderer-config.ts'
import { isElementNode, extractText, findChildByTag, toClassList } from './snippet-hast.ts'
import type { AssembledSnippet } from './snippet-source.ts'
import { classifySnippetLine, isCutMarkerLine } from './snippet-source.ts'

const normalizeSnippetPath = (value: string): string => {
  const trimmed = value.trim()
  if (trimmed.length === 0) return trimmed
  const normalized = path.posix.normalize(trimmed)
  if (normalized.startsWith('./') === true || normalized.startsWith('../') === true) {
    return normalized
  }
  return `./${normalized}`
}

const stripSnippetSentinels = (value: string): string => {
  const normalised = value.replace(/\u007f/g, '\n')
  const cleanedLines: string[] = []

  /**
   * Preserve author-formatted blank lines while removing Twoslash sentinels that leak into the markup.
   * Sentinel-only rows are dropped entirely so they don't introduce synthetic whitespace artifacts.
   */
  for (const line of normalised.split(/\r?\n/)) {
    const classified = classifySnippetLine(line)
    if (classified._tag === 'filename' || classified._tag === 'cut') {
      continue
    }
    if (classified._tag === 'start' || classified._tag === 'end') {
      if (classified.remainder.trim().length === 0) {
        continue
      }
      cleanedLines.push(classified.remainder)
      continue
    }
    cleanedLines.push(classified.content)
  }

  // Remove trailing whitespace-only rows while keeping interior blank lines intact.
  let end = cleanedLines.length
  while (end > 0 && cleanedLines[end - 1]?.trim().length === 0) {
    end -= 1
  }

  return cleanedLines.slice(0, end).join('\n')
}

export const stripSentinelsFromDataCodeAttributes = (html: string): string =>
  html.replace(/(data-code=")([^"]*)("|$)/g, (_match, prefix, value, suffix) => {
    const cleaned = stripSnippetSentinels(value)
    const restored = cleaned.replace(/\n/g, '\u007f')
    return `${prefix}${restored}${suffix}`
  })

export const extractCanonicalOwner = (raw: string | null | undefined): string | null => {
  if (typeof raw !== 'string') return null
  const [token] = raw.trim().split(/\s+/, 1)
  if (token == null) return null
  return normalizeSnippetPath(token)
}

type LineOwnershipAttributes = {
  wrapper: THastElement | null
  owner: string | null
  marker: LineOwnerMarker | null
}

const isSentinelText = (text: string): boolean => {
  if (text.includes('__LS_FILE_START__') === true || text.includes('__LS_FILE_END__') === true) {
    return true
  }
  const classified = classifySnippetLine(text)
  return classified._tag === 'filename' || classified._tag === 'cut'
}

const removeSentinelNodes = (current: THastElementContent | THastRootContent | null | undefined): void => {
  if (current == null) return
  if (current.type === 'text') {
    if (isSentinelText(current.value ?? '') === true) {
      current.value = ''
    }
    return
  }
  if (isElementNode(current) === false) return

  const element = current as THastElement & THastParent
  if (Array.isArray(element.children) === false) return

  const retained: Array<THastElementContent> = []
  for (const child of element.children) {
    if (isElementNode(child) === true) {
      if (isSentinelText(extractText(child)) === true) {
        continue
      }
      removeSentinelNodes(child as THastElementContent)
      retained.push(child as THastElementContent)
      continue
    }
    if (child.type === 'text' && isSentinelText(child.value ?? '') === true) {
      continue
    }
    removeSentinelNodes(child as THastElementContent)
    retained.push(child as THastElementContent)
  }
  element.children = retained
}

const extractLineOwnershipAttributes = (line: THastElement): LineOwnershipAttributes => {
  const properties = (line.properties ?? {}) as Record<string, unknown>
  const ownerRaw = typeof properties['data-ls-owner'] === 'string' ? properties['data-ls-owner'].trim() : null
  const markerRaw = typeof properties['data-ls-marker'] === 'string' ? properties['data-ls-marker'].trim() : null
  const marker = markerRaw === 'start' || markerRaw === 'end' ? (markerRaw as LineOwnerMarker) : null
  const owner = ownerRaw != null && ownerRaw.length > 0 ? ownerRaw : null
  if (owner !== null || marker !== null || ownerRaw === '') {
    return { wrapper: line, owner, marker }
  }

  if (Array.isArray((line as THastParent).children) === false) {
    return { wrapper: null, owner: null, marker: null }
  }

  for (const child of (line as THastParent).children) {
    if (isElementNode(child) === false) {
      continue
    }
    const element = child
    const childProps = (element.properties ?? {}) as Record<string, unknown>
    const childOwnerRaw = typeof childProps['data-ls-owner'] === 'string' ? childProps['data-ls-owner'].trim() : null
    const childMarkerRaw = typeof childProps['data-ls-marker'] === 'string' ? childProps['data-ls-marker'].trim() : null
    const childMarker =
      childMarkerRaw === 'start' || childMarkerRaw === 'end' ? (childMarkerRaw as LineOwnerMarker) : null
    const childOwner = childOwnerRaw != null && childOwnerRaw.length > 0 ? childOwnerRaw : null
    if (childOwner !== null || childMarker !== null || childOwnerRaw === '') {
      return { wrapper: element, owner: childOwner, marker: childMarker }
    }
  }

  return { wrapper: line, owner: null, marker: null }
}

export const trimRenderedAst = (
  root: THastElement,
  focusVirtualPath: string,
  assembled: AssembledSnippet,
): THastElement => {
  const figure = findChildByTag(root as THastParent, 'figure')
  const pre = findChildByTag(figure, 'pre')
  const code = findChildByTag(pre, 'code')
  if (code == null || Array.isArray(code.children) === false) return root

  const canonicalFocus = extractCanonicalOwner(focusVirtualPath)
  if (canonicalFocus === null) {
    return root
  }

  const filtered: THastElement[] = []

  for (const child of code.children) {
    if (isElementNode(child) === false) {
      continue
    }
    if (child.tagName !== 'div') {
      continue
    }

    const lineElement = child
    const { wrapper, owner, marker } = extractLineOwnershipAttributes(lineElement)

    if (marker !== null) {
      continue
    }

    if (owner === null) {
      continue
    }

    const canonicalOwner = extractCanonicalOwner(owner)
    if (canonicalOwner === null || canonicalOwner !== canonicalFocus) {
      continue
    }

    const textContent = extractText(lineElement)
    const trimmedText = textContent.trim()
    if (trimmedText.startsWith('// @filename:') === true) {
      continue
    }
    if (isCutMarkerLine(trimmedText) === true) {
      continue
    }

    if (wrapper !== null) {
      const wrapperProperties = (wrapper.properties ?? {}) as Record<string, unknown>
      delete wrapperProperties['data-ls-owner']
      delete wrapperProperties['data-ls-marker']
      if (Object.keys(wrapperProperties).length === 0) {
        wrapper.properties = {} as THastProperties
      } else {
        wrapper.properties = wrapperProperties as THastProperties
      }
    }

    filtered.push(lineElement)
  }

  while (filtered.length > 0) {
    const last = filtered[filtered.length - 1]!
    if (extractText(last as THastElementContent).trim().length === 0) {
      filtered.pop()
      continue
    }
    break
  }

  if (filtered.length === 0) {
    return root
  }

  // Remove sentinel nodes from each filtered line before updating code.children
  for (const line of filtered) {
    removeSentinelNodes(line as THastElementContent)
  }

  code.children = filtered

  const figcaption = findChildByTag(figure, 'figcaption')
  if (figure !== null && Array.isArray((figure as THastParent).children) === true && figcaption !== null) {
    ;(figure as THastParent).children = (figure as THastParent).children.filter((child) => child !== figcaption)
  }

  const copyElement =
    figure !== null && Array.isArray((figure as THastParent).children) === true
      ? (figure as THastParent).children.find((child) => {
          if (isElementNode(child) === false) return false
          if (child.tagName !== 'div') return false
          return toClassList(child.properties?.className).includes('copy')
        })
      : null

  if (
    copyElement !== null &&
    isElementNode(copyElement) === true &&
    Array.isArray((copyElement as THastParent).children) === true
  ) {
    for (const node of (copyElement as THastParent).children) {
      if (isElementNode(node) === false) continue
      if (node.tagName !== 'button') continue
      const properties = node.properties ?? {}
      const trimmedSource = assembled.lines
        .filter((line) => {
          if (line.owner === null) return false
          const canonicalOwner = extractCanonicalOwner(line.owner)
          if (canonicalOwner === null || canonicalOwner !== canonicalFocus) {
            return false
          }
          const trimmed = line.content.trimStart()
          if (isCutMarkerLine(trimmed) === true) {
            return false
          }
          return true
        })
        .map((line) => line.content)
        .join('\n')
      const sanitizedDataCode = stripSnippetSentinels(trimmedSource)
      delete properties['data-code']
      properties.dataCode = sanitizedDataCode
    }
  }

  if (figure !== null && Array.isArray((figure as THastParent).children) === true) {
    const retainedChildren: Array<THastElementContent> = []

    // Sentinel nodes were already cleaned from individual lines before setting code.children
    // So we can safely add the pre element without further cleaning
    if (pre !== null) {
      retainedChildren.push(pre as unknown as THastElementContent)
    }
    if (copyElement !== null && isElementNode(copyElement) === true) {
      removeSentinelNodes(copyElement as unknown as THastElementContent)
      retainedChildren.push(copyElement as THastElementContent)
    }
    ;(figure as THastParent).children = retainedChildren
  }

  return root
}
