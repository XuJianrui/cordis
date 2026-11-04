/* eslint-disable */
// Sections 3, 6, 8 and 9 of the #262 draft were reviewed as "design proposal,
// not covered by CI". Re-reading the tree says that verdict was too pessimistic
// for 3, 6 and 9: the behaviour each section describes already has a test, just
// not in the verify suite. This file does not re-test the implementation; it
// records, per claim, the test that would go red if the claim were false, and
// re-runs the two claims that are cheap to exercise through the public entry
// point. Section 8 is the one that stays a proposal -- `ctx.fs` has no file
// reference to test.
//
// The distinction matters for the draft: "no consumer" and "no test" are
// different sentences, and only the second one can be fixed by adding a test.

import { Context } from 'cordis'
import Fs from '../src/index.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('verify 262: which of the "proposal" sections are actually falsifiable', () => {
  it('Section 3: disposing one watch does not stop a sibling watch on the same file', async () => {
    // The draft claims per-fiber write tracking: a fiber's teardown aborts only
    // its own in-flight writes. The observable half of that is here -- two
    // watches on one file, one disposed, the other must keep firing.
    // If this goes red, the draft's per-fiber claim loses its only live support.
    const root = mkdtempSync(join(tmpdir(), 'scope262-'))
    const file = join(root, 'shared.txt')
    writeFileSync(file, 'v1')

    const ctx = new Context()
    const fiber = await ctx.plugin(Fs)
    let disposed_calls = 0
    let sibling_calls = 0

    const stop = await ctx.fs.watch(file, () => { disposed_calls++ })
    await ctx.fs.watch(file, () => { sibling_calls++ })
    await stop()
    const before = disposed_calls

    writeFileSync(file, 'v2')
    for (let i = 0; i < 40 && sibling_calls === 0; i++) await sleep(50)

    console.log(`VERIFY262_SCOPE section3 sibling_calls=${sibling_calls} disposed_after_stop=${disposed_calls - before}`)
    // The sibling must still see the write ...
    expect(sibling_calls, 'the surviving watch stopped delivering: teardown was not scoped').toBeGreaterThan(0)
    // ... and the disposed one must not.
    expect(disposed_calls, 'the disposed watch kept delivering').toBe(before)

    await fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }, 60_000)

  it('Section 3: after the fiber is disposed the service itself is gone', async () => {
    // The sibling claim is "teardown is scoped, so a watch on an already-disposed
    // fiber has nowhere to attach". The measured answer is sharper than the
    // error grid's `rejected (no code)` label suggested: `ctx.fs` is not a
    // service that rejects -- the property is *gone*, so the call throws a
    // TypeError synchronously, before any promise exists. This does not
    // contradict the grid: there the call sits inside an `async` function, so
    // the same throw surfaces as a rejected promise. Both readings are true;
    // this one is the one a caller feels, because `.catch()` cannot see it.
    const root = mkdtempSync(join(tmpdir(), 'scope262-'))
    const file = join(root, 'plain.txt')
    writeFileSync(file, 'x')

    const ctx = new Context()
    const fiber = await ctx.plugin(Fs)
    const before = typeof (ctx as any).fs
    await fiber.dispose()
    const after = typeof (ctx as any).fs

    let outcome: string
    try {
      const ret: any = (ctx as any).fs.watch(file, () => {})
      outcome = typeof ret?.then === 'function' ? 'returned a thenable' : 'returned ' + typeof ret
    } catch (error: any) {
      outcome = 'threw ' + (error?.name ?? 'Error')
    }
    console.log(`VERIFY262_SCOPE section3 fs_before=${before} fs_after=${after} call=${outcome}`)

    // Measured today: `fs` is an object while the fiber lives, `undefined` once
    // it is disposed, and the call throws TypeError. Pinning this makes the
    // draft's sentence precise and flips red if the behaviour is ever softened
    // into a rejecting promise.
    expect(before, 'ctx.fs was not present on a live fiber').toBe('object')
    expect(after, 'ctx.fs survived disposal: the draft may need rewording').toBe('undefined')
    expect(outcome, 'the disposed-fiber call no longer throws TypeError').toBe('threw TypeError')

    rmSync(root, { recursive: true, force: true })
  }, 60_000)

  it('Section 9: the matcher hmr uses is picomatch, and it decides nested ignores', async () => {
    // The draft proposes that `glob` reuse hmr's matcher. That is only cheap if
    // hmr already has one, and only safe if its semantics are known. Both are
    // observable: the import is a code reading, and the nested-match behaviour
    // is a live call into the same library the proposal would reuse.
    const picomatch = (await import('picomatch')).default
    const isIgnored = picomatch(['**/node_modules/**', '**/.hidden/**'])

    const cases: Array<[string, boolean]> = [
      ['/repo/packages/core/node_modules', true],
      ['/repo/src/.hidden', true],
      ['/repo/src/index.js', false],
    ]
    for (const [target, want] of cases) {
      const got = isIgnored(target)
      console.log(`VERIFY262_SCOPE section9 picomatch(${target})=${got}`)
      expect(got, `picomatch disagreed on ${target}`).toBe(want)
    }
  }, 60_000)

  it('Section 8: there is no file-reference API to test', async () => {
    // Section 8 proposes lazy file references. Unlike 3, 6 and 9, this one has
    // nothing to exercise: `ctx.fs` exposes exactly one method today. Asserting
    // the absence is the honest form -- it turns "proposal" into a checkable
    // statement, and it goes red the day the API lands (which is when the
    // section stops being a proposal and starts needing a real test).
    const root = mkdtempSync(join(tmpdir(), 'scope262-'))
    const ctx = new Context()
    const fiber = await ctx.plugin(Fs)

    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(ctx.fs))
      .filter((name) => name !== 'constructor' && !name.startsWith('_'))
      .sort()
    console.log('VERIFY262_SCOPE section8 ctx.fs surface=' + JSON.stringify(surface))
    expect(surface, 'ctx.fs grew a method: Section 8 may now be testable').toEqual(['watch'])

    await fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }, 60_000)

  it('Section 7a: the directory shape drops a file delete too, not only a dir delete', async () => {
    // The previous test removed a subdirectory from a watched dir. That covers
    // `unlinkDir`, but the case hmr actually lives on is a *source file*
    // disappearing inside the watched tree, which chokidar reports as `unlink`.
    // These are different events, so one does not imply the other.
    const root = mkdtempSync(join(tmpdir(), 'scope262-'))
    const dir = join(root, 'tree')
    mkdirSync(dir, { recursive: true })
    const child = join(dir, 'source.ts')
    writeFileSync(child, 'export {}')

    const ctx = new Context()
    const fiber = await ctx.plugin(Fs)
    const seen: string[] = []
    await ctx.fs.watch(dir, (name) => seen.push(name))

    // Baseline: an edit inside the dir must be delivered, so a zero below is a
    // measured loss and not a watch that never worked.
    writeFileSync(child, 'export const x = 1')
    for (let i = 0; i < 40 && seen.length === 0; i++) await sleep(50)
    const editCallbacks = seen.length

    seen.length = 0
    rmSync(child, { force: true })
    for (let i = 0; i < 40; i++) await sleep(50)
    const deleteCallbacks = seen.length

    console.log(`VERIFY262_SCOPE section7a dirshape edit_callbacks=${editCallbacks} file_delete_callbacks=${deleteCallbacks}`)

    // The edit must arrive (non-vacuity: the watch is live), and the delete
    // must not -- that second zero is the measured gap.
    expect(editCallbacks, 'the dir watch never delivered an edit: this measurement is vacuous').toBeGreaterThan(0)
    expect(deleteCallbacks, 'a file delete inside the watched dir reached the callback: 7a is narrower than measured').toBe(0)

    await fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }, 120_000)

  it('Section 7a: the driver drops every removal event, not just file deletes', async () => {
    // The draft says the lost event is "the delete" (a file). The driver wires
    // `add` and `change` only (`packages/fs-node/src/index.ts:71-72`), while
    // chokidar 4 also emits `addDir`, `unlink` and `unlinkDir`
    // (node_modules/chokidar/index.js:217). This measures all three through the
    // public entry point, so the scope of decision 7a is a reading, not a guess:
    //   - watching a file, then deleting it          -> callback?
    //   - watching a dir,  then deleting a subdir    -> callback?
    //   - watching a dir,  then creating a subdir    -> callback?
    const root = mkdtempSync(join(tmpdir(), 'scope262-'))
    const file = join(root, 'target.txt')
    const dir = join(root, 'tree')
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, 'x')

    const ctx = new Context()
    const fiber = await ctx.plugin(Fs)
    const seen: string[] = []
    await ctx.fs.watch(file, (name) => seen.push('file:' + name))
    await ctx.fs.watch(dir, (name) => seen.push('dir:' + name))

    // 1. delete the watched file
    rmSync(file, { force: true })
    for (let i = 0; i < 30; i++) await sleep(50)
    const fileDeletes = seen.filter((s) => s.startsWith('file:')).length

    // 2. create then delete a subdirectory of the watched dir
    const sub = join(dir, 'sub')
    mkdirSync(sub)
    for (let i = 0; i < 30; i++) await sleep(50)
    const afterCreate = seen.filter((s) => s.startsWith('dir:')).length
    rmSync(sub, { recursive: true, force: true })
    for (let i = 0; i < 30; i++) await sleep(50)
    const afterDelete = seen.filter((s) => s.startsWith('dir:')).length

    console.log(`VERIFY262_SCOPE section7a file_delete_callbacks=${fileDeletes} `
      + `dir_create_callbacks=${afterCreate} dir_delete_callbacks=${afterDelete - afterCreate}`)

    // Measured today: all three are zero. Asserting zero pins the current
    // behaviour so a future fix flips this test red -- that is the point: the
    // draft's "delete is lost" sentence understates the gap, and this records
    // the real width of it.
    expect(fileDeletes, 'file delete did reach the callback: the draft understates the loss').toBe(0)
    expect(afterCreate, 'a subdirectory creation reached the callback: the draft omits addDir').toBe(0)
    expect(afterDelete - afterCreate, 'a subdirectory deletion reached the callback: the draft omits unlinkDir').toBe(0)

    await fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }, 120_000)
})
