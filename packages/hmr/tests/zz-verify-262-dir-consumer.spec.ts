/* eslint-disable */
// Closes the second half of the consumer gap: `hmr` watches a *directory*
// (`packages/hmr/src/index.ts:183`), so a delete inside it travels as `unlink`
// (file) or `unlinkDir` (subdirectory) -- neither of which the driver listens
// for (`packages/fs-node/src/index.ts:71-72`).
//
// An earlier note in this review said both consumers test only against a
// `FakeFs`. That was wrong for hmr: `tests/watch.spec.ts:275-288` already runs
// the real driver for an ordinary edit. So the *edit* path is proven; what is
// still unmeasured is the *removal* path, which is what this file adds.
//
// Nothing is stubbed: the real `@cordisjs/plugin-fs-node` is plugged in, and
// the fixture directory is real.

import { Context, Fiber } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Fs from '@cordisjs/plugin-fs-node'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Hmr from '../src/index.ts'

const testDir = dirname(fileURLToPath(import.meta.url))
const fixtureDir = resolve(testDir, '__watch262__')

const plugin = (name: string, value: string) => `
import { Context } from 'cordis'

export const name = '${name}'

export function apply(ctx: Context) {
  ctx.on('hmr-watch/${name}' as any, () => '${value}')
}
`

describe('verify 262: hmr against the real fs driver', () => {
  let ctx: Context
  let fiber: Fiber<Context> | undefined
  let reconcile: any

  beforeEach(() => {
    reconcile = vi.spyOn(Hmr.prototype, 'reconcile')
  })

  beforeAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
    mkdirSync(fixtureDir, { recursive: true })
  })

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
  })

  afterEach(async () => {
    await fiber?.dispose()
    fiber = undefined
    reconcile.mockRestore()
  })

  async function setup() {
    ctx = new Context()
    ctx.baseUrl = import.meta.url
    fiber = await ctx.plugin(Loader)
    await ctx.plugin(Fs)
    await ctx.plugin(Hmr, { watch: { enabled: true, root: ['__watch262__'], debounce: 50 } })
  }

  async function load(name: string, content: string) {
    const path = resolve(fixtureDir, name)
    writeFileSync(path, content)
    const id = await ctx.loader.create({ name: `./__watch262__/${name}` })
    await ctx.loader.store[id]!.innerFiber!.await()
    return path
  }

  const settled = () => reconcile.mock.results.length

  it('never reconciles a removed file or a removed subdirectory', async () => {
    await setup()
    const a = await load('del-a.ts', plugin('del-a', 'v1'))
    const b = await load('del-b.ts', plugin('del-b', 'v1'))
    const nested = resolve(fixtureDir, 'nested262')
    mkdirSync(nested, { recursive: true })
    writeFileSync(resolve(nested, 'inner.ts'), plugin('inner', 'v1'))

    // Non-vacuity gate: the same watch must report an ordinary edit. Without
    // this, "no reconcile on delete" could equally mean "the watch is dead".
    // Some platforms drop a single event, so the file is rewritten until one
    // lands -- the same accommodation as tests/watch.spec.ts:283-287.
    let editAttempts = 0
    let editObserved = false
    for (let i = 0; i < 60; i++) {
      editAttempts++
      writeFileSync(a, plugin('del-a', 'v2'))
      await new Promise((r) => setTimeout(r, 100))
      if (ctx.bail('hmr-watch/del-a' as any) === 'v2') { editObserved = true; break }
    }
    console.log(`VERIFY262_HMR edit_observed=${editObserved} attempts=${editAttempts}`)
    expect(editObserved, 'the edit never reached the service: the watch is dead, so the removal readings are vacuous')
      .toBe(true)

    const before = settled()

    // Reading 1: remove a watched file. Travels as `unlink`.
    rmSync(a, { force: true })
    // Reading 2: remove a subdirectory and the file inside it. Travels as
    // `unlink` then `unlinkDir`.
    rmSync(nested, { recursive: true, force: true })
    // Let several debounce windows pass: 50 ms each, so 3 s is ~60 windows.
    await new Promise((r) => setTimeout(r, 3000))

    const after = settled()
    console.log(`VERIFY262_HMR reconcile_before=${before} reconcile_after=${after} delta=${after - before}`)
    console.log('VERIFY262_HMR file_still_loaded=' + JSON.stringify(ctx.bail('hmr-watch/del-a' as any)))
    console.log('VERIFY262_HMR sibling_still_loaded=' + JSON.stringify(ctx.bail('hmr-watch/del-b' as any)))

    // The measured claim: neither removal produced a reconcile. `reconcile` is
    // the single funnel every watch callback goes through
    // (`packages/hmr/src/index.ts:161`), so counting it is counting callbacks.
    expect(after - before, 'a removal reached hmr: the delete is not lost for the directory shape')
      .toBe(0)
    // And the consequence: the deleted module is still serving its last value.
    expect(ctx.bail('hmr-watch/del-a' as any), 'the deleted module stopped answering, so something did notice')
      .toBe('v2')
    expect(ctx.bail('hmr-watch/del-b' as any), 'an untouched sibling was disturbed by the deletions')
      .toBe('v1')

    // What repairing 7a would actually buy this consumer. An `unlink` listener
    // would call `flush()`, which calls `reconcile(() => files)` with the very
    // set that contains the now-missing path -- so calling reconcile with that
    // path here prices the repair without editing the driver.
    const t0 = Date.now()
    let outcome = 'resolved'
    let settleCount: number | undefined
    let failures: number | undefined
    try {
      const result: any = await (ctx.hmr as any).reconcile(() => [a, resolve(nested, 'inner.ts')])
      settleCount = result?.settledFibers?.length
      failures = result?.importFailures?.length
    } catch (error) {
      outcome = `threw ${(error as Error)?.constructor?.name}`
    }
    console.log(`VERIFY262_HMR reconcile_on_missing=${outcome} ms=${Date.now() - t0}`)
    console.log(`VERIFY262_HMR settled=${settleCount} import_failures=${failures}`)
    console.log('VERIFY262_HMR after_repair_value=' + JSON.stringify(ctx.bail('hmr-watch/del-a' as any)))

    // The repair for this consumer is *not* blocked the way include's is:
    // reconcile on a missing file resolves, reports an import failure for the
    // gone module, and leaves the old value serving. So wiring `unlink` here
    // would surface a real failure signal rather than swallowing one -- the
    // opposite cost profile from include, where `refresh()` absorbed it.
    expect(outcome, 'reconcile now throws on a missing file instead of reporting a failure')
      .toBe('resolved')
    expect(failures, 'reconcile did not report the missing module at all, so the repair would be silent here too')
      .toBeGreaterThan(0)
  }, 120_000)
})
