/* eslint-disable */
// Does the "a consumer that treats `add` as a new file sees a duplicate" hazard
// have a real consumer?
//
// The driver's callback carries a path and no event kind, so neither production
// consumer can tell `add` from `change` even in principle. `hmr` pushes the path
// into a Set and debounces (`packages/hmr/src/index.ts:184-187`); `include`
// ignores the argument entirely and calls `refresh()` (`:296`). Both are
// therefore keyed on the path, not on the event.
//
// So the question is not "does the consumer distinguish add" -- it cannot --
// but "what happens if the same path is delivered twice for one operation".
// This measures that against the real driver: a case-only rename on a
// case-insensitive filesystem, replayed through the driver's own registration.
//
// On a case-sensitive filesystem a case-only rename is a different path, so it
// is measured separately and reported rather than assumed.

import { watch } from 'chokidar'
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'

const testDir = dirname(fileURLToPath(import.meta.url))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** What the driver delivers for the directory shape: path only, per event. */
function start(root: string) {
  const delivered: string[] = []
  const raw: string[] = []
  const watcher = watch(root, { ignoreInitial: true, depth: undefined, ignored: () => false })
  const listener = (path: string) => delivered.push(resolve(path))
  watcher.on('add', listener)
  watcher.on('change', listener)
  watcher.on('all', (kind: string, path: string) => raw.push(`${kind}:${path}`))
  const ready = new Promise<void>(r => watcher.once('ready', () => r()))
  return { delivered, raw, ready, close: async () => { await watcher.close() } }
}

describe('verify 262: duplicate delivery to a path-keyed consumer', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'case262-'))
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('delivers one operation as more than one callback on a case-only rename', async () => {
    const lower = join(root, 'watched.txt')
    const upper = join(root, 'WATCHED.TXT')
    writeFileSync(lower, 'v1')
    const probe = start(root)
    await probe.ready
    await sleep(400)

    // one operation: rename changing only case
    renameSync(lower, upper)
    await sleep(1500)
    const delivered = [...probe.delivered]
    const raw = [...probe.raw]
    await probe.close()

    // How many distinct paths, and how many callbacks for them?
    const distinct = [...new Set(delivered)]
    console.log('VERIFY262_CASE delivered=' + JSON.stringify(delivered.map(p => p.split(/[\\/]/).pop())))
    console.log('VERIFY262_CASE raw=' + JSON.stringify(raw.map(e => {
      const i = e.indexOf(':')
      return `${e.slice(0, i)}:${e.slice(i + 1).split(/[\\/]/).pop()}`
    })))
    console.log('VERIFY262_CASE callbacks=' + delivered.length)
    console.log('VERIFY262_CASE distinct_paths=' + distinct.length)
    console.log('VERIFY262_CASE platform=' + process.platform)
    // A path-keyed consumer collapses to the set of paths it was given. If the
    // two spellings are the same path on this filesystem, a Set sees one entry
    // and a deduplicating consumer does the work once despite two callbacks.
    const keyed = new Set(delivered)
    console.log('VERIFY262_CASE set_size=' + keyed.size)
    console.log('VERIFY262_CASE folds_to_one=' + JSON.stringify(keyed.size === 1))

    // Recorded, not asserted per platform: the claim is about what a path-keyed
    // consumer experiences, and that differs by filesystem case sensitivity.
    expect(delivered.length, 'the rename produced no callback at all, so the reading is vacuous')
      .toBeGreaterThan(0)
  }, 120_000)
})
