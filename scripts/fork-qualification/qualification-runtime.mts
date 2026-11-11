import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { compare } from './qualification-observations.mts'
import { PROJECT_TEST_ROOTS, REQUIRED_CRASH_CASES } from './qualification-recipe.mts'

export const expectedSkippedCases = [
  'LeaderSyncProcessor clears databases on BackendIdMismatchError pull with reset',
  'StoreRegistry time-dependent (using TestClock) keeps the longest unusedCacheTime seen for a store when options vary across calls',
  'experimental useStore should load store with unusedCacheTime set to 0',
]
export interface RuntimeSummary {
  passed: number
  failed: number
  skipped: number
  files: number
  skippedCases: readonly string[]
  crashCases: readonly { name: string; status: string; executed: boolean }[]
}
const record = (value: unknown): Record<string, unknown> => {
  assert(value !== null && typeof value === 'object' && Array.isArray(value) === false, 'Missing Vitest report object')
  return Object.fromEntries(Object.entries(value))
}
export const verifyRuntimeTests = (root: string, reportFile: string) => {
  const suites = record(JSON.parse(readFileSync(reportFile, 'utf8'))).testResults
  assert(Array.isArray(suites), 'Vitest JSON report lacks runtime-discovered testResults')
  const assertions: { fullName: string; status: string }[] = []
  const collect = (value: unknown): void => {
    if (Array.isArray(value) === true) {
      for (const entry of value) collect(entry)
      return
    }
    if (value === null || typeof value !== 'object') return
    const item = record(value)
    if (typeof item.fullName === 'string' && typeof item.status === 'string')
      assertions.push({ fullName: item.fullName, status: item.status })
    for (const entry of Object.values(item)) collect(entry)
  }
  collect(suites)
  const passed = assertions.filter((item) => item.status === 'passed').length
  const failed = assertions.filter((item) => item.status === 'failed').length
  const skipped = assertions.filter((item) => ['pending', 'skipped', 'todo'].includes(item.status)).length
  if (passed < 904 || failed !== 0 || skipped !== 3 || suites.length < 96)
    throw new Error(
      `Runtime Vitest report did not meet the floor (passed=${passed}, failed=${failed}, skipped=${skipped}, files=${suites.length})`,
    )
  const skippedCases = assertions
    .filter((item) => ['pending', 'skipped', 'todo'].includes(item.status))
    .map((item) => item.fullName)
  const byName = (left: string, right: string) => left.localeCompare(right)
  assert.equal(
    JSON.stringify(skippedCases.toSorted(byName)),
    JSON.stringify(expectedSkippedCases.toSorted(byName)),
    'Runtime skipped cases differ from the explicitly retained pre-existing gaps',
  )
  const suiteNames = suites.map((suite: unknown) => {
    const name = record(suite).name
    assert(name === undefined || typeof name === 'string', 'Invalid Vitest suite name')
    return path.resolve(name ?? '')
  })
  for (const project of PROJECT_TEST_ROOTS)
    assert(
      suiteNames.some((name) => name.startsWith(`${path.join(root, project)}${path.sep}`)),
      `Runtime Vitest discovery omitted project ${project}`,
    )
  const crashCases = REQUIRED_CRASH_CASES.map((crashCase) => {
    const matches = assertions.filter((item) => item.fullName.includes(`eventlog COMMIT ${crashCase}`))
    assert(
      matches.length === 1 && matches[0]?.status === 'passed',
      `Required real SIGKILL case was not runtime-discovered and passed: ${crashCase}`,
    )
    return { name: crashCase, status: 'passed', executed: true }
  })
  return { passed, failed, skipped, skippedCases, files: suites.length, projects: PROJECT_TEST_ROOTS, crashCases }
}
export const assertRuntimeSummary = (value: RuntimeSummary): void => {
  assert(value.passed >= 904 && value.failed === 0 && value.skipped === 3 && value.files >= 96, 'Runtime floor failed')
  assert.equal(
    JSON.stringify([...value.skippedCases].sort(compare)),
    JSON.stringify([...expectedSkippedCases].sort(compare)),
    'Runtime skipped cases differ',
  )
  assert.equal(
    JSON.stringify(value.crashCases.map((row) => row.name)),
    JSON.stringify(REQUIRED_CRASH_CASES),
    'Crash controls differ',
  )
  assert(
    value.crashCases.every((row) => row.status === 'passed' && row.executed === true),
    'Crash controls not executed',
  )
}
