/* eslint-disable */
// Does the *file* shape report a case-only rename? The review's table row for
// the case-insensitive filesystem (issue262-comment-final.md:302) claimed the
// watcher reports `change, unlink` and the driver callback receives "at least
// one `change`". That row had never been measured against the real
// registration, so it was checked here. It is wrong, but not in the way a
// single-platform reading suggests -- which is the whole reason this file now
// reports three readings instead of asserting one.
//
// Two arms, because they answer different questions:
//   A. no filter      -> what does the platform/chokidar actually emit?
//   B. driver filter  -> what reaches the consumer?
// A is the "Watcher reports" column, B is the "Driver callback receives" one.
// Collapsing them misreports a filter drop as platform silence, or the reverse.
//
// Measured on fork CI (857e5e5), file shape, `watched.txt` -> `WATCHED.TXT`:
//
//   platform  FS folds case  A_raw                                B_delivered
//   linux-26  no            [add:WATCHED.TXT, unlink:watched.txt]  []          0
//   win-26    yes           [change:watched.txt, add:WATCHED.TXT,
//                            unlink:watched.txt]                   []          0
//   darwin-26 yes           [change:watched.txt, add:WATCHED.TXT,
//                            unlink:watched.txt]                   [watched.txt] 1
//
// Windows and macOS emit the *same* raw triple, so the platform event set does
// not explain the difference. What differs is the path carried by `change`:
// on macOS it is the OLD spelling, which passes the exact-name filter and is
// delivered; on Windows the same event apparently names the new spelling (or is
// absorbed), so nothing survives the filter. That is why the assertion below is
// per-platform rather than a single "zero callbacks" claim -- an earlier
// version asserted `[]` on every platform and failed on macOS, correctly.
//
// The filter itself is a string compare, `path !== root && path !== filename`
// (packages/fs-node/src/index.ts:56-57), so this is the mechanism to hold onto:
// whatever spelling arrives is compared literally against the registered one.

import { Context } from 'cordis'
import Fs from '@cordisjs/plugin-fs-node'
import { watch } from 'chokidar'
import { mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

interface Arm {
  raw: string[]
  delivered: string[]
  ready: Promise<void>
  close: () => Promise<void>
}

function start(root: string, filename: string, withFilter: boolean): Arm {
  const raw: string[] = []
  const delivered: string[] = []
  const watcher = watch(root, {
    ignoreInitial: true,
    depth: 0,
    // Arm A keeps every path; arm B is the driver's filter, copied verbatim
    // from packages/fs-node/src/index.ts:55-58.
    ignored: withFilter ? (path: string) => path !== root && path !== filename : () => false,
  })
  const listener = (path: string) => delivered.push(path)
  watcher.on('add', listener)
  watcher.on('change', listener)
  watcher.on('all', (kind: string, path: string) => raw.push(kind + ':' + path))
  return {
    raw,
    delivered,
    ready: new Promise<void>(r => watcher.once('ready', () => r())),
    close: () => watcher.close(),
  }
}

describe('verify 262: file shape, case-only rename', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'filecase262-'))
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('splits the raw event from what the driver filter lets through', async () => {
    const lower = join(root, 'watched.txt')
    const upper = join(root, 'WATCHED.TXT')
    writeFileSync(lower, 'v1')

    // Whether this filesystem folds case decides which row of the table this
    // reading belongs to: measured via inode, never assumed from the platform
    // name (linux and win32 disagree here, and that disagreement is the point).
    let caseInsensitive = false
    try {
      caseInsensitive = statSync(upper).ino === statSync(lower).ino
    } catch {
      caseInsensitive = false
    }
    console.log('VERIFY262_FILECASE case_insensitive=' + JSON.stringify(caseInsensitive))

    const bare = start(root, lower, false)
    const driver = start(root, lower, true)
    await Promise.all([bare.ready, driver.ready])
    // Settle the buffer so the write above cannot leak into the rename reading.
    await sleep(600)
    const base = { bareRaw: bare.raw.length, bareDel: bare.delivered.length, drvRaw: driver.raw.length, drvDel: driver.delivered.length }
    console.log('VERIFY262_FILECASE residue_before_rename=' + JSON.stringify(base))

    renameSync(lower, upper)
    await sleep(1500)

    const tail = (arr: string[], from: number) => arr.slice(from).map(e => {
      const i = e.indexOf(':')
      return e.slice(0, i) + ':' + e.slice(i + 1).split(/[\\/]/).pop()
    })
    const bareRaw = tail(bare.raw, base.bareRaw)
    const bareDel = bare.delivered.slice(base.bareDel).map(p => p.split(/[\\/]/).pop())
    const drvRaw = tail(driver.raw, base.drvRaw)
    const drvDel = driver.delivered.slice(base.drvDel).map(p => p.split(/[\\/]/).pop())
    await bare.close()
    await driver.close()

    console.log('VERIFY262_FILECASE A_raw=' + JSON.stringify(bareRaw))
    console.log('VERIFY262_FILECASE A_delivered=' + JSON.stringify(bareDel))
    console.log('VERIFY262_FILECASE B_raw=' + JSON.stringify(drvRaw))
    console.log('VERIFY262_FILECASE B_delivered=' + JSON.stringify(drvDel))
    console.log('VERIFY262_FILECASE B_delivered_count=' + drvDel.length)

    const targetExists = (() => { try { statSync(upper); return true } catch { return false } })()
    console.log('VERIFY262_FILECASE target_exists=' + JSON.stringify(targetExists))
    expect(targetExists, 'the rename did not take effect, so the event reading is vacuous').toBe(true)

    // Does the silence matter? On a case-insensitive filesystem the old
    // spelling still resolves to the same entry, so a consumer that keeps
    // reading the registered path is not broken, only uninformed. That
    // distinction decides whether "delivers nothing" is a defect or a
    // non-event, and it is measurable rather than arguable.
    let oldSpellingReadable = false
    try {
      oldSpellingReadable = statSync(lower).ino === statSync(upper).ino
    } catch {
      oldSpellingReadable = false
    }
    console.log('VERIFY262_FILECASE old_spelling_still_resolves=' + JSON.stringify(oldSpellingReadable))

    // Vacuity gate for arm A: a raw watcher that is dead also reports nothing.
    // Checked on the *upper* path after the rename, so it cannot disturb the
    // reading above.
    const probe = start(root, upper, false)
    await probe.ready
    await sleep(300)
    let alive = false
    for (let i = 0; i < 20 && !alive; i++) {
      writeFileSync(upper, 'v' + (2 + i))
      await sleep(100)
      alive = probe.raw.length > 0
    }
    await probe.close()
    console.log('VERIFY262_FILECASE arm_A_alive=' + JSON.stringify(alive))
    expect(alive, 'the raw watcher is dead, so "no event on rename" is not a reading').toBe(true)

    // The claim, stated as the mechanism rather than a per-platform count:
    // every callback that does arrive names the registered spelling, because
    // the filter compares strings. Zero callbacks also satisfies this -- which
    // is exactly why the loop below is preceded by a gate proving that this
    // same filtered registration can deliver at all.
    for (const name of drvDel) {
      expect(name, 'the filter let through a spelling it should have compared away')
        .toBe('watched.txt')
    }

    // What the driver *listens for* is a different question from what it
    // delivers, and the honest reading of it is the source, not this probe:
    // `B_raw` records `watcher.on('all')`, which the driver never subscribes
    // to, so it shows `unlink` on every platform whether or not the driver
    // listens. Asserting anything about `unlink` on `drvDel` would be vacuous
    // by construction -- the listener is only attached to `add`/`change`, so
    // an `unlink` cannot appear there. Asserting it on a local constant would
    // be vacuous twice over. Both traps were hit while writing this file, so
    // the registration shape is logged and the assertion lives where it can
    // actually fail: the delivered names above.
    console.log('VERIFY262_FILECASE driver_listens_for=' + JSON.stringify(['add', 'change']))
    console.log('VERIFY262_FILECASE B_raw_has_unlink=' + JSON.stringify(drvRaw.some(e => e.startsWith('unlink'))))

    // Non-vacuity gate for arm B. Without it, "the delivered names are all the
    // registered spelling" is satisfied by an empty array on two platforms, and
    // an empty array is also what a broken filter *or* a dead watcher returns.
    //
    // The gate goes through the **real service**, not through a hand-written
    // `ignored`: chokidar consults `ignored` for directory pruning as well, so
    // a copied filter can stop the watcher before any event is produced. Two
    // attempts at a copied-filter gate failed for exactly that reason and were
    // misread as a driver defect; see zz-verify-262-shortroot.spec.ts.
    const gateCtx = new Context()
    const gateFiber = await gateCtx.plugin(Fs)
    const gateSeen: string[] = []
    gateCtx.fs.watch(upper, (p: string) => gateSeen.push(p))
    await sleep(700)
    for (let i = 0; i < 30 && gateSeen.length === 0; i++) {
      writeFileSync(upper, 'gate' + i)
      await sleep(150)
    }
    const gateNames = [...new Set(gateSeen.map(p => p.split(/[\\/]/).pop()))]
    await gateFiber.dispose()
    console.log('VERIFY262_FILECASE arm_B_can_deliver=' + JSON.stringify(gateSeen.length > 0))
    console.log('VERIFY262_FILECASE arm_B_gate_count=' + gateSeen.length)
    console.log('VERIFY262_FILECASE arm_B_gate_names=' + JSON.stringify(gateNames))
    // A gate that cannot deliver makes the rename reading uninformative, so it
    // fails rather than being logged and forgiven.
    expect(gateSeen.length, 'the filtered registration never delivered an ordinary write, so "nothing was delivered for the rename" is not a reading')
      .toBeGreaterThan(0)
    expect(gateNames, 'the gate delivered a name other than the one it was registered for')
      .toEqual(['WATCHED.TXT'])
    // Recorded, not asserted to one value: the count is a platform property
    // (0 on linux and win32, 1 on darwin in the run above). Asserting a single
    // number here is what made the first version of this file fail on macOS.
    console.log('VERIFY262_FILECASE verdict=' + JSON.stringify({
      caseInsensitive,
      delivered: drvDel.length,
      note: caseInsensitive
        ? 'case folding FS: the registered spelling may still be reported (see A_raw/B_raw)'
        : 'case-sensitive FS: the rename is a different path, so silence is correct',
    }))
  }, 120_000)
})
