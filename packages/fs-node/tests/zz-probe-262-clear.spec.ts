/* eslint-disable */
// PROBE 262 / E: the discriminating 2x2. Which single variable explains the excess?
//
// The previous round showed that on macOS ALL THREE arms report ~1.79 events per
// write -- the product, the arm the published differential used, AND the arm
// rebuilt to be isomorphic to the product. An arm asymmetry therefore cannot
// explain it. This spec holds the arms fixed and moves ONE thing: whether the
// event buffer is cleared immediately before the operation is counted.
//
//   A-uncleared  ctx.fs.watch(file),      buffer kept from registration
//   A-cleared    ctx.fs.watch(file),      buffer cleared before the operation
//   B-uncleared  chokidar(dir)+filter,    buffer kept from registration
//   B-cleared    chokidar(dir)+filter,    buffer cleared before the operation
//
// Four independent roots per seed, so no arm can see another's writes.
//
// Prediction if the excess is the startup boundary: uncleared ~1.8 on macOS for
// BOTH libraries, cleared 1.00 for BOTH; on Linux and Windows all four 1.00.
// Prediction if it is duplicate delivery: cleared stays >1 on macOS.
// Prediction if it is the product's fault: A > B in the same cleared state.
import { Context } from 'cordis'
import chokidar from 'chokidar'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { it } from 'vitest'
import Fs from '../src/index.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SEEDS = Number(process.env.PROBE262_SEEDS || 120)
const SETTLE = Number(process.env.PROBE262_SETTLE || 250)

it('probe 262 e: 2x2 cleared/uncleared against two libraries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'e262-'))
  const arms = ['A-uncleared', 'A-cleared', 'B-uncleared', 'B-cleared'] as const
  const write = Object.fromEntries(arms.map((a) => [a, 0])) as Record<string, number>
  const rename = Object.fromEntries(arms.map((a) => [a, 0])) as Record<string, number>
  // per-seed distribution for the uncleared arms, to show the shape (1 vs 2)
  const dist: Record<string, Record<number, number>> = { 'A-uncleared': {}, 'B-uncleared': {}, 'A-cleared': {}, 'B-cleared': {} }
  let seeds = 0

  for (let seed = 0; seed < SEEDS; seed++) {
    const dirs = arms.map((a) => join(root, `${a}-${seed}`))
    for (const d of dirs) mkdirSync(d)
    const files = dirs.map((d) => join(d, 'watched.txt'))
    for (const f of files) writeFileSync(f, '0')

    const ctx = new Context()
    const fiber = await ctx.plugin(Fs)

    // two product watches (one per clear-mode), two chokidar watches (same)
    const ev: Record<string, string[]> = Object.fromEntries(arms.map((a) => [a, []]))
    const stopAU: any = await ctx.fs.watch(files[0], (p: any) => ev['A-uncleared'].push(String(p)))
    const stopAC: any = await ctx.fs.watch(files[1], (p: any) => ev['A-cleared'].push(String(p)))

    const mkChokidar = (dir: string, file: string, sink: string[]) => {
      const w = chokidar.watch(dir, { ignoreInitial: true, depth: 0 })
      w.on('add', (p: string) => { if (resolve(p) === file) sink.push(p) })
      w.on('change', (p: string) => { if (resolve(p) === file) sink.push(p) })
      return w
    }
    const wBU = mkChokidar(dirs[2], files[2], ev['B-uncleared'])
    const wBC = mkChokidar(dirs[3], files[3], ev['B-cleared'])
    await Promise.all([
      new Promise<void>((r) => wBU.once('ready', () => r())),
      new Promise<void>((r) => wBC.once('ready', () => r())),
    ])
    await sleep(SETTLE)

    // THE ONLY DIFFERENCE: clear two of the four buffers, keep the other two
    ev['A-cleared'].length = 0
    ev['B-cleared'].length = 0

    for (const f of files) writeFileSync(f, '1')
    await sleep(SETTLE)

    for (const a of arms) {
      write[a] += ev[a].length
      if (a.endsWith('uncleared') || a.endsWith('cleared')) {
        dist[a][ev[a].length] = (dist[a][ev[a].length] || 0) + 1
      }
    }

    // rename, same 2x2
    for (const a of arms) ev[a].length = 0
    ev['A-cleared'].length = 0
    ev['B-cleared'].length = 0
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(dirs[i], 'tmp.txt'), '2')
      renameSync(join(dirs[i], 'tmp.txt'), files[i])
    }
    await sleep(SETTLE)
    for (const a of arms) rename[a] += ev[a].length

    if (typeof stopAU === 'function') await stopAU()
    if (typeof stopAC === 'function') await stopAC()
    await fiber.dispose()
    await wBU.close(); await wBC.close()
    seeds++
  }

  const ratio = (x: number) => Number((x / Math.max(seeds, 1)).toFixed(3))
  console.log('PROBE262_CLEAR ' + JSON.stringify({
    seeds, settle: SETTLE, platform: process.platform, node: process.version,
    write, rename,
    writeRatio: Object.fromEntries(arms.map((a) => [a, ratio(write[a])])),
    renameRatio: Object.fromEntries(arms.map((a) => [a, ratio(rename[a])])),
    writeDistribution: dist,
  }))
  rmSync(root, { recursive: true, force: true })
}, 1_800_000)
