import { readFileSync } from 'node:fs'
import path from 'node:path'

import { compare } from './commit-files.mjs'
import { PROJECT_TEST_ROOTS, REQUIRED_CRASH_CASES } from './qualification-policy.mjs'

export const expectedSkippedCases = [
  'LeaderSyncProcessor clears databases on BackendIdMismatchError pull with reset',
  'StoreRegistry time-dependent (using TestClock) keeps the longest unusedCacheTime seen for a store when options vary across calls',
  'experimental useStore should load store with unusedCacheTime set to 0',
]

export const verifyRuntimeTests = (root, reportFile) => {
  const report = JSON.parse(readFileSync(reportFile, 'utf8'))
  const suites = report.testResults
  if (Array.isArray(suites) === false) throw new Error('Vitest JSON report lacks runtime-discovered testResults')

  const assertions = []
  const collect = (value) => {
    if (Array.isArray(value) === true) {
      for (const entry of value) collect(entry)
      return
    }
    if (value === null || typeof value !== 'object') return
    if (typeof value.fullName === 'string' && typeof value.status === 'string') assertions.push(value)
    for (const entry of Object.values(value)) collect(entry)
  }
  collect(suites)

  const passed = assertions.filter((item) => item.status === 'passed').length
  const failed = assertions.filter((item) => item.status === 'failed').length
  const skipped = assertions.filter((item) => ['pending', 'skipped', 'todo'].includes(item.status)).length
  if (passed < 904 || failed !== 0 || skipped !== 3 || suites.length < 96) {
    throw new Error(
      `Runtime Vitest report did not meet the floor (passed=${passed}, failed=${failed}, skipped=${skipped}, files=${suites.length})`,
    )
  }

  const skippedCases = assertions
    .filter((item) => ['pending', 'skipped', 'todo'].includes(item.status))
    .map((item) => item.fullName)
  const byName = (left, right) => left.localeCompare(right)
  if (JSON.stringify(skippedCases.toSorted(byName)) !== JSON.stringify(expectedSkippedCases.toSorted(byName))) {
    throw new Error('Runtime skipped cases differ from the explicitly retained pre-existing gaps')
  }

  const suiteNames = suites.map((suite) => path.resolve(suite.name ?? ''))
  for (const project of PROJECT_TEST_ROOTS) {
    if (suiteNames.some((name) => name.startsWith(`${path.join(root, project)}${path.sep}`)) === false) {
      throw new Error(`Runtime Vitest discovery omitted project ${project}`)
    }
  }

  const crashCases = REQUIRED_CRASH_CASES.map((crashCase) => {
    const matches = assertions.filter((item) => item.fullName.includes(`eventlog COMMIT ${crashCase}`))
    if (matches.length !== 1 || matches[0].status !== 'passed') {
      throw new Error(`Required real SIGKILL case was not runtime-discovered and passed: ${crashCase}`)
    }
    return { name: crashCase, status: 'passed', executed: true }
  })

  return { passed, failed, skipped, skippedCases, files: suites.length, projects: PROJECT_TEST_ROOTS, crashCases }
}

export const assertRuntimeSummary = (value) => {
  if (value.passed < 904 || value.failed !== 0 || value.skipped !== 3 || value.files < 96)
    throw new Error('Runtime floor failed')
  if (JSON.stringify([...value.skippedCases].sort(compare)) !== JSON.stringify([...expectedSkippedCases].sort(compare)))
    throw new Error('Runtime skipped cases differ')
  if (JSON.stringify(value.crashCases.map((row) => row.name)) !== JSON.stringify(REQUIRED_CRASH_CASES))
    throw new Error('Crash controls differ')
  if (value.crashCases.every((row) => row.status === 'passed' && row.executed === true) === false)
    throw new Error('Crash controls not executed')
}
