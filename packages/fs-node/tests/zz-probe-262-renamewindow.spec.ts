/* eslint-disable */
// Is the 0.01% rename "loss" a loss, or a 200 ms window that ran out?
//
// Appendix A carries two claims about the same operation:
//   property test, 1,500 seeds in CI  -> "0 missed rename-onto"
//   10,000-seed run, 30,000 renames   -> "3 delivered no event (0.01%)"
// Both are printed as absolutes, and they disagree. The 10k harness counts a
// miss as `evA.length === 0` after a fixed `sleep(200)`, under ten concurrent
// shards on a runner that has two cores. So the third possibility -- the event
// arrived after 200 ms -- was never excluded.
//
// This probe separates the two. On a miss it keeps the watch open and records
// when the event finally arrives (or that it never does within 5 s):
//
//   late   -> a window artifact, and the claim must become "within N ms"
//   never  -> a real loss, and "at least one" is falsified at ~0.01%
//
// The seed offsets are the three shards that reported misses (7000, 8000 on
// ubuntu-26; 0 on windows-26), replayed with the same 10-way concurrency that
// produced them, because concurrency is the suspected cause.
import { Context } from 'cordis'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import Fs from '../src/index.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Wait up to `cap` ms, polling every 10 ms; return the elapsed time at first
// event, or -1 if none arrived.
async function waitFor(seen: string[], cap: number) {
  const t0 = Date.now()
  while (Date.now() - t0 < cap) {
    if (seen.length > 0) return Date.now() - t0
    await sleep(10)
  }
  return seen.length > 0 ? Date.now() - t0 : -1
}

async function shard(offset: number, seeds: number) {
  const rootDir = mkdtempSync(join(tmpdir(), `rename262-${offset}-`))
  const out = {
    offset,
    seeds: 0,
    // arrivals within the original window
    within200: 0,
    // a first event that arrived after 200 ms but before the cap
    late: 0,
    // nothing at all within the cap
    never: 0,
    lateMs: [] as number[],
    neverSeeds: [] as number[],
    // the original harness's own counter, for a like-for-like comparison
    miss200: 0,
  }
  const CAP = Number(process.env.PROBE262_ARRIVAL_CAP || 5000)
  for (let seed = offset; seed < offset + seeds; seed++) {
    const a = join(rootDir, `a${seed}`)
    mkdirSync(a)
    const ctx = new Context()
    const fiber = await ctx.plugin(Fs)
    const seen: string[] = []
    const fileA = join(a, 'watched.txt')
    writeFileSync(fileA, '0')
    const stop = await ctx.fs.watch(fileA, (p: any) => seen.push(String(p)))
    await sleep(200)
    // drain anything from registration
    seen.length = 0

    writeFileSync(join(a, 'tmp.txt'), '2')
    renameSync(join(a, 'tmp.txt'), fileA)

    // exactly what the 10k harness did: 200 ms then count
    await sleep(200)
    const inWindow = seen.length
    if (inWindow === 0) out.miss200++

    if (inWindow > 0) {
      out.within200++
    } else {
      // it looked lost at 200 ms -- is it late, or gone?
      const extra = await waitFor(seen, CAP)
      if (extra >= 0) {
        out.late++
        out.lateMs.push(200 + extra)
      } else {
        out.never++
        out.neverSeeds.push(seed)
      }
    }

    await stop()
    await fiber.dispose()
    rmSync(rootDir, { recursive: true, force: true })
    mkdirSync(rootDir, { recursive: true })
    out.seeds++
  }
  rmSync(rootDir, { recursive: true, force: true })
  return out
}

it('probe 262: did the 0.01% rename misses arrive late, or never?', async () => {
  const seeds = Number(process.env.PROBE262_SEEDS || 200)
  const cap = Number(process.env.PROBE262_ARRIVAL_CAP || 5000)
  // The same three offsets that reported misses, run concurrently so the
  // runner is under the load that produced them.
  const offsets = (process.env.PROBE262_OFFSETS || '0,7000,8000')
    .split(',')
    .map((s) => Number(s))

  const results = await Promise.all(offsets.map((o) => shard(o, seeds)))
  for (const r of results) {
    console.log('PROBE262_RENAME_ARRIVAL ' + JSON.stringify({ ...r, cap }))
  }
  const totals = results.reduce(
    (acc, r) => ({
      seeds: acc.seeds + r.seeds,
      within200: acc.within200 + r.within200,
      late: acc.late + r.late,
      never: acc.never + r.never,
      miss200: acc.miss200 + r.miss200,
    }),
    { seeds: 0, within200: 0, late: 0, never: 0, miss200: 0 },
  )
  console.log('PROBE262_RENAME_ARRIVAL_TOTAL ' + JSON.stringify({ ...totals, cap, platform: process.platform, node: process.version }))

  // No assertion: the reading is the point. A non-zero `late` with zero `never`
  // means the 10k harness's absolute "delivered no event" was a timeout
  // artifact, and the draft's sentence has to become a bounded one.
}, 2_400_000)
