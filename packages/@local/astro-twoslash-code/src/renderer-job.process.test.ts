import { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { resolveProjectPaths } from './project-paths.ts'
import { startRendererJob } from './renderer-job.ts'
import type { RendererJob } from './renderer-protocol.ts'
import { assertTestFilesRemovable } from './renderer-test-ownership.ts'

const projectRoot = fileURLToPath(new URL('../example', import.meta.url))
const paths = resolveProjectPaths(projectRoot)
const job = (code: string): RendererJob => ({
  projectRoot,
  ownerRoot: paths.snippetAssetsRoot,
  runtime: {},
  mode: 'render',
  inputs: [{ code, language: 'ts', lineOwners: [{ owner: './test.ts', marker: null }] }],
})

const cleanup = async (running: ReturnType<typeof startRendererJob>) => {
  running.cancel()
  await running.joined
  assertTestFilesRemovable(running.evidence.ownerRoot, running.output, running.scratch)
  fs.rmSync(running.directory, { recursive: true, force: true })
  fs.rmSync(`${running.directory}.failure.json`, { force: true })
  fs.rmSync(`${running.directory}.failure.json.result.json`, { force: true })
}

describe('finite renderer ownership', () => {
  it('joins a successful child and removes its protocol files', async ({ onTestFinished }) => {
    const running = startRendererJob(job('const count = 1'))
    onTestFinished(() => cleanup(running))
    const child = running.handle
    if (!(child instanceof ChildProcess)) throw new Error('Expected the actual owned ChildProcess.')
    await running.started
    expect(child.pid).toBeTypeOf('number')
    expect(child.pid).toBeGreaterThan(0)
    expect(running.pid).toBe(child.pid)
    expect(child.spawnargs).toContain(fileURLToPath(new URL('./renderer-child.ts', import.meta.url)))
    expect(child.spawnargs).toContain(path.join(running.directory, 'request.json'))
    expect(await running.result).toHaveLength(1)
    await running.joined
    expect(running.handle).toBe(child)
    expect(running.pid).toBe(child.pid)
    expect(child.exitCode).toBe(0)
    expect(child.signalCode).toBeNull()
    expect(running.output.closed).toBe(true)
    expect(running.scratch.state).toBe('removed')
    expect(running.evidence).toMatchObject({
      status: 'closed',
      close: { code: 0, signal: null },
      cancellation: null,
      outputValidated: true,
      cleanupSucceeded: true,
    })
    expect(fs.existsSync(running.directory)).toBe(false)
  })

  it('retains the primary compilation error and joined close evidence', async ({ onTestFinished }) => {
    const running = startRendererJob(job('const count: string = 1'))
    onTestFinished(() => cleanup(running))
    await expect(running.result).rejects.toThrow(/not assignable/)
    await running.joined
    const close = JSON.parse(fs.readFileSync(`${running.directory}.failure.json`, 'utf8'))
    expect(close).toMatchObject({ close: { code: 1, signal: null }, status: 'closed', cancellation: null })
    expect(fs.readFileSync(path.join(running.directory, 'result.json'), 'utf8')).toContain('not assignable')
  })

  it('joins a live child on cancellation', async ({ onTestFinished }) => {
    const running = startRendererJob(job('const count = 1'))
    onTestFinished(() => cleanup(running))
    await running.started
    running.cancel()
    await expect(running.result).rejects.toThrow(/Renderer job failed/)
    await running.joined
    expect(JSON.parse(fs.readFileSync(`${running.directory}.failure.json`, 'utf8'))).toMatchObject({
      status: 'closed',
      cancellation: 'cancelled',
    })
  })

  it('reports a positively observed SIGKILL close without a result as failure', async ({ onTestFinished }) => {
    const running = startRendererJob(job('const count = 1'))
    onTestFinished(() => cleanup(running))
    await running.started
    if (running.pid === undefined) throw new Error('Child started without an owner PID.')
    process.kill(running.pid, 'SIGKILL')
    await expect(running.result).rejects.toThrow(/closed without a result/)
    await running.joined
    expect(JSON.parse(fs.readFileSync(`${running.directory}.failure.json`, 'utf8'))).toMatchObject({
      status: 'closed',
      close: { code: null, signal: 'SIGKILL' },
      cancellation: null,
    })
  })

  it('rejects a different owner before starting a process', () => {
    expect(() => startRendererJob({ ...job('const count = 1'), ownerRoot: projectRoot })).toThrow(
      /actual snippet workspace/,
    )
  })
})
