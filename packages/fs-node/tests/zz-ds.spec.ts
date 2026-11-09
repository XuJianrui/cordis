// D 形态（maxWait）在真实实现上的连续写行为 —— 不复制逻辑，直接走 ctx.fs.watch。
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, '__dstarve__')
const CHILD = join(WORK, 'child.ts')
const ROUNDS = Number(process.env.DS_ROUNDS || 4)
const GAP = Number(process.env.DS_GAP || 5)

const SRC = String.raw`
import { Context } from 'cordis'
import Fs from '@cordisjs/plugin-fs-node'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [dir, out, roundsArg] = process.argv.slice(2)
const GAP = Number(process.env.DS_GAP) || 5
const res: Record<string, unknown> = { outcome: '-', err: '-' }
const done = () => { writeFileSync(out, JSON.stringify(res)); process.exit(0) }
process.on('uncaughtException', (e: any) => { res.err = 'throw=' + (e.code || e.message); done() })
process.on('unhandledRejection', (e: any) => { res.err = 'reject=' + (e?.code || e?.message); done() })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function round(i: number) {
  const home = join(dir, 'd' + i + '-' + Math.random().toString(36).slice(2))
  mkdirSync(home, { recursive: true })
  const target = join(home, 'a.ts')
  writeFileSync(target, 'v0')
  const ctx = new Context()
  ctx.baseUrl = 'file://' + home + '/'
  await ctx.plugin(Fs)
  let n = 0
  const w = ctx.fs.watch(target)
  w.on('change', () => { n++ })
  await new Promise<void>((r) => w.on('ready', () => r()))
  await sleep(500)
  n = 0
  const t0 = Date.now()
  while (Date.now() - t0 < 2000) {
    writeFileSync(target, 'v' + Date.now())
    await sleep(GAP)
  }
  await sleep(900)
  const delivered = n
  await (w as any).dispose?.()
  await ctx.fiber.dispose()
  rmSync(home, { recursive: true, force: true })
  return delivered
}

const rounds = Number(roundsArg) || 4
let tot = 0
for (let i = 0; i < rounds; i++) tot += await round(i)
res.outcome = 'gap' + GAP + ' delivered=' + tot + '/' + rounds
done()
`

describe('maxWait under continuous writes, real implementation', () => {
  it('counts deliveries through ctx.fs.watch', () => {
    rmSync(WORK, { recursive: true, force: true })
    mkdirSync(WORK, { recursive: true })
    writeFileSync(CHILD, SRC)
    const dir = mkdtempSync(join(tmpdir(), 'ds-'))
    const out = join(dir, 'out.json')
    const r = spawnSync(process.execPath, ['--import', 'tsx', CHILD, dir, out, String(ROUNDS)], {
      timeout: 400000, killSignal: 'SIGKILL', stdio: 'ignore', cwd: WORK,
      env: { ...process.env, DS_GAP: String(GAP) },
    })
    let text = 'killed(' + (r.signal || r.status) + ')'
    if (existsSync(out)) text = JSON.parse(readFileSync(out, 'utf8')).outcome
    console.log('@@DS ' + text)
    rmSync(dir, { recursive: true, force: true })
    rmSync(WORK, { recursive: true, force: true })
    expect(text).toBe('__always_fails__')
  }, 480000)
})
