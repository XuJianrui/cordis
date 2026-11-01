/* eslint-disable */
// Decides whether the "deleteSeen: 1" seen in the 10k run is a real delete
// event or a LATE rename event that fell into the next window.
//
// The 10k run had renameMiss:1 and deleteSeen:1 in the SAME shard (7000 and
// 8000 on ubuntu-26, offset 0 on windows-26). If the delete event were real,
// lengthening the settle after the rename would not remove it. If it is a late
// rename event, a longer settle moves it back into the rename window and both
// counters return to 0.
//
// This also demonstrates decision 7a directly: the driver callback carries a
// path and no kind, so a late `change` and a real `unlink` are the same value
// at the driver level and can only be told apart by timing.
import { Context } from 'cordis'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import Fs from '../src/index.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SEEDS = Number(process.env.PROBE262_SEEDS || 100)
const SETTLE = Number(process.env.PROBE262_SETTLE || 200)

async function run(settle: number) {
  const root = mkdtempSync(join(tmpdir(), 'late262-'))
  const a = join(root, 'a')
  mkdirSync(a)
  const file = join(a, 'watched.txt')
  writeFileSync(file, '0')
  const ctx = new Context()
  const fiber = await ctx.plugin(Fs)
  const ev: string[] = []
  const stop = await ctx.fs.watch(file, (p: any) => ev.push(String(p)))
  await sleep(300)

  let writeMiss = 0, renameMiss = 0, deleteSeen = 0
  const lateByMs: number[] = []
  for (let i = 0; i < SEEDS; i++) {
    // write
    ev.length = 0
    writeFileSync(file, String(i))
    await sleep(settle)
    if (ev.length === 0) writeMiss++

    // rename onto the watched path
    ev.length = 0
    writeFileSync(join(a, 'tmp.txt'), 'r')
    renameSync(join(a, 'tmp.txt'), file)
    await sleep(settle)
    if (ev.length === 0) {
      renameMiss++
      // how much longer does it take? poll up to 3s
      const t0 = Date.now()
      while (Date.now() - t0 < 3000 && ev.length === 0) await sleep(25)
      if (ev.length > 0) lateByMs.push(Date.now() - t0)
    }

    // delete
    ev.length = 0
    rmSync(file, { force: true })
    await sleep(settle)
    if (ev.length > 0) deleteSeen++
    writeFileSync(file, '0')
    await sleep(120)
  }
  await stop()
  await fiber.dispose()
  rmSync(root, { recursive: true, force: true })
  return {
    settle, seeds: SEEDS, platform: process.platform, node: process.version,
    writeMiss, renameMiss, deleteSeen,
    lateRecovered: lateByMs.length,
    lateMs: lateByMs.slice(0, 20),
  }
}

it('late 262: settle 200ms (same as 10k harness)', async () => {
  const r = await run(200)
  console.log('PROBE262_LATE ' + JSON.stringify(r))
}, 1200000)

it('late 262: settle 600ms', async () => {
  const r = await run(600)
  console.log('PROBE262_LATE ' + JSON.stringify(r))
}, 1200000)

it('late 262: settle 50ms (stress the window)', async () => {
  const r = await run(50)
  console.log('PROBE262_LATE ' + JSON.stringify(r))
}, 1200000)
