/* eslint-disable */
// Does a case-only rename actually cost a path-keyed consumer twice the work?
//
// The directory-shape reading (zz-verify-262-case-consumer.spec.ts) shows
// `set_size=2` on NTFS/APFS: the same operation arrives as two different
// spellings, which are two different Set keys. That is a *proxy*. The claim in
// the comment draft -- "two distinct keys ... which is work done twice" -- is
// about a consumer doing the work twice, and a Set has no work.
//
// So this measures the consumer itself: the real `hmr` service, the real fs
// driver, a real plugin file, and a count of how many times the plugin's fiber
// is actually reloaded across one case-only rename.
//
// `hmr` is path-keyed: it does `stashed.add(filename)` and debounces
// (`packages/hmr/src/index.ts:184-187`). On a case-insensitive filesystem the
// two spellings are two Set entries, so the debounce window sees two paths. If
// both survive debouncing, the plugin reloads twice for one rename.
//
// On a case-sensitive filesystem the same rename is a real rename of a real
// different path, and both halves are legitimate -- so the reading is recorded,
// not asserted to be 1.

import { Context, Fiber } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Fs from '@cordisjs/plugin-fs-node'
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Hmr from '../src/index.ts'

const testDir = dirname(fileURLToPath(import.meta.url))
const fixtureDir = resolve(testDir, '__watch262case__')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Bumped by the plugin body, so a reload is visible as a changed value. */
const body = (name: string, tag: string) => `
import { Context } from 'cordis'

export const name = '${name}'

export function apply(ctx: Context) {
  ctx.on('hmr-watch/${name}' as any, () => '${tag}')
}
`

describe('verify 262: what a case-only rename costs hmr', () => {
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

  it('reconciles once per distinct spelling the driver delivers', async () => {
    ctx = new Context()
    ctx.baseUrl = import.meta.url
    fiber = await ctx.plugin(Loader)
    await ctx.plugin(Fs)
    await ctx.plugin(Hmr, { watch: { enabled: true, root: ['__watch262case__'], debounce: 50 } })

    const lower = resolve(fixtureDir, 'case-a.ts')
    const upper = resolve(fixtureDir, 'CASE-A.TS')
    writeFileSync(lower, body('case-a', 'v1'))
    const id = await ctx.loader.create({ name: './__watch262case__/case-a.ts' })
    await ctx.loader.store[id]!.innerFiber!.await()

    // Which row of the table this reading belongs to is measured, not assumed.
    let caseInsensitive = false
    try {
      caseInsensitive = statSync(upper).ino === statSync(lower).ino
    } catch {
      caseInsensitive = false
    }
    console.log('VERIFY262_CASECOST case_insensitive=' + JSON.stringify(caseInsensitive))

    // Vacuity gate: an ordinary edit must reach hmr, or "0 reconciles on the
    // rename" would be indistinguishable from a dead watch.
    let alive = false
    for (let i = 0; i < 40 && !alive; i++) {
      writeFileSync(lower, body('case-a', 'v' + (10 + i)))
      await sleep(100)
      alive = ctx.bail('hmr-watch/case-a' as any) !== 'v1'
    }
    console.log('VERIFY262_CASECOST watch_alive=' + JSON.stringify(alive))
    expect(alive, 'the watch never reported an edit, so the rename reading is vacuous').toBe(true)
    // Let the edit's own reconcile settle before counting the rename.
    await sleep(1200)

    const before = reconcile.mock.results.length
    const valueBefore = ctx.bail('hmr-watch/case-a' as any)
    renameSync(lower, upper)
    await sleep(2500)
    const delta = reconcile.mock.results.length - before
    const valueAfter = ctx.bail('hmr-watch/case-a' as any)

    console.log('VERIFY262_CASECOST reconcile_delta=' + delta)
    console.log('VERIFY262_CASECOST value_before=' + JSON.stringify(valueBefore))
    console.log('VERIFY262_CASECOST value_after=' + JSON.stringify(valueAfter))
    console.log('VERIFY262_CASECOST upper_exists=' + JSON.stringify((() => {
      try { statSync(upper); return true } catch { return false }
    })()))

    // The count is the reading the draft depends on, so it is asserted in
    // BOTH directions on a case-folding filesystem:
    //   - 0 would mean the rename never became work at all;
    //   - 2 would mean the two spellings produced two rounds of work, which is
    //     exactly the draft's "work done twice" and would make it right.
    // Only 1 supports "the debounce absorbs it". Asserting just `> 0` would let
    // the 2 case pass while the sentence in the document says 1.
    //
    // On a case-sensitive filesystem the rename is a genuine different path, so
    // the two halves are legitimate separate work and no claim is made about
    // them -- the reading is logged instead. That is also why `delta=1` on
    // linux does not corroborate the debounce explanation: there is only one
    // key there, so it cannot show two keys collapsing into one flush.
    if (caseInsensitive) {
      expect(delta, 'hmr did not reconcile the case-only rename exactly once: 0 means the spellings never became work, 2 means they became two rounds')
        .toBe(1)
    } else {
      console.log('VERIFY262_CASECOST note="case-sensitive FS: delta is not evidence about debouncing, there is only one key"')
    }

    // What the reload did to the module. A rename is not a content change, so
    // the plugin should keep answering after it -- if it stopped, the cost is
    // worse than "twice the work".
    expect(valueAfter, 'the module stopped answering after the rename, which is a stronger claim than duplicate work')
      .not.toBeUndefined()
  }, 120_000)
})
