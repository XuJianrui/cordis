/* eslint-disable */
// Depth, or just a longer path?
//
// One extra directory level took the case from 48% to 94% on both macOS cells,
// with cleanup scope, arm order, base and budget all equal. But "extra level"
// also means "six more characters", and I have been wrong about a confound on
// this issue often enough to spend one run on it.
//
// Three shapes, same base, same cleanup, same everything else:
//
//   flat      tmp/<base>/relinked/root                  the current test
//   deeper    tmp/<base>/level/relinked/root            one level, +6 chars
//   longname  tmp/<base>/relinked_long/root             same depth, +6 chars
//
// flat vs deeper isolates depth. flat vs longname isolates length at the same
// depth. If longname also passes, length explains it and depth does not. If only
// deeper passes, depth is the mechanism.
import { describe, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Context, Fiber } from 'cordis'
import Fs from '../src/index.ts'

const ROUNDS = 8
const BLOCKS = 6

type Shape = 'flat' | 'deeper' | 'longname'

function layout(base: string, shape: Shape) {
  if (shape === 'deeper') return join(base, 'level')
  return base
}

async function attempt(shape: Shape) {
  const base = mkdtempSync(join(tmpdir(), 'shp290-'))
  const root = layout(base, shape)
  const mid = shape === 'longname' ? 'relinked_long' : 'relinked'
  const watchDir = join(root, mid, 'root')
  const target = join(root, mid, 'target/file.ts')
  const link = join(watchDir, 'linked')
  mkdirSync(dirname(target), { recursive: true })
  mkdirSync(watchDir, { recursive: true })
  writeFileSync(target, 'v0')
  writeFileSync(link, 'v0')

  const ctx = new Context()
  const fiber: Fiber<Context> = await ctx.plugin(Fs)
  const seen: string[] = []
  const w = ctx.fs.watch(watchDir, { filter: ['linked/**/*.ts'] })
  w.on('change', (p: string) => seen.push(p))
  await new Promise<void>((r) => w.on('ready', r))
  rmSync(link)
  symlinkSync(dirname(target), link, 'junction')

  let exhausted = true
  for (let i = 0; i < 80; i++) {
    if (seen.length > 0) { exhausted = false; break }
    writeFileSync(target, `v${i}`)
    await new Promise(r => setTimeout(r, 100))
  }
  const got = [...new Set(seen)]
  const want = resolve(link, 'file.ts')
  const ok = !exhausted && got.length === 1 && resolve(got[0]) === want
  await w.dispose()
  await fiber.dispose()
  rmSync(base, { recursive: true, force: true })
  return ok
}

describe('290 depth or length', () => {
  it('three shapes, rotating', async () => {
    const shapes: Shape[] = ['flat', 'deeper', 'longname']
    const out: Record<string, string[]> = { flat: [], deeper: [], longname: [] }
    for (let b = 0; b < BLOCKS; b++) {
      const rotated = [...shapes.slice(b % 3), ...shapes.slice(0, b % 3)]
      for (const s of rotated) {
        let pass = 0
        for (let i = 0; i < ROUNDS; i++) if (await attempt(s)) pass++
        out[s].push(`${pass}/${ROUNDS}`)
      }
    }
    console.log('PROBE_290_SHAPE =', JSON.stringify({ platform: process.platform, out }))
  }, 880_000)
})
