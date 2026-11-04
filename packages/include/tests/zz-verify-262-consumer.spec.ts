/* eslint-disable */
// Closes the one gap REVIEW.md could only call a deduction: does `include`
// actually go stale when its watched config file disappears?
//
// The existing suite cannot answer that. Two of its three watch tests install a
// `FakeFs` (tests/watch.spec.ts:11) whose `watch()` only records the path and
// returns a no-op -- and because `include` reaches the driver through
// `ctx.inject(['fs'], ...)`, a harness that never provides a real `fs` never
// exercises the registration at all. So "the deletion is invisible to include"
// was code-shaped but unmeasured.
//
// This file runs the real `@cordisjs/plugin-fs-node` driver, subclassed only to
// record what `include` asks it to watch -- the registration itself still goes
// through the real `Fs.watch()`, so the watcher is genuine, not a stub.
//
// Three readings, beyond the staleness claim itself:
//   1. the registration happened at all -- a reading, not an inference from
//      `inject` (the previous version of this file inferred it and was wrong on
//      Node 26, where a single dropped event made the edit look unobserved);
//   2. the deletion is silent: it produces no callback and no warning;
//   3. what repairing 7a would actually buy, by calling the very method an
//      `unlink` listener would call, on a file that is already gone.

import { Context, Fiber, Message } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Fs from '@cordisjs/plugin-fs-node'
import { afterEach, describe, expect, it } from 'vitest'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import * as yaml from 'yaml'
import Include from '../src/index.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

/**
 * The real driver, plus a record of what it was asked to watch. `super.watch()`
 * does the actual work, so an entry here proves a watcher exists rather than
 * standing in for one.
 */
class RecordingFs extends Fs {
  static calls: string[] = []

  watch(path: any, callback: any, options?: any) {
    RecordingFs.calls.push(String(path))
    return super.watch(path, callback, options)
  }
}

describe('verify 262: include against the real fs driver', () => {
  let loaderFiber: Fiber<Context> | undefined
  let fsFiber: Fiber<Context> | undefined
  let filename: string

  afterEach(async () => {
    await loaderFiber?.dispose()
    loaderFiber = undefined
    await fsFiber?.dispose()
    fsFiber = undefined
    RecordingFs.calls = []
    await rm(filename, { force: true })
  })

  it('stays on the last-read config after the watched file is deleted', async () => {
    filename = fixture('zz-verify-262-delete.yml')
    const body = (value: number) => yaml.stringify([
      { id: 'a', name: './config-plugin', config: { tag: 'a', value } },
    ])
    await writeFile(filename, body(1))

    const ctx = new Context()
    const messages: Message[] = []
    ctx.logger.exporter({ export: (message) => messages.push(message) })
    const warns = () => messages.filter(m => m.type === 'warn')
    // `logger.ts:124-126` re-emits an Error's `cause`, so one warn call can
    // arrive as two messages. Counting messages would double-count a failure.
    const warnText = () => warns().map(m => m.args.map(String).join(' | '))

    // Order matters: the real driver must be present before `include` registers,
    // otherwise ctx.inject(['fs']) never fires and the watch is never created.
    fsFiber = await ctx.plugin(RecordingFs)
    loaderFiber = await ctx.plugin(Loader, { baseUrl: import.meta.url })
    const id = await ctx.loader.create({
      name: '@cordisjs/plugin-include',
      config: { path: './fixtures/zz-verify-262-delete.yml', watch: true },
    })
    await ctx.loader.store[id]!.innerFiber!.await()

    const include = () => ctx.loader.store[id]!.subtree as Include
    console.log('VERIFY262_CONSUMER registered=' + JSON.stringify(RecordingFs.calls))

    // Registration is a reading now, not an inference from `inject`.
    expect(RecordingFs.calls, 'include never asked the real driver to watch anything')
      .toContain(filename)

    // Prove the watch is live before deleting: an ordinary edit must be picked
    // up. Without this the delete reading below would be vacuous -- a watch that
    // was never registered also reports nothing on a delete.
    //
    // A single write can be dropped on some platforms, so the file is rewritten
    // until one event lands -- the same accommodation the existing suite makes
    // at tests/watch.spec.ts:97-103. This is what made the earlier version of
    // this file fail on Node 26 while passing on 22 and 24.
    let attempts = 0
    let sawEdit = false
    for (let i = 0; i < 100; i++) {
      attempts++
      await writeFile(filename, body(2))
      await sleep(100)
      if (ctx.bail('test/config', 'a')?.value === 2) { sawEdit = true; break }
    }
    console.log(`VERIFY262_CONSUMER edit_observed=${sawEdit} attempts=${attempts}`)

    // Now remove the file the service is watching.
    await rm(filename, { force: true })
    for (let i = 0; i < 30; i++) await sleep(100)

    const live = ctx.bail('test/config', 'a')
    // Reading 2: the deletion is not merely unhandled, it is silent. Nothing
    // reaches include, so nothing is even logged.
    console.log('VERIFY262_CONSUMER after_delete=' + JSON.stringify(live))
    console.log('VERIFY262_CONSUMER warn_silence=' + JSON.stringify(warnText()))

    // Non-vacuity first: a watch that never delivered the edit would make the
    // staleness reading meaningless, so assert the edit landed.
    expect(sawEdit, 'the edit never reached the service: the watch is not registered, so the delete result is vacuous')
      .toBe(true)
    // The measured claim: the value survives its file's deletion.
    expect(live?.value, 'include reacted to the delete: 7a has a consumer-visible consequence after all')
      .toBe(2)
    expect(warnText(), 'the deletion was noticed after all, at least as a warning')
      .toEqual([])

    // Reading 3: price the repair. `refresh()` is exactly what an `unlink`
    // listener would call, so calling it here on an already-gone file answers
    // "would wiring `unlink` be enough for this consumer?" without editing the
    // driver.
    const warnIndex = warns().length
    let outcome = 'resolved'
    await include().refresh().catch((error) => { outcome = `threw ${error?.constructor?.name}` })
    const treeAfterRefresh = ctx.bail('test/config', 'a')
    console.log(`VERIFY262_CONSUMER refresh_on_missing=${outcome}`)
    console.log(`VERIFY262_CONSUMER tree_after_refresh=${JSON.stringify(treeAfterRefresh)}`)
    console.log('VERIFY262_CONSUMER refresh_warns=' + JSON.stringify(warnText().slice(warnIndex)))

    // The load-bearing finding: wiring `unlink` alone would NOT repair this
    // consumer. `refresh()` swallows the read failure into a warning and returns
    // normally, leaving the stale tree in place -- so the repair would convert
    // silence into a warning, not into a reconciliation.
    expect(outcome, 'refresh() now propagates a missing file instead of swallowing it')
      .toBe('resolved')
    expect(treeAfterRefresh?.value, 'the tree reconciled itself once refresh ran on a missing file')
      .toBe(2)
    expect(warnText().length, 'refresh on a missing file said nothing, so the swallow is silent')
      .toBeGreaterThan(warnIndex)
  }, 180_000)
})
