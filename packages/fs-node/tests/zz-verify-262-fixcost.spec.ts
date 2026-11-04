/* eslint-disable */
// Is decision 7a actually repairable, and at what cost to existing behaviour?
//
// The owner's question is not "is delete lost" (measured: yes) but "what
// happens if I say yes to widening it". Answering that needs a probe that
// replays the driver's exact shape with `unlink` wired in, so the consequences
// are readings rather than my opinion about a one-line change.
//
// The probe copies the driver's options verbatim (ignoreInitial, depth, ignored
// predicate) and adds `unlink`. It does not modify the product source. Three
// things are measured, because each is a way the repair could be worse than the
// gap:
//
//   A. does the delete now arrive?                 (the intended effect)
//   B. does an atomic rename now arrive twice?     (a regression: unlink+add)
//   C. does a *.tmp sweep inside the dir leak in?  (the ignored predicate)
//
// C matters because the driver's file-shape predicate lets through only `root`
// and `filename`, so a sibling temp file from someone else's atomic write must
// stay invisible even with `unlink` wired.

import { Context } from 'cordis'
import Fs from '../src/index.ts'
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { watch } from 'chokidar'
import { describe, expect, it } from 'vitest'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// The driver's registration, with `unlink` added. Kept byte-for-byte parallel to
// packages/fs-node/src/index.ts:51-75 so a drift is visible in review.
function watchWithUnlink(filename: string, onEvent: (kind: string, path: string) => void) {
  const root = dirname(filename)
  const events: string[] = []
  const watcher = watch(root, {
    ignoreInitial: true,
    depth: 0,
    ignored: (path: string) => {
      path = resolve(path)
      return path !== root && path !== filename
    },
  })
  const listener = (kind: string) => (path: string) => {
    events.push(kind + ':' + resolve(path))
    onEvent(kind, resolve(path))
  }
  watcher.on('add', listener('add'))
  watcher.on('change', listener('change'))
  watcher.on('unlink', listener('unlink'))
  return { watcher, events }
}

describe('verify 262: what would widening 7a actually change?', () => {
  it('unlink arrives, a rename still lands once, and a sibling tmp file stays invisible', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fix262-'))
    const file = join(root, 'target.txt')
    writeFileSync(file, 'v0')

    const events: string[] = []
    const { watcher } = watchWithUnlink(file, (kind, p) => events.push(kind + ':' + p))
    await new Promise<void>((r) => watcher.once('ready', () => r()))
    await sleep(400)

    // A. delete reaches the callback
    events.length = 0
    rmSync(file, { force: true })
    for (let i = 0; i < 40 && events.length === 0; i++) await sleep(50)
    await sleep(300)
    const deleteEvents = events.filter((e) => e.startsWith('unlink:'))
    console.log('VERIFY262_FIX A_delete_events=' + JSON.stringify(events))

    // B. atomic rename: does it now arrive as unlink+add (two callbacks)?
    writeFileSync(file, 'v1')
    await sleep(600)
    events.length = 0
    const tmp = join(root, '.target.tmp')
    writeFileSync(tmp, 'v2')
    renameSync(tmp, file)
    for (let i = 0; i < 40 && events.length === 0; i++) await sleep(50)
    await sleep(400)
    const renameEvents = [...events]
    console.log('VERIFY262_FIX B_rename_events=' + JSON.stringify(renameEvents))

    // C. a sibling temp file created and removed by someone else must not surface
    events.length = 0
    const foreign = join(root, '.other.tmp')
    writeFileSync(foreign, 'x')
    await sleep(300)
    rmSync(foreign, { force: true })
    for (let i = 0; i < 20; i++) await sleep(50)
    const foreignEvents = [...events]
    console.log('VERIFY262_FIX C_foreign_tmp_events=' + JSON.stringify(foreignEvents))

    // A: the repair does what it says. One unlink for one delete.
    expect(deleteEvents.length, 'unlink still does not arrive: the repair would not work').toBe(1)
    // B: no regression -- a rename must not double-deliver.
    //
    // The comment said this and the code did not do it: `B_count` was printed
    // and compared to nothing, so a rename that started arriving as
    // `unlink`+`add` would have shown up as a different number in the log and
    // passed anyway.
    //
    // `<= 1` rather than `=== 1`, because this cell asks about the duplicate,
    // not about delivery; and not because 1 is what the runs happen to show --
    // the recorded readings are the support for the bound. Of the runs on file,
    // every `B_rename_events` is a single `change:` on all three platforms
    // (`/tmp/...` on ubuntu, `C:\Users\RUNNER~1\...` on windows,
    // `/var/folders/...` on macos). None is a pair. So a 2 here is a change in
    // behaviour and not noise, which is exactly what makes it worth asserting;
    // if the baseline had been mixed, this bound could not tell a regression
    // from the cell's own variance.
    console.log('VERIFY262_FIX B_count=' + renameEvents.length)
    console.log('VERIFY262_FIX B_no_double_delivery=' + (renameEvents.length <= 1 ? 'yes' : 'no'))
    expect(
      renameEvents.length,
      'a rename delivered ' + renameEvents.length + ' events: attaching unlink brought a duplicate with it',
    ).toBeLessThanOrEqual(1)
    // C: the ignored predicate keeps siblings out even with unlink wired.
    expect(foreignEvents, 'a sibling temp file leaked through the file-shape filter: ' + JSON.stringify(foreignEvents))
      .toEqual([])

    await watcher.close()
    rmSync(root, { recursive: true, force: true })
  }, 180_000)
})
