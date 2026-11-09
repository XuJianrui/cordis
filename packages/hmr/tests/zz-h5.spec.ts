// hmr 的 debounce 默认 100ms > chokidar 的 50ms 窗口 → 理论上已免疫。
// 实测：两次写间隔 10ms，hmr 是否加载到最终版本。
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, '__hmr50__')
const CHILD = join(WORK, 'child.ts')
const ROUNDS = Number(process.env.H5_ROUNDS || 6)

const SRC = String.raw`
import { Context } from 'cordis'
import Fs from '@cordisjs/plugin-fs-node'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [dir, out, roundsArg] = process.argv.slice(2)
const res = { outcome: '-', err: '-' }
const done = () => { writeFileSync(out, JSON.stringify(res)); process.exit(0) }
process.on('uncaughtException', (e) => { res.err = 'throw=' + (e.code || e.message); done() })
process.on('unhandledRejection', (e) => { res.err = 'reject=' + (e && (e.code || e.message)); done() })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// hmr 的合并机制：debounce 内把 change 收进 Set，窗口结束后统一 flush。
// 这里复刻它的两个要素，只问一件事：50ms 丢写会不会让 flush 的文件集缺项。
async function round(i, debounce) {
  const home = join(dir, 'd' + debounce + '-' + i + '-' + Math.random().toString(36).slice(2))
  mkdirSync(home, { recursive: true })
  const mod = join(home, 'm.ts')
  writeFileSync(mod, 'v0')

  const ctx = new Context()
  ctx.baseUrl = 'file://' + home + '/'
  await ctx.plugin(Fs)
  const stashed = new Set()
  let flushes = 0
  let timer
  const w = ctx.fs.watch(home)
  w.on('change', (f) => {
    stashed.add(f)
    clearTimeout(timer)
    timer = setTimeout(() => { flushes++; stashed.clear() }, debounce)
  })
  await new Promise((r) => w.on('ready', () => r()))
  await sleep(400)

  stashed.clear(); flushes = 0
  writeFileSync(mod, 'v1')
  await sleep(10)
  writeFileSync(mod, 'v2')
  await sleep(debounce + 800)

  const flushed = flushes
  await (w as any).dispose?.()
  await ctx.fiber.dispose()
  rmSync(home, { recursive: true, force: true })
  return flushed
}

const rounds = Number(roundsArg) || 6
const out2 = []
for (const debounce of [0, 100]) {
  let total = 0
  for (let i = 0; i < rounds; i++) total += await round(i, debounce)
  out2.push('debounce' + debounce + ':flushes=' + total + '/' + rounds)
}
res.outcome = 'n=' + rounds + ' ' + out2.join(' ')
done()
`

describe('does hmr already absorb the 50 ms window', () => {
  it('two writes 10 ms apart, hmr default debounce', () => {
    rmSync(WORK, { recursive: true, force: true })
    mkdirSync(WORK, { recursive: true })
    writeFileSync(CHILD, SRC)
    const dir = mkdtempSync(join(tmpdir(), 'h5-'))
    const out = join(dir, 'out.json')
    const r = spawnSync(process.execPath, ['--import', 'tsx', CHILD, dir, out, String(ROUNDS)], {
      timeout: 480000, killSignal: 'SIGKILL', encoding: 'utf8', cwd: WORK,
    })
    let text = 'killed(' + (r.signal || r.status) + ') ' + String(r.stderr||'').slice(-300).replace(/\s+/g,' ')
    if (existsSync(out)) text = JSON.parse(readFileSync(out, 'utf8')).outcome
    console.log('@@H5 platform=' + process.platform + ' node=' + process.version.slice(1) + ' ' + text)
    rmSync(dir, { recursive: true, force: true })
    rmSync(WORK, { recursive: true, force: true })
    expect(text).toBe('__always_fails__')
  }, 540000)
})
