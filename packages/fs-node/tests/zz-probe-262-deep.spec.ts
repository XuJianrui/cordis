/* eslint-disable */
// D2/D3: property test (write/rename must be observed; dispose must stop) and
// a differential run against chokidar on the same operation trace.
import { Context } from 'cordis'
import chokidar from 'chokidar'
import { mkdirSync, mkdtempSync, renameSync, rmSync, watch as fswatch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import Fs from '../src/index.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

it('deep 262: property + differential', async () => {
  if (process.version.startsWith('v24')) return
  const rootDir = mkdtempSync(join(tmpdir(), 'deep262-'))
  const stats = { seeds: 0, writeMiss: 0, renameMiss: 0, deleteSeen: 0, disposeLeak: 0 }
  const diff = { write: [0, 0, 0], rename: [0, 0, 0], delete: [0, 0, 0] }
  const SEEDS = 300
  const OFFSET = 900
  for (let seed = OFFSET; seed < OFFSET + SEEDS; seed++) {
    const a = join(rootDir, `a${seed}`); const b = join(rootDir, `b${seed}`)
    mkdirSync(a); mkdirSync(b)
    const ctx = new Context()
    const fiber = await ctx.plugin(Fs)
    const evA: string[] = []
    const fileA = join(a, 'watched.txt')
    writeFileSync(fileA, '0')
    const stop = await ctx.fs.watch(fileA, (p: any) => evA.push(String(p)))
    const evRaw: string[] = []
    const rw = fswatch(fileA, () => evRaw.push('raw'))
    const evB: string[] = []
    const w = chokidar.watch(b, { ignoreInitial: true, depth: 0 })
    w.on('all', (_e: string, p: string) => evB.push(String(p)))
    await sleep(250)

    writeFileSync(fileA, '1'); writeFileSync(join(b, 'watched.txt'), '1')
    await sleep(250)
    if (evA.length === 0) stats.writeMiss++
    diff.write[0] += evA.length; diff.write[1] += evB.length; diff.write[2] += evRaw.length

    evA.length = 0; evB.length = 0; evRaw.length = 0
    // rename *onto* the watched path (atomic replace), not away from it
    writeFileSync(join(a, 'tmp.txt'), '2'); writeFileSync(join(b, 'tmp.txt'), '2')
    renameSync(join(a, 'tmp.txt'), fileA); renameSync(join(b, 'tmp.txt'), join(b, 'watched.txt'))
    await sleep(250)
    if (evA.length === 0) stats.renameMiss++
    diff.rename[0] += evA.length; diff.rename[1] += evB.length; diff.rename[2] += evRaw.length

    evA.length = 0; evB.length = 0; evRaw.length = 0
    rmSync(fileA, { force: true }); rmSync(join(b, 'watched.txt'), { force: true })
    await sleep(250)
    if (evA.length > 0) stats.deleteSeen++
    diff.delete[0] += evA.length; diff.delete[1] += evB.length; diff.delete[2] += evRaw.length

    await stop(); await fiber.dispose()
    evA.length = 0
    writeFileSync(join(a, 'after.txt'), 'x')
    await sleep(200)
    if (evA.length > 0) stats.disposeLeak++
    rw.close(); await w.close()
    stats.seeds++
  }
  console.log('PROBE262_DEEP ' + JSON.stringify({ ...stats, diff }))
  if (stats.writeMiss > 0) throw new Error('write events missed: ' + stats.writeMiss)
  if (stats.renameMiss > 0) throw new Error('rename events missed: ' + stats.renameMiss)
  if (stats.disposeLeak > 0) throw new Error('events after dispose: ' + stats.disposeLeak)
}, 900000)
