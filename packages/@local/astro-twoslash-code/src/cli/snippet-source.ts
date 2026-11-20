import type { LineOwnerMetadata } from '../renderer-config.ts'

export const guessLanguage = (filename: string, fallback?: string): string => {
  const extension = filename.split('.').pop()?.toLowerCase()
  if (extension === undefined || extension.length === 0) return fallback ?? 'ts'
  if (extension === 'ts' || extension === 'cts' || extension === 'mts') return 'ts'
  if (extension === 'tsx') return 'tsx'
  if (extension === 'js' || extension === 'cjs' || extension === 'mjs') return 'js'
  if (extension === 'jsx') return 'jsx'
  if (extension === 'astro') return 'astro'
  if (extension === 'json') return 'json'
  if (extension === 'yaml' || extension === 'yml') return 'yaml'
  if (extension === 'css' || extension === 'scss') return 'css'
  if (extension === 'html') return 'html'
  if (extension === 'md' || extension === 'mdx') return 'md'
  if (extension === 'sh' || extension === 'bash') return 'bash'
  if (extension === 'vue') return 'vue'
  if (extension === 'txt') return 'plaintext'
  return extension
}

/**
 * Combines all virtual files of a bundle into a single Twoslash snippet string while
 * retaining ownership metadata for every line. Twoslash still receives a concatenated
 * snippet, but callers can later recover the focus-only section without relying on
 * heuristics from the rendered HTML.
 */

export type SnippetLine = LineOwnerMetadata & {
  content: string
}

export type AssembledSnippet = {
  code: string
  lines: SnippetLine[]
}

export const assembleSnippet = (
  files: Array<{ virtualPath: string; content: string }>,
  focusVirtualPath: string,
): AssembledSnippet => {
  const focusLines: SnippetLine[] = []
  const supportLines: SnippetLine[] = []

  const pushLines = (target: SnippetLine[], block: string, owner: string, onAfterPush?: (line: string) => void) => {
    const normalized = block.replace(/\r?\n/g, '\n')
    const parts = normalized.split('\n')
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!
      target.push({ content: part, owner, marker: null })
      onAfterPush?.(part)
    }
  }

  const appendBlankLine = (target: SnippetLine[]) => {
    target.push({ content: '', owner: null, marker: null })
  }

  for (const file of files) {
    const owner = file.virtualPath
    if (owner === focusVirtualPath) {
      const insertStartSentinel = () => {
        focusLines.push({
          content: `// __LS_FILE_START__:${owner}`,
          owner: null,
          marker: 'start',
        })
      }
      focusLines.push({
        content: `// @filename: ${owner}`,
        owner: null,
        marker: null,
      })
      insertStartSentinel()
      pushLines(focusLines, file.content, owner, (line) => {
        if (isCutMarkerLine(line) === true) {
          insertStartSentinel()
        }
      })
      focusLines.push({
        content: `// __LS_FILE_END__:${owner}`,
        owner: null,
        marker: 'end',
      })
      appendBlankLine(focusLines)
      continue
    }

    const insertSupportStartSentinel = () => {
      supportLines.push({
        content: `// __LS_FILE_START__:${owner}`,
        owner: null,
        marker: 'start',
      })
    }
    supportLines.push({
      content: `// @filename: ${owner}`,
      owner: null,
      marker: null,
    })
    insertSupportStartSentinel()
    pushLines(supportLines, file.content, owner, (line) => {
      if (isCutMarkerLine(line) === true) {
        insertSupportStartSentinel()
      }
    })
    supportLines.push({
      content: `// __LS_FILE_END__:${owner}`,
      owner: null,
      marker: 'end',
    })
    appendBlankLine(supportLines)
  }

  const lines = [...focusLines, ...supportLines]
  while (lines.length > 0 && lines[lines.length - 1]?.content === '') {
    lines.pop()
  }

  const code = lines.map((line) => line.content).join('\n')
  return {
    code: code.endsWith('\n') === true ? code : `${code}\n`,
    lines,
  }
}

type SnippetLineKind =
  | { _tag: 'filename' }
  | { _tag: 'cut' }
  | { _tag: 'start'; remainder: string }
  | { _tag: 'end'; remainder: string }
  | { _tag: 'code'; content: string }

export const classifySnippetLine = (line: string): SnippetLineKind => {
  const trimmed = line.trimStart()
  if (trimmed.startsWith('// @filename:') === true) {
    return { _tag: 'filename' }
  }
  if (trimmed.startsWith('// ---cut---') === true || trimmed.startsWith('// __LS_CUT__') === true) {
    return { _tag: 'cut' }
  }
  const startMatch = line.match(/^\s*\/\/ __LS_FILE_START__:[^\s]+\s*/)
  if (startMatch !== null) {
    return { _tag: 'start', remainder: line.slice(startMatch[0].length) }
  }
  const endMatch = line.match(/^\s*\/\/ __LS_FILE_END__:[^\s]+\s*/)
  if (endMatch !== null) {
    return { _tag: 'end', remainder: line.slice(endMatch[0].length) }
  }
  return { _tag: 'code', content: line }
}

export const isCutMarkerLine = (line: string): boolean => classifySnippetLine(line)._tag === 'cut'

export const sanitizeSnippetContent = (content: string): string =>
  content.replace(/^\s*\/\/\/\s*<reference[^\n]*\n?/g, '')
