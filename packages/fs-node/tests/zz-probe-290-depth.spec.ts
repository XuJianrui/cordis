/* eslint-disable */
// If an extra directory level is what separates 95% from 52%, the real case should
// stop failing when its tree gains one.
//
// The depth arm reads 95% while the flat layout reads 52%, with base, cleanup
// scope, round count and arm order all held equal. watch.spec.ts uses the flat
// layout (`fixture/relinked/root`) and fails about half the time on macOS - the
// same number. So the prediction is direct and falsifiable:
//
//   same case, watched directory one level deeper   -> should stop failing
//   same case, current depth                        -> should keep failing
//
// Both run here, alternating, so the comparison is inside one run. Nothing else
// differs: same filter, same touch budget, same replace step, same cleanup target.
import { describe, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Context, Fiber } from 'cordis'
import Fs from '../src/index.ts'

const ROUNDS = 8
const BLOCKS = 6

async function attempt(deeper: boolean) {
  const base = mkdtempSync(join(tmpdir(), 'depth290-'))
  const root = deeper ? join(base, 'level') : base
  const target = join(root, 'relinked/target/file.ts')
  const link = join(root, 'relinked/root/linked')
  mkdirSync(dirname(target), { recursive: true })
  mkdirSync(dirname(link), { recursive: true })
  writeFileSync(target, 'v0')
  writeFileSync(link, 'v0')

  const ctx = new Context()
  const fiber: Fiber<Context> = await ctx.plugin(Fs)
  const seen: string[] = []
  const w = ctx.fs.watch(dirname(link), { filter: ['linked/**/*.ts'] })
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
  rmSync(join(root, 'relinked'), { recursive: true, force: true })
  rmSync(base, { recursive: true, force: true })
  return ok
}

describe('290 does depth explain the real case', () => {
  it('same case, one level deeper, alternating', async () => {
    const out: Record<string, string[]> = { flat: [], deeper: [] }
    for (let b = 0; b < BLOCKS; b++) {
      // alternate which goes first so neither always leads a block
      const order = b % 2 === 0 ? [false, true] : [true, false]
      for (const deeper of order) {
        let pass = 0
        for (let i = 0; i < ROUNDS; i++) if (await attempt(deeper)) pass++
        out[deeper ? 'deeper' : 'flat'].push(`${pass}/${ROUNDS}`)
      }
    }
    console.log('PROBE_290_DEPTH =', JSON.stringify({ platform: process.platform, out }))
  }, 880_000)
})
