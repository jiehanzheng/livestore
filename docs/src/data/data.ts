import { execFileSync } from 'node:child_process'

import { liveStoreVersion } from '@livestore/common'
import { isNonEmptyString } from '@livestore/utils'

export const officeHours = [
  'https://www.youtube.com/embed/X2Ia7vc-190', // 4
  'https://www.youtube.com/embed/_VDSqi3k-gE', // 3
  'https://www.youtube.com/embed/MenhU6n0r5c', // 2
  'https://www.youtube.com/embed/2GYKgI1GU8k', // 1
]

export const getBranchName = () => {
  for (const value of [process.env.GITHUB_BRANCH_NAME, process.env.GITHUB_HEAD_REF, process.env.GITHUB_REF_NAME]) {
    if (isNonEmptyString(value) === true) return value
  }

  try {
    const branchName = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim()
    if (isNonEmptyString(branchName) === true) return branchName
  } catch {}

  throw new Error(
    'Unable to determine the documentation branch. Set GITHUB_BRANCH_NAME, GITHUB_HEAD_REF, or GITHUB_REF_NAME.',
  )
}

export const versionNpmSuffix = liveStoreVersion.includes('dev') === true ? `@${liveStoreVersion}` : ''

export const IS_MAIN_BRANCH = getBranchName() === 'main'

export const docsRepository = 'jiehanzheng/livestore'
// A preview's build branch does not establish a published source or template.
export const docsPublicationRef = process.env.LIVESTORE_DOCS_PUBLICATION_REF || undefined
const repositoryUrl = `https://github.com/${docsRepository}`
export const docsSourceUrl =
  docsPublicationRef !== undefined ? `${repositoryUrl}/tree/${docsPublicationRef}` : repositoryUrl
export const docsEditLink =
  docsPublicationRef !== undefined ? { baseUrl: `${repositoryUrl}/edit/${docsPublicationRef}/docs/` } : undefined

const maintainedTemplates = new Set([
  'cloudflare-todomvc',
  'tutorial-starter',
  'web-email-client',
  'web-linearlite',
  'web-todomvc',
  'web-todomvc-script',
  'web-todomvc-sync-cf',
])

export const hasPublishedTemplate = (example: string) =>
  docsPublicationRef !== undefined && maintainedTemplates.has(example)

export const makeTiged = (example: string, approach: 'bunx' | 'pnpm dlx' | 'npx' | 'yarn dlx') => {
  if (hasPublishedTemplate(example) === false) throw new Error(`No qualified published template: ${example}`)
  // The quotes around the github URI are necessary for certain shells (e.g. zsh) to parse correctly
  return `${approach} tiged "github:${docsRepository}/examples/${example}#${docsPublicationRef}" livestore-app`
}
