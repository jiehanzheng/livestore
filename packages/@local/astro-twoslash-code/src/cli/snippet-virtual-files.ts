import path from 'node:path'

import type { SnippetBundle } from '../vite/snippet-graph.ts'
import { extractRelativeImports } from '../vite/snippet-graph.ts'
import { sanitizeSnippetContent } from './snippet-source.ts'

const canonicalizeDisplayPath = (relativePath: string, fallback: string): string => {
  if (relativePath.length === 0) return fallback
  const normalized = path.posix.normalize(relativePath)
  if (normalized === '.' || normalized.length === 0) return fallback
  return normalized
}

const canonicalizeVirtualPath = (displayPath: string): string =>
  displayPath.startsWith('.') === true ? displayPath : `./${displayPath}`

export type TVirtualFileRecord = SnippetBundle['files'][number] & {
  virtualPath: string
  canonicalVirtualPath: string
  displayPath: string
  content: string
  canonicalContent: string
  focusContent: string
  focusTwoslashContent: string
  relativeImports: readonly {
    raw: string
    normalized: string
    canonical: string
  }[]
}

const splitImportSpecifier = (specifier: string): { pathPart: string; suffix: string } => {
  const queryIndex = specifier.indexOf('?')
  const hashIndex = specifier.indexOf('#')
  const cutIndex =
    queryIndex >= 0 && hashIndex >= 0 ? Math.min(queryIndex, hashIndex) : queryIndex >= 0 ? queryIndex : hashIndex
  if (cutIndex === -1) {
    return { pathPart: specifier, suffix: '' }
  }
  return {
    pathPart: specifier.slice(0, cutIndex),
    suffix: specifier.slice(cutIndex),
  }
}

const replaceRelativeSpecifier = (source: string, from: string, to: string): string => {
  if (from === to) {
    return source
  }

  const patterns: Array<[string, string]> = [
    [`'${from}'`, `'${to}'`],
    [`"${from}"`, `"${to}"`],
    [`\`${from}\``, `\`${to}\``],
    [`path="${from}"`, `path="${to}"`],
    [`path='${from}'`, `path='${to}'`],
  ]

  let rewritten = source
  for (const [needle, replacement] of patterns) {
    if (rewritten.includes(needle) === true) {
      rewritten = rewritten.replaceAll(needle, replacement)
    }
  }
  return rewritten
}

type Mutable<T> = {
  -readonly [P in keyof T]: Mutable<T[P]>
}

/**
 * Computes the mapping between the import specifiers a doc author wrote and the
 * canonical paths Twoslash needs to compile the bundle.
 *
 * Why: Every focus file should retain human-friendly imports (`./schema.ts`),
 * but Twoslash requires canonical locations so the entire snippet graph shares
 * a coherent module namespace. Capturing both forms lets us hand the canonical
 * variants to Twoslash for type-checking and later restore the originals for the
 * rendered output.
 */
const normalizeRelativeSpecifiers = (
  content: string,
  fileRelativePath: string,
  canonicalMap: Map<string, string>,
): { content: string; rewrites: TVirtualFileRecord['relativeImports'] } => {
  let rewritten = content
  const rewrites: Mutable<TVirtualFileRecord['relativeImports']> = []

  for (const specifier of extractRelativeImports(content)) {
    if (specifier.startsWith('./') === false && specifier.startsWith('../') === false) continue
    const { pathPart, suffix } = splitImportSpecifier(specifier)
    const fromDir = path.posix.dirname(fileRelativePath)
    const resolved = path.posix.normalize(path.posix.join(fromDir, pathPart))

    let relativeSpecifier = path.posix.relative(fromDir, resolved)
    if (relativeSpecifier.length === 0 || relativeSpecifier === '.') {
      relativeSpecifier = `./${path.posix.basename(resolved)}`
    } else if (relativeSpecifier.startsWith('./') === false && relativeSpecifier.startsWith('../') === false) {
      relativeSpecifier = `./${relativeSpecifier}`
    }

    const normalizedSpecifier = `${relativeSpecifier}${suffix}`
    rewritten = replaceRelativeSpecifier(rewritten, specifier, normalizedSpecifier)

    const canonicalVirtual = canonicalMap.get(resolved) ?? canonicalizeVirtualPath(resolved)
    const canonicalSpecifier = `${canonicalVirtual}${suffix}`
    rewrites.push({
      raw: specifier,
      normalized: normalizedSpecifier,
      canonical: canonicalSpecifier,
    })
  }

  return { content: rewritten, rewrites }
}

const applySpecifierRewrites = (
  content: string,
  rewrites: TVirtualFileRecord['relativeImports'],
  from: 'raw' | 'normalized' | 'canonical',
  to: 'raw' | 'normalized' | 'canonical',
): string => {
  let output = content

  for (const rewrite of rewrites) {
    const source = rewrite[from]
    const target = rewrite[to]
    if (source === target) {
      continue
    }
    output = replaceRelativeSpecifier(output, source, target)
  }

  return output
}

export const createVirtualFiles = (
  files: SnippetBundle['files'],
  fileOrder: readonly string[],
): TVirtualFileRecord[] => {
  const records = fileOrder.map((filename) => {
    const file = files[filename]
    if (file == null) {
      throw new Error(`createVirtualFiles: missing file record for ${filename}`)
    }
    const fallbackName = path.posix.basename(file.absolutePath) || 'index.ts'
    const displayPath = canonicalizeDisplayPath(file.relativePath, fallbackName)
    const canonicalVirtualPath = canonicalizeVirtualPath(displayPath)
    const sanitizedContent = sanitizeSnippetContent(file.content)

    return {
      ...file,
      virtualPath: canonicalVirtualPath,
      canonicalVirtualPath,
      displayPath,
      canonicalContent: sanitizedContent,
      focusContent: sanitizedContent,
      content: sanitizedContent,
    }
  })

  const canonicalMap = new Map<string, string>(
    records.map((record) => [record.relativePath, record.canonicalVirtualPath]),
  )

  return records.map((record) => {
    const { content: canonicalContent, rewrites } = normalizeRelativeSpecifiers(
      record.canonicalContent,
      record.relativePath,
      canonicalMap,
    )

    return {
      ...record,
      canonicalContent,
      content: canonicalContent,
      focusTwoslashContent: applySpecifierRewrites(record.focusContent, rewrites, 'raw', 'canonical'),
      relativeImports: rewrites,
    }
  })
}

/**
 * Builds the per-focus virtual file list passed into Twoslash.
 *
 * Why: Twoslash expects canonical import specifiers during compilation. Only the
 * focus file temporarily receives the canonicalised content (so the compiler can
 * resolve its dependencies), while supporting files stay untouched. That keeps
 * the virtual file identity stable while avoiding duplicate `// @filename`
 * blocks for the same module.
 */
export const remapVirtualPathsForFocus = (files: TVirtualFileRecord[], focusFilename: string): TVirtualFileRecord[] => {
  const normalizedFocus = path.posix.normalize(focusFilename)

  return files.map((file) => {
    const isFocus = file.relativePath === normalizedFocus

    return {
      ...file,
      virtualPath: file.canonicalVirtualPath,
      content: isFocus === true ? file.focusTwoslashContent : file.canonicalContent,
    }
  })
}

export const resolveFocusVirtualPath = (virtualFiles: TVirtualFileRecord[], focusFilename: string): string =>
  virtualFiles.find((file) => file.relativePath === focusFilename)?.virtualPath ??
  virtualFiles[0]?.virtualPath ??
  focusFilename
