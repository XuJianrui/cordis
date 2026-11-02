/* eslint-disable */
// PROBE 262 / A: is the A-vs-B ratio a property of the driver, or of the arms?
//
// The published differential pairs ctx.fs.watch(file) -- parent-directory watch,
// exact-name filter, add+change only -- against chokidar.watch(dir) with no
// filter and on('all'). Those are two different instruments. This spec runs the
// PAIR three ways on the same operation trace:
//
//   A  = ctx.fs.watch(file)                      (the product)
//   B0 = chokidar(dir).on('all')                 (the arm the differential used)
//   B1 = chokidar(dir).on(add,change) + name filter   (isomorphic to A)
//
// Each arm watches its OWN root, so no arm can see another arm's writes.
//
// Reading: if A != B0 but A == B1, the earlier ratio was the instruments.
// If A != B1 as well, the ratio is the driver's and must be explained.
import { Context } from 'cordis'
import chokidar from 'chokidar'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { it } from 'vitest'
import Fs from '../src/index.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SEEDS = Number(process.env.PROBE262_SEEDS || 120)

it('probe 262 iso: three-arm differential, A vs B0 vs B1', async () => {
  const root = mkdtempSync(join(tmpdir(), 'iso262-'))
  const stats = {
    seeds: 0, platform: process.platform, node: process.version,
    writeMiss: 0, renameMiss: 0, deleteSeen: 0, disposeLeak: 0,
  }
  const diff = { write: [0, 0, 0], rename: [0, 0, 0], delete: [0, 0, 0] } // [A, B0, B1]

  for (let seed = 0; seed < SEEDS; seed++) {
    const a = join(root, `a${seed}`)
    const b0 = join(root, `b0-${seed}`)
    const b1 = join(root, `b1-${seed}`)
    for (const x of [a, b0, b1]) mkdirSync(x)

    const ctx = new Context()
    const fiber = await ctx.plugin(Fs)
    const evA: string[] = []; const evB0: string[] = []; const evB1: string[] = []
    const fa = join(a, 'watched.txt')
    const f0 = join(b0, 'watched.txt')
    const f1 = join(b1, 'watched.txt')
    for (const f of [fa, f0, f1]) writeFileSync(f, '0')

    // A: the product, in its file shape
    const stop = await ctx.fs.watch(fa, (p: any) => evA.push(String(p)))

    // B0: what the published differential used -- directory, no filter, all events
    const w0 = chokidar.watch(b0, { ignoreInitial: true, depth: 0 })
    w0.on('all', (_e: string, p: string) => evB0.push(String(p)))

    // B1: isomorphic to A -- same root shape, same name filter, same two events
    const w1 = chokidar.watch(b1, { ignoreInitial: true, depth: 0 })
    w1.on('add', (p: string) => { if (resolve(p) === f1) evB1.push(p) })
    w1.on('change', (p: string) => { if (resolve(p) === f1) evB1.push(p) })

    await Promise.all([
      new Promise<void>((r) => w0.once('ready', () => r())),
      new Promise<void>((r) => w1.once('ready', () => r())),
    ])
    await sleep(250)

    // WRITE: touch only the watched file in each root
    for (const f of [fa, f0, f1]) writeFileSync(f, '1')
    await sleep(250)
    if (evA.length === 0) stats.writeMiss++
    diff.write[0] += evA.length; diff.write[1] += evB0.length; diff.write[2] += evB1.length

    // RENAME ONTO: atomic replace of the watched path
    evA.length = 0; evB0.length = 0; evB1.length = 0
    for (const [dir, f] of [[a, fa], [b0, f0], [b1, f1]] as const) {
      writeFileSync(join(dir, 'tmp.txt'), '2')
      renameSync(join(dir, 'tmp.txt'), f)
    }
    await sleep(250)
    if (evA.length === 0) stats.renameMiss++
    diff.rename[0] += evA.length; diff.rename[1] += evB0.length; diff.rename[2] += evB1.length

    // DELETE: A cannot see it (no unlink subscription); B0/B1 differ by event set
    evA.length = 0; evB0.length = 0; evB1.length = 0
    for (const f of [fa, f0, f1]) rmSync(f, { force: true })
    await sleep(250)
    if (evA.length > 0) stats.deleteSeen++
    diff.delete[0] += evA.length; diff.delete[1] += evB0.length; diff.delete[2] += evB1.length

    // DISPOSE: nothing after the handle ends
    await stop(); await fiber.dispose()
    evA.length = 0
    writeFileSync(join(a, 'after.txt'), 'x')
    await sleep(200)
    if (evA.length > 0) stats.disposeLeak++

    await w0.close(); await w1.close()
    stats.seeds++
  }

  const r = { ...stats, diff, suite: 'iso' }
  console.log('PROBE262_ISO ' + JSON.stringify(r))
  rmSync(root, { recursive: true, force: true })
  if (stats.writeMiss || stats.renameMiss || stats.disposeLeak) {
    throw new Error('iso probe saw a miss: ' + JSON.stringify(stats))
  }
}, 1_800_000)
