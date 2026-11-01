/* eslint-disable */
// Decides whether the "1.55 events per write on macOS" (10k harness) is a real
// duplicate or a window artefact.
//
// The 10k harness never clears the event buffer before its write window and
// sleeps only 200 ms after registering the watch. Appendix B already records
// that on macOS a watch started right after a write can deliver that write as
// a delayed `change` (1000 ms settle removes it). So the write window may be
// counting the initial `writeFileSync(file, '0')` as a second event.
//
// A/B on the same machine, same seeds, fresh watcher per seed:
//   UNCLEARED  -- 10k harness shape: no reset before the op, 200 ms settle
//   CLEARED    -- dup harness shape: reset after 350 ms settle, then the op
// If duplicates are real, both arms give the same ratio. If it is the startup
// boundary, UNCLEARED is higher and CLEARED is 1.00.
import { Context } from 'cordis'
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import Fs from '../src/index.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SEEDS = Number(process.env.PROBE262_SEEDS || 60)

async function once(op: (file: string, dir: string) => Promise<void>, mode: 'uncleared' | 'cleared') {
  const root = mkdtempSync(join(tmpdir(), `win262-${mode}-`))
  const dir = join(root, 'a')
  mkdirSync(dir)
  const file = join(dir, 'watched.txt')
  writeFileSync(file, '0')
  const ctx = new Context()
  const fiber = await ctx.plugin(Fs)
  const events: string[] = []
  const stop = await ctx.fs.watch(file, (p: any) => events.push(String(p)))
  if (mode === 'cleared') {
    await sleep(350)
    events.length = 0
  } else {
    await sleep(200)
  }
  await op(file, dir)
  await sleep(mode === 'cleared' ? 250 : 200)
  const n = events.length
  await stop()
  await fiber.dispose()
  return n
}

function report(label: string, per: number[]) {
  const total = per.reduce((x, y) => x + y, 0)
  const dist: Record<string, number> = {}
  for (const n of per) dist[n] = (dist[n] || 0) + 1
  console.log('PROBE262_WINDOW ' + JSON.stringify({
    op: label, seeds: SEEDS, platform: process.platform, node: process.version,
    total, ratio: Number((total / SEEDS).toFixed(3)), distribution: dist,
    missed: per.filter((n) => n === 0).length,
  }))
}

it('window: write, uncleared (10k shape)', async () => {
  const per: number[] = []
  for (let i = 0; i < SEEDS; i++) per.push(await once(async (f) => { writeFileSync(f, String(i)) }, 'uncleared'))
  report('write-uncleared', per)
}, 1200000)

it('window: write, cleared (dup shape)', async () => {
  const per: number[] = []
  for (let i = 0; i < SEEDS; i++) per.push(await once(async (f) => { writeFileSync(f, String(i)) }, 'cleared'))
  report('write-cleared', per)
}, 1200000)

it('window: atomic rename, uncleared (10k shape)', async () => {
  const per: number[] = []
  for (let i = 0; i < SEEDS; i++) per.push(await once(async (f, d) => {
    writeFileSync(join(d, 'tmp.txt'), String(i))
    renameSync(join(d, 'tmp.txt'), f)
  }, 'uncleared'))
  report('rename-uncleared', per)
}, 1200000)

it('window: atomic rename, cleared (dup shape)', async () => {
  const per: number[] = []
  for (let i = 0; i < SEEDS; i++) per.push(await once(async (f, d) => {
    writeFileSync(join(d, 'tmp.txt'), String(i))
    renameSync(join(d, 'tmp.txt'), f)
  }, 'cleared'))
  report('rename-cleared', per)
}, 1200000)
