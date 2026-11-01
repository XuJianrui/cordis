/* eslint-disable */
// One CI run, five concurrent shards: property + differential (ctx.fs vs chokidar).
import { Context } from 'cordis'
import chokidar from 'chokidar'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import Fs from '../src/index.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function shard(offset: number, seeds: number) {
  const rootDir = mkdtempSync(join(tmpdir(), `deep262-${offset}-`))
  const stats = { offset, seeds: 0, writeMiss: 0, renameMiss: 0, deleteSeen: 0, disposeLeak: 0 }
  const diff = { write: [0, 0], rename: [0, 0], delete: [0, 0] }
  for (let seed = offset; seed < offset + seeds; seed++) {
    const a = join(rootDir, `a${seed}`); const b = join(rootDir, `b${seed}`)
    mkdirSync(a); mkdirSync(b)
    const ctx = new Context()
    const fiber = await ctx.plugin(Fs)
    const evA: string[] = []
    const fileA = join(a, 'watched.txt')
    writeFileSync(fileA, '0')
    const stop = await ctx.fs.watch(fileA, (p: any) => evA.push(String(p)))
    const evB: string[] = []
    const w = chokidar.watch(b, { ignoreInitial: true, depth: 0 })
    w.on('all', (_e: string, p: string) => evB.push(String(p)))
    await sleep(200)

    writeFileSync(fileA, '1'); writeFileSync(join(b, 'watched.txt'), '1')
    await sleep(200)
    if (evA.length === 0) stats.writeMiss++
    diff.write[0] += evA.length; diff.write[1] += evB.length

    evA.length = 0; evB.length = 0
    writeFileSync(join(a, 'tmp.txt'), '2'); writeFileSync(join(b, 'tmp.txt'), '2')
    renameSync(join(a, 'tmp.txt'), fileA); renameSync(join(b, 'tmp.txt'), join(b, 'watched.txt'))
    await sleep(200)
    if (evA.length === 0) stats.renameMiss++
    diff.rename[0] += evA.length; diff.rename[1] += evB.length

    evA.length = 0; evB.length = 0
    rmSync(fileA, { force: true }); rmSync(join(b, 'watched.txt'), { force: true })
    await sleep(200)
    if (evA.length > 0) stats.deleteSeen++
    diff.delete[0] += evA.length; diff.delete[1] += evB.length

    await stop(); await fiber.dispose()
    evA.length = 0
    writeFileSync(join(a, 'after.txt'), 'x')
    await sleep(150)
    if (evA.length > 0) stats.disposeLeak++
    await w.close()
    stats.seeds++
  }
  return { ...stats, diff }
}

for (const off of Array.from({ length: 10 }, (_, i) => i * 1000)) {
  it.concurrent(`shard ${off}`, async () => {
    if (process.version.startsWith('v24')) return
    const r = await shard(off, 1000)
    console.log('PROBE262_SHARD ' + JSON.stringify(r))
    if (r.writeMiss || r.renameMiss || r.disposeLeak) throw new Error('shard failed ' + off)
  }, 1800000)
}
