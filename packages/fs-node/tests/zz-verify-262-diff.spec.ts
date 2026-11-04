/* eslint-disable */
// Cross-backend differential check for two claims the comment makes.
//
// Claim 1 (decision 7a): a pure delete never reaches the driver callback.
//   Reference arms are expected to see it, so a zero in the driver column is
//   only meaningful next to a non-zero in a reference column. If every arm
//   reported zero, the zero would say nothing about the driver.
//
// Claim 2 (section 7, rename survival): an atomic rename-replace is delivered
//   by every arm, including a watch registered on the file itself, because
//   "chokidar's file-level watch already watches the parent internally".
//   That is a claim about chokidar's internals, so it is checked against
//   chokidar directly rather than against our own driver.
//
// Each arm gets a fresh directory and a fresh watcher, and the event buffer is
// cleared after the watcher settles and before the operation is performed -
// the same discipline the A/B run established (an uncleared buffer counts the
// registration-time event and inflates the ratio).

import { Context } from 'cordis'
import chokidar from 'chokidar'
import { watch as rawWatch } from 'node:fs'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import Fs from '../src/index.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SEEDS = Number(process.env.VERIFY262_DIFF_SEEDS || 3)

type Arm = 'driver' | 'chokidar-file' | 'chokidar-parent' | 'raw-fs-watch'

interface Reading {
  arm: Arm
  shape: 'file' | 'dir'
  op: 'rename' | 'delete'
  counts: number[]
}

const readings: Reading[] = []

function record(arm: Arm, shape: 'file' | 'dir', op: 'rename' | 'delete', counts: number[]) {
  readings.push({ arm, shape, op, counts })
}

async function withWatch(
  arm: Arm,
  target: string,
  fn: (events: string[]) => Promise<void>,
): Promise<number> {
  const events: string[] = []
  const push = (p: string) => events.push(String(p))

  if (arm === 'driver') {
    const ctx = new Context()
    const fiber = await ctx.plugin(Fs)
    const stop = await ctx.fs.watch(target, push)
    await sleep(350)
    events.length = 0
    await fn(events)
    await sleep(250)
    const n = events.length
    await stop()
    await fiber.dispose()
    return n
  }

  if (arm === 'raw-fs-watch') {
    // Raw fs.watch on a file is not supported everywhere; a throw here is a
    // reading, not a skip.
    let w: any
    try {
      w = rawWatch(target, () => push(target))
    } catch (e) {
      return -1
    }
    await sleep(350)
    events.length = 0
    await fn(events)
    await sleep(250)
    const n = events.length
    w.close()
    return n
  }

  const fileShape = arm === 'chokidar-file'
  const w = chokidar.watch(target, {
    ignoreInitial: true,
    depth: fileShape ? 0 : undefined,
  })
  w.on('all', (_e, p) => push(String(p)))
  await new Promise<void>((res) => w.once('ready', () => res()))
  await sleep(350)
  events.length = 0
  await fn(events)
  await sleep(250)
  const n = events.length
  await w.close()
  return n
}

async function runCell(arm: Arm, shape: 'file' | 'dir', op: 'rename' | 'delete') {
  const counts: number[] = []
  for (let i = 0; i < SEEDS; i++) {
    const root = mkdtempSync(join(tmpdir(), `diff262-${arm}-${shape}-${op}-`))
    const dir = join(root, 'a')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'watched.txt')
    writeFileSync(file, '0')
    const target = shape === 'dir' ? dir : (arm === 'chokidar-parent' ? dir : file)

    const n = await withWatch(arm, target, async () => {
      if (op === 'rename') {
        writeFileSync(join(dir, 'tmp.txt'), 'r')
        renameSync(join(dir, 'tmp.txt'), file)
      } else {
        rmSync(file, { force: true })
      }
    })
    counts.push(n)
    rmSync(root, { recursive: true, force: true })
  }
  record(arm, shape, op, counts)
  console.log(`VERIFY262_DIFF ${arm} ${shape} ${op} ${JSON.stringify(counts)}`)
}

describe('verify 262: cross-backend differential', () => {
  it('atomic rename-replace is delivered by every arm, in both shapes', async () => {
    // The comment claims "both shapes", so both are measured. For the directory
    // shape every arm watches the directory; the file-shape-only arms collapse.
    for (const arm of ['driver', 'chokidar-file', 'chokidar-parent', 'raw-fs-watch'] as Arm[]) {
      await runCell(arm, 'file', 'rename')
    }
    for (const arm of ['driver', 'chokidar-parent', 'raw-fs-watch'] as Arm[]) {
      await runCell(arm, 'dir', 'rename')
    }

    const matrix = readings.filter((r) => r.op === 'rename')
    console.log('VERIFY262_DIFF_MATRIX rename ' + JSON.stringify(matrix.map((m) => [m.arm, m.counts])))

    // -1 means the arm could not register at all; that is a reading, not a pass.
    const usable = matrix.filter((r) => r.counts.every((c) => c >= 0))
    const silent = usable.filter((r) => r.counts.every((c) => c === 0))
    const unusable = matrix.filter((r) => !usable.includes(r)).map((r) => r.arm)
    if (unusable.length) console.log('VERIFY262_DIFF_UNUSABLE ' + JSON.stringify(unusable))

    // At least the driver and both chokidar arms must have been usable, else the
    // comparison is vacuous.
    expect(usable.map((r) => r.arm)).toContain('driver')
    expect(usable.map((r) => r.arm)).toContain('chokidar-file')
    // The claim is "delivered by every usable arm".
    expect(silent.map((s) => s.arm), 'usable arms that never saw the rename').toEqual([])
  }, 600_000)

  it('a pure delete never reaches the driver, but does reach a reference arm', async () => {
    for (const arm of ['driver', 'chokidar-parent'] as Arm[]) {
      await runCell(arm, 'file', 'delete')
    }
    for (const arm of ['driver', 'chokidar-parent'] as Arm[]) {
      await runCell(arm, 'dir', 'delete')
    }

    const drvFile = readings.find((r) => r.op === 'delete' && r.arm === 'driver' && r.shape === 'file')!
    const refFile = readings.find((r) => r.op === 'delete' && r.arm === 'chokidar-parent' && r.shape === 'file')!
    const drvDir = readings.find((r) => r.op === 'delete' && r.arm === 'driver' && r.shape === 'dir')!
    const refDir = readings.find((r) => r.op === 'delete' && r.arm === 'chokidar-parent' && r.shape === 'dir')!
    console.log('VERIFY262_DIFF_MATRIX delete ' +
      JSON.stringify([[drvFile.arm + '/file', drvFile.counts], [refFile.arm + '/file', refFile.counts],
                      [drvDir.arm + '/dir', drvDir.counts], [refDir.arm + '/dir', refDir.counts]]))

    // Driver: zero on every seed (decision 7a).
    expect(drvFile.counts.every((c) => c === 0), 'driver/file saw a delete').toBe(true)
    expect(drvDir.counts.every((c) => c === 0), 'driver/dir saw a delete').toBe(true)
    // Reference: non-zero on at least one seed, otherwise the driver's zero is
    // uninformative - it could just be a broken harness.
    expect(refFile.counts.some((c) => c > 0), 'reference/file also saw nothing; the comparison is vacuous').toBe(true)
    expect(refDir.counts.some((c) => c > 0), 'reference/dir also saw nothing; the comparison is vacuous').toBe(true)
  }, 600_000)
})
