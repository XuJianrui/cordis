/* eslint-disable */
// A false lead, recorded so it is not re-run: does the driver's filter drop
// *every* event when the watch root is an 8.3 short path?
//
// The hypothesis (packages/fs-node/src/index.ts:55-57 normalizes `path` with
// `resolve()` but compares it against `root` and `filename` as `_resolve` left
// them) looked like a real bug. A hand-written repro appeared to confirm it:
//
//   ignored: (p) => p !== root && p !== target   ->  raw = []
//   ignored: (p) => { p = resolve(p); ... }      ->  raw = ["change:WATCHED.TXT"]
//
// That repro was wrong, and the reason matters: chokidar also consults
// `ignored` for *directory pruning*, so a filter that rejects the root path
// stops the whole tree from being watched. The real driver additionally applies
// `options.ignored` after the built-in test, and -- more importantly -- the
// built-in test only fires `if (isFile ...)`, while the pruning decision hits
// the root. Reproducing "the filter" without the surrounding code reproduced a
// different filter.
//
// Measured through the real service, same directory, both spellings:
//
//   as_given = C:\Users\XUJIAN~1\AppData\Local\Temp\shortroot262-...
//   long     = C:\Users\xujianrui\AppData\Local\Temp\shortroot262-...
//   delivered_via_given = 2      delivered_via_long = 1
//
// Both deliver. So there is no short-path defect, and the interesting part of
// this file is the negative result plus the reason the first attempt was wrong.

import { Context, Fiber } from 'cordis'
import Fs from '@cordisjs/plugin-fs-node'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('verify 262: an 8.3 short watch root (negative result)', () => {
  let fiber: Fiber<Context> | undefined
  let root: string | undefined

  afterEach(async () => {
    await fiber?.dispose()
    fiber = undefined
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  /** Watch `file` through the real service and count what arrives. */
  async function deliver(file: string) {
    const ctx = new Context()
    fiber = await ctx.plugin(Fs)
    const seen: string[] = []
    ctx.fs.watch(file, (p: string) => seen.push(p))
    await sleep(700)
    for (let i = 0; i < 12 && seen.length === 0; i++) {
      writeFileSync(file, 'v' + i)
      await sleep(180)
    }
    await fiber.dispose()
    fiber = undefined
    return seen
  }

  it('delivers through both the short and the long spelling of the root', async () => {
    root = mkdtempSync(join(tmpdir(), 'shortroot262-'))
    const file = join(root, 'probe.yml')
    writeFileSync(file, 'v')

    // `realpathSync` does NOT expand an 8.3 name on Windows -- given the short
    // form it returns the short form -- so the long spelling is built from the
    // profile path. On a system without 8.3 names the two coincide and the
    // reading degenerates to one arm, which is recorded rather than asserted
    // away.
    const asGiven = root
    const long = (() => {
      const home = process.env.USERPROFILE
      if (process.platform !== 'win32' || !home || !/~/.test(root)) return root
      const tail = root.slice(root.toLowerCase().indexOf('\\appdata'))
      return join(home, tail)
    })()
    console.log('VERIFY262_SHORTROOT as_given=' + JSON.stringify(asGiven))
    console.log('VERIFY262_SHORTROOT long=' + JSON.stringify(long))
    console.log('VERIFY262_SHORTROOT long_exists=' + JSON.stringify((() => {
      try { return realpathSync(long) !== '' } catch { return false }
    })()))
    const differs = asGiven !== long
    console.log('VERIFY262_SHORTROOT spellings_differ=' + JSON.stringify(differs))

    const viaGiven = await deliver(join(asGiven, 'probe.yml'))
    const viaLong = await deliver(join(long, 'probe.yml'))
    console.log('VERIFY262_SHORTROOT delivered_via_given=' + viaGiven.length)
    console.log('VERIFY262_SHORTROOT delivered_via_long=' + viaLong.length)

    // The claim is the negative: the short spelling is not silently dead. This
    // can fail, and would mean the driver drops everything on an 8.3 root.
    expect(viaGiven.length, 'the short-path root delivered nothing: the filter may be dropping every event')
      .toBeGreaterThan(0)
    if (differs) {
      expect(viaLong.length, 'the long-path root delivered nothing, so the probe itself is not measuring the driver')
        .toBeGreaterThan(0)
      console.log('VERIFY262_SHORTROOT verdict="no defect: both spellings deliver"')
    } else {
      console.log('VERIFY262_SHORTROOT verdict="degenerate: no 8.3 spelling on this system"')
    }
  }, 120_000)
})
