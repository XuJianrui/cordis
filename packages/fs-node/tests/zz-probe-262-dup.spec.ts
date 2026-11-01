/* eslint-disable */
// Closes the "duplicates not measured for this op" gap in the watch table.
//
// Harness note (learned the hard way): a case-only rename must use a FRESH
// watcher per seed. Reusing one watcher across N renames of the same name pair
// returns 0 events after the first, because the watcher's name filter has
// already settled -- that is a harness artefact, not driver behaviour, and it
// contradicts the grid, which uses a fresh watcher per run and reports one
// `change` every time. So each seed below builds and tears down its own watch.
import { Context } from 'cordis'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { it } from 'vitest'
import Fs from '../src/index.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SEEDS = Number(process.env.PROBE262_SEEDS || 100)

function report(label: string, perSeed: number[], extra: Record<string, unknown> = {}) {
  const total = perSeed.reduce((x, y) => x + y, 0)
  const dist: Record<string, number> = {}
  for (const n of perSeed) dist[n] = (dist[n] || 0) + 1
  if (perSeed.length !== SEEDS) throw new Error(`only ${perSeed.length}/${SEEDS} seeds ran`)
  const missed = perSeed.filter((n) => n === 0).length
  console.log('PROBE262_DUP ' + JSON.stringify({
    op: label, seeds: SEEDS, platform: process.platform, node: process.version,
    totalEvents: total, ratio: Number((total / SEEDS).toFixed(3)),
    mean: Number((total / SEEDS).toFixed(3)), missed, distribution: dist, ...extra,
  }))
  return { total, missed, dist }
}

// One watcher per seed, same shape as the grid cell.
async function once(op: (file: string, dir: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'dup262-'))
  const dir = join(root, 'a')
  mkdirSync(dir)
  const file = join(dir, 'watched.txt')
  writeFileSync(file, 'seed')
  const ctx = new Context()
  const fiber = await ctx.plugin(Fs)
  const events: string[] = []
  const stop = await ctx.fs.watch(file, (p: any) => events.push(String(p)))
  await sleep(350)
  events.length = 0
  await op(file, dir)
  await sleep(250)
  const n = events.length
  await stop()
  await fiber.dispose()
  rmSync(root, { recursive: true, force: true })
  return n
}

it('dup 262: write (one event per write?)', async () => {
  const per: number[] = []
  for (let i = 0; i < SEEDS; i++) per.push(await once(async (file) => { writeFileSync(file, 'x') }))
  report('write', per)
}, 1200000)

it('dup 262: recreate 0ms (fresh watcher per seed)', async () => {
  const per: number[] = []
  for (let i = 0; i < SEEDS; i++) {
    per.push(await once(async (file) => {
      rmSync(file, { force: true })
      writeFileSync(file, 'x')
    }))
  }
  const r = report('recreate-0', per)
  if (r.missed > 0) throw new Error(`recreate-0 missed ${r.missed}`)
}, 1200000)

it('dup 262: recreate 20ms (fresh watcher per seed)', async () => {
  const per: number[] = []
  for (let i = 0; i < SEEDS; i++) {
    per.push(await once(async (file) => {
      rmSync(file, { force: true })
      await sleep(20)
      writeFileSync(file, 'x')
    }))
  }
  const r = report('recreate-20', per)
  if (r.missed > 0) throw new Error(`recreate-20 missed ${r.missed}`)
}, 1200000)

it('dup 262: case-only rename (fresh watcher per seed)', async () => {
  const per: number[] = []
  let noop = 0
  for (let i = 0; i < SEEDS; i++) {
    const n = await once(async (file) => {
      const upper = join(dirname(file), basename(file).toUpperCase())
      if (upper === file) { noop++; return }
      try { renameSync(file, upper) } catch { noop++ }
    })
    per.push(n)
  }
  report('case-rename', per, { sameEntryNoop: noop })
}, 1200000)
