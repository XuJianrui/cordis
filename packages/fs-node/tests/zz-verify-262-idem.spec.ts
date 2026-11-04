/* eslint-disable */
// Two unclosed claims from the draft, measured instead of argued.
//
// Claim 1 (the draft repeats it three times): "a consumer must be idempotent".
//   That requirement only has content if a single logical change can produce
//   more than one callback, and if a naive per-callback consumer would then do
//   the work twice. Neither half was ever measured -- the property suite asserts
//   only `writes > 0 => callbacks > 0`, which is the *at-least-one* guarantee and
//   says nothing about duplicates.
//
// Claim 2: the atomic-rename cell is "not single-valued across runs".
//   Also asserted, also unmeasured at the consumer level.
//
// Both are measured here against the real driver, on the shape the driver
// actually uses (a file watch is a directory watch under the hood), with a
// non-vacuous baseline: the write must be delivered at least once, or the
// duplicate count means nothing.

import { Context } from 'cordis'
import Fs from '../src/index.ts'
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('verify 262: is one logical change ever delivered more than once?', () => {
  it('measures callbacks per single write, with a cleared buffer', async () => {
    // The draft's own cleared-buffer A/B (which it reports as 1.00 per operation
    // on all three platforms) is the only arm allowed to carry a contract
    // sentence. Reproduce it here so the "idempotent" requirement rests on a
    // reading rather than on the earlier harness.
    const root = mkdtempSync(join(tmpdir(), 'idem262-'))
    const file = join(root, 'file.txt')
    writeFileSync(file, 'v0')

    const ctx = new Context()
    const fiber = await ctx.plugin(Fs)
    let calls = 0
    await ctx.fs.watch(file, () => { calls++ })
    // Let the initial scan settle so its events are not counted.
    await sleep(1200)

    const perWrite: number[] = []
    for (let i = 1; i <= 12; i++) {
      calls = 0
      writeFileSync(file, 'v' + i)
      for (let k = 0; k < 40 && calls === 0; k++) await sleep(50)
      // give a duplicate a chance to land before counting
      await sleep(400)
      perWrite.push(calls)
    }
    console.log('VERIFY262_IDEM writes=' + JSON.stringify(perWrite))

    // Non-vacuity: the watch must deliver at least once for every write.
    expect(perWrite.every((n) => n >= 1), 'a write was not delivered at all: ' + JSON.stringify(perWrite)).toBe(true)
    console.log('VERIFY262_IDEM max_per_write=' + Math.max(...perWrite))
    // The array above is a reading, not a conclusion: a reader has to compare
    // twelve numbers by eye to answer the only question this probe asks, which
    // is whether one write ever produced more than one callback. Stated as a
    // verdict so a duplicate cannot be missed by not looking hard enough.
    const writeDupes = perWrite.filter((n) => n > 1).length
    console.log('VERIFY262_IDEM write_dupes=' + writeDupes + '/' + perWrite.length)
    console.log('VERIFY262_IDEM writes_single_valued=' + (writeDupes === 0 ? 'yes' : 'no'))

    await fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }, 180_000)

  it('measures callbacks for one atomic rename-replace', async () => {
    // The draft says the rename cell "is not single-valued across runs" and uses
    // that to justify idempotence. Measure whether a rename delivers 1 or 2.
    const root = mkdtempSync(join(tmpdir(), 'idem262-'))
    const file = join(root, 'target.txt')
    writeFileSync(file, 'v0')

    const ctx = new Context()
    const fiber = await ctx.plugin(Fs)
    let calls = 0
    await ctx.fs.watch(file, () => { calls++ })
    await sleep(1200)

    const perRename: number[] = []
    for (let i = 1; i <= 8; i++) {
      calls = 0
      const tmp = join(root, '.target.tmp')
      writeFileSync(tmp, 'v' + i)
      renameSync(tmp, file)
      for (let k = 0; k < 40 && calls === 0; k++) await sleep(50)
      await sleep(400)
      perRename.push(calls)
    }
    console.log('VERIFY262_IDEM renames=' + JSON.stringify(perRename))
    expect(perRename.every((n) => n >= 1), 'a rename was not delivered at all: ' + JSON.stringify(perRename)).toBe(true)
    // Same reason as the write loop: the claim under test is that this cell is
    // *not* single-valued across runs, and that is a statement about the
    // distribution of these numbers. Printed as a verdict, together with the
    // spread, so "1 or 2" is a reading rather than an impression.
    const renameValues = [...new Set(perRename)].sort()
    console.log('VERIFY262_IDEM rename_distinct=' + JSON.stringify(renameValues))
    console.log('VERIFY262_IDEM rename_single_valued=' + (renameValues.length === 1 ? 'yes' : 'no'))
    console.log('VERIFY262_IDEM rename_dupes=' + perRename.filter((n) => n > 1).length + '/' + perRename.length)

    await fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }, 180_000)
})
