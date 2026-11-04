/* eslint-disable */
// Which layer drops the removal? The consumer test shows `hmr` reconciles
// nothing after a delete, but that is only diagnostic if the delete *could*
// have produced a callback. This probe answers the narrower question directly:
// for the directory shape, does chokidar emit `unlink` / `unlinkDir`, and does
// the driver's registration hand them to a listener?
//
// It replays the driver's exact registration (the directory-shape options from
// `packages/fs-node/src/index.ts:51-60`) twice -- once as written, once with
// `unlink`/`unlinkDir` additionally wired. The comparison isolates the
// omission from anything chokidar does or does not do.

import { watch } from 'chokidar'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(testDir, '__watch262probe__')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

interface Probe {
  /** what the driver's wired listeners saw */
  wired: string[]
  /** everything chokidar emitted, independent of the wiring */
  raw: string[]
  ready: Promise<void>
  close: () => Promise<void>
}

function start(withRemoval: boolean): Probe {
  const wired: string[] = []
  const raw: string[] = []
  // Exactly the driver's options for the directory shape (`isFile === false`):
  // no `depth` limit, and a caller `ignored` that returns false.
  const watcher = watch(root, {
    ignoreInitial: true,
    depth: undefined,
    ignored: () => false,
  })
  const record = (kind: string) => (path: string) => wired.push(`${kind}:${path}`)
  watcher.on('add', record('add'))
  watcher.on('change', record('change'))
  if (withRemoval) {
    watcher.on('unlink', record('unlink'))
    watcher.on('unlinkDir', record('unlinkDir'))
  }
  watcher.on('all', (kind: string, path: string) => raw.push(`${kind}:${path}`))
  const ready = new Promise<void>(r => watcher.once('ready', () => r()))
  return { wired, raw, ready, close: async () => { await watcher.close() } }
}

const file = join(root, 'victim.txt')
const nested = join(root, 'nested')

describe('verify 262: directory-shape removal, at the chokidar layer', () => {
  beforeAll(() => {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('emits removal events that the driver does not listen for', async () => {
    // --- arm A: the driver's registration as written ---
    writeFileSync(file, 'a')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'inner.txt'), 'a')
    const a = start(false)
    await a.ready
    await sleep(300)

    rmSync(file, { force: true })
    rmSync(nested, { recursive: true, force: true })
    await sleep(1500)
    const aWired = [...a.wired]
    const aRaw = [...a.raw]
    await a.close()

    // --- arm B: same registration plus the two removal listeners ---
    writeFileSync(file, 'b')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'inner.txt'), 'b')
    const b = start(true)
    await b.ready
    await sleep(300)

    rmSync(file, { force: true })
    rmSync(nested, { recursive: true, force: true })
    await sleep(1500)
    const bWired = [...b.wired]
    const bRaw = [...b.raw]
    await b.close()

    const removals = bWired.filter(e => e.startsWith('unlink'))
    console.log('VERIFY262_HMRPROBE A_wired=' + JSON.stringify(aWired))
    console.log('VERIFY262_HMRPROBE A_raw=' + JSON.stringify(aRaw))
    console.log('VERIFY262_HMRPROBE B_wired=' + JSON.stringify(bWired))
    console.log('VERIFY262_HMRPROBE B_raw=' + JSON.stringify(bRaw))
    console.log('VERIFY262_HMRPROBE B_removal_count=' + removals.length)
    console.log('VERIFY262_HMRPROBE B_removal_kinds=' + JSON.stringify([...new Set(removals.map(e => e.split(':')[0]))]))

    // The wiring is the only difference: same filesystem operations, same
    // options, and only arm B sees the removals.
    expect(aWired.filter(e => e.startsWith('unlink')), 'arm A saw a removal, so the driver is not the layer dropping it')
      .toEqual([])
    expect(removals.length, 'arm B saw no removal either, so chokidar is the layer dropping it')
      .toBeGreaterThan(0)
  }, 120_000)
})
