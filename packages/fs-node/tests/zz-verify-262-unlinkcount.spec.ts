/* eslint-disable */
// The comment draft says, of the repair for 7a:
//
//   "Adding watcher.on('unlink', ...) is a one-line change at
//    packages/fs-node/src/index.ts:71-72 and it does deliver exactly one
//    callback for a delete (measured)."
//
// "exactly one" is the operative word, and the existing suite does not measure
// it: the propagation probe (zz-verify-262-propagation.spec.ts) counts removal
// events on a *manually registered* watcher and gets 3 for one delete of a file
// plus a directory, which is not the same question. This measures the count a
// real `unlink` listener would receive for one file delete, on the driver's own
// registration, in both shapes.
//
// The patch is not applied to the product code. The registration is rebuilt in
// the test with `unlink` added, which is exactly what the one-line change does,
// so the count is a reading of the proposed repair rather than a guess.
//
// Note the `all` subscription is deliberately absent: `all` is what produced the
// three-event reading, and it is not what the repair wires.

import { Context, Fiber } from 'cordis'
import Fs from '@cordisjs/plugin-fs-node'
import { watch } from 'chokidar'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('verify 262: how many callbacks a wired unlink delivers', () => {
  let root: string | undefined

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  it('counts per shape, with the repair wired and without it', async () => {
    root = mkdtempSync(join(tmpdir(), 'unlinkcount262-'))
    mkdirSync(join(root, 'dir'), { recursive: true })

    /** The driver's own options, with or without the proposed `unlink` wiring. */
    function register(target: string, wired: boolean) {
      // Reproduce what the driver computes for `isFile` / `root` / `depth`.
      const isFile = !statSync(target, { throwIfNoEntry: false })?.isDirectory()
      const watchRoot = isFile ? dirname(target) : target
      const delivered: string[] = []
      const watcher = watch(watchRoot, {
        ignoreInitial: true,
        depth: isFile ? 0 : undefined,
      })
      const listener = (p: string) => delivered.push(p)
      watcher.on('add', listener)
      watcher.on('change', listener)
      if (wired) watcher.on('unlink', listener)
      return {
        delivered,
        ready: new Promise<void>(r => watcher.once('ready', () => r())),
        close: () => watcher.close(),
      }
    }

    for (const shape of ['file', 'directory'] as const) {
      for (const wired of [false, true]) {
        const target = shape === 'file'
          ? join(root, `f-${wired}.yml`)
          : join(root, 'dir')
        if (shape === 'file') writeFileSync(target, 'v')
        else writeFileSync(join(target, 'inner.yml'), 'v')

        const arm = register(target, wired)
        await arm.ready
        await sleep(600)
        const before = arm.delivered.length

        if (shape === 'file') rmSync(target, { force: true })
        else rmSync(join(target, 'inner.yml'), { force: true })
        await sleep(1500)

        const count = arm.delivered.length - before
        console.log(`VERIFY262_UNLINK shape=${shape} wired=${wired} count=${count}`)
        console.log(`VERIFY262_UNLINK shape=${shape} wired=${wired} names=` +
          JSON.stringify(arm.delivered.slice(before).map(p => p.split(/[\\/]/).pop())))
        await arm.close()

        // Recorded for the unwired arm (0 is the known defect) and asserted for
        // the wired one only in the direction the draft claims: at least one.
        // "Exactly one" is printed, not asserted -- see the note below.
        if (wired) {
          expect(count, `wiring unlink delivered nothing for the ${shape} shape, so the repair does not work at all`)
            .toBeGreaterThan(0)
        }
      }
    }

    // Why "exactly one" is logged rather than asserted: the draft's word is
    // "exactly", and this probe can only show what one run delivered. A count
    // that is stable here but varies under load would make "exactly" wrong
    // while leaving "at least one" true, and the draft's own §7 contract is
    // "at least one, never exactly one" for `change`. Keeping the number visible
    // without pinning it is what stops this file from asserting a stronger
    // guarantee than the evidence supports.
    await sleep(10)
  }, 120_000)
})
