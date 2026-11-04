/* eslint-disable */
// A third false lead, recorded so it is not re-run: does a lowercase drive
// letter in a `file:` URL make the filter reject the file it registered for?
//
// The hypothesis came from reading `_resolve` (packages/fs-node/src/index.ts:
// 33-39): a `file:` URL is returned as `fileURLToPath(path)` verbatim, with no
// `resolve()` pass, while the filter normalizes only the candidate
// (`path = resolve(path)`). If `resolve()` upper-cased a drive letter while
// `fileURLToPath` preserved a lower-case one, the comparison could never
// match and the watch would be a silent no-op.
//
// Measured, both spellings of the same file through the real service:
//
//   delivered_upper = 2      delivered_lower = 1      threw = undefined
//
// Both deliver, so the premise is wrong. The reason, measured separately:
//
//   pathToFileURL('c:\\x') -> file:///c:/x  -> fileURLToPath -> 'c:\x'
//   watch('c:\x', ...)     -> chokidar reports 'c:\x'    (keeps the case it was given)
//   resolve('c:\x')        -> 'c:\x'                     (keeps it too)
//
// `path.resolve()` does not upper-case an already-absolute drive letter, so the
// candidate and the registered spelling agree whichever case the caller used.
// The comparison holds, and the filter is not reachable by this route.
//
// The file is kept because the two readings are the point: "accepted but
// silently dead" is a plausible failure shape for a string-compare filter, and
// ruling it out with a measurement is cheaper than ruling it out again later.

import { Context, Fiber } from 'cordis'
import Fs from '@cordisjs/plugin-fs-node'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('verify 262: a lowercase drive letter in a file: URL (negative result)', () => {
  let fiber: Fiber<Context> | undefined
  let root: string | undefined

  afterEach(async () => {
    await fiber?.dispose()
    fiber = undefined
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  async function deliver(target: string | URL, file: string) {
    const ctx = new Context()
    fiber = await ctx.plugin(Fs)
    const seen: string[] = []
    let threw: string | undefined
    try {
      ctx.fs.watch(target, (p: string) => seen.push(p))
    } catch (error) {
      threw = (error as Error)?.constructor?.name ?? 'Error'
    }
    await sleep(700)
    for (let i = 0; i < 15 && seen.length === 0; i++) {
      writeFileSync(file, 'v' + i)
      await sleep(160)
    }
    await fiber.dispose()
    fiber = undefined
    return { seen, threw }
  }

  it('delivers through both drive-letter spellings', async () => {
    root = mkdtempSync(join(tmpdir(), 'drvcase262-'))
    const file = join(root, 'probe.yml')
    writeFileSync(file, 'v')
    if (process.platform !== 'win32') {
      console.log('VERIFY262_DRVCASE verdict="skipped: no drive letters on this platform"')
      return
    }

    const upper = process.env.SystemDrive ?? 'C:'
    const lowerFile = upper.toLowerCase() + file.slice(upper.length)
    console.log('VERIFY262_DRVCASE upper_file=' + JSON.stringify(file))
    console.log('VERIFY262_DRVCASE lower_file=' + JSON.stringify(lowerFile))

    const viaUpper = await deliver(pathToFileURL(file), file)
    const viaLower = await deliver(pathToFileURL(lowerFile), file)
    console.log('VERIFY262_DRVCASE delivered_upper=' + viaUpper.seen.length + ' threw=' + JSON.stringify(viaUpper.threw))
    console.log('VERIFY262_DRVCASE delivered_lower=' + viaLower.seen.length + ' threw=' + JSON.stringify(viaLower.threw))
    console.log('VERIFY262_DRVCASE verdict=' + JSON.stringify(
      viaLower.seen.length > 0 ? 'no defect: both spellings deliver' : 'defect: the lowercase drive is accepted and silent'))

    // Gate, then the claim. Both must deliver; a failure of either is a real
    // reading, and the message says which one broke.
    expect(viaUpper.seen.length, 'the uppercase-drive URL delivered nothing, so the probe is not measuring the driver')
      .toBeGreaterThan(0)
    expect(viaLower.seen.length, 'a lowercase drive letter in a file: URL is accepted at registration and then delivers nothing')
      .toBeGreaterThan(0)
  }, 120_000)
})
