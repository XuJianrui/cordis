// 302 的副作用：60ms hold 每次 change 都重启计时器。
// 若文件被持续写（间隔 < 60ms），计时器可能永远重启 → 消费者收不到任何事件（starvation）。
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, '__starve__')
const CHILD = join(WORK, 'child.cjs')
const CHOKIDAR = JSON.parse(readFileSync(new URL('../../../node_modules/chokidar/package.json', import.meta.url), 'utf8')).version
const ROUNDS = Number(process.env.ST_ROUNDS || 5)
// HOLD=0 表示不加 hold（main 行为）；>0 表示复刻 302
const HOLD = Number(process.env.HOLD_MS || 60)

const SRC = String.raw`
const fs = require('node:fs')
const path = require('node:path')
let watch
const [dir, out, holdArg] = process.argv.slice(2)
const HOLD = Number(holdArg)
const res = { outcome: '-', err: '-' }
const done = () => { fs.writeFileSync(out, JSON.stringify(res)); process.exit(0) }
process.on('uncaughtException', (e) => { res.err = 'throw=' + (e.code || e.message); done() })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 三种持续写入节奏：比 hold 慢 / 接近 / 比 hold 快
async function run(gapMs, round) {
  const root = path.join(dir, 'g' + gapMs + '-' + round + '-' + Math.random().toString(36).slice(2))
  const sub = path.join(root, 'd0')
  fs.mkdirSync(sub, { recursive: true })
  const target = path.join(sub, 'f0.ts')
  fs.writeFileSync(target, 'v0')

  let delivered = 0
  const settle = new Map()
  const w = watch(root, { ignoreInitial: true })
  w.on('change', (p) => {
    if (path.basename(p) !== 'f0.ts') return
    if (HOLD <= 0) { delivered++; return }
    // 复刻 302：每次 change 重启计时器
    const prev = settle.get(p)
    if (prev) clearTimeout(prev)
    settle.set(p, setTimeout(() => { settle.delete(p); delivered++ }, HOLD))
  })
  await new Promise((r) => w.on('ready', () => r()))
  await sleep(400)

  delivered = 0
  // 持续写 2 秒
  const t0 = Date.now()
  while (Date.now() - t0 < 2000) {
    fs.writeFileSync(target, 'v' + Date.now())
    await sleep(gapMs)
  }
  // 停止写之后等 800ms 看是否补发
  await sleep(800)
  const afterStop = delivered
  for (const t of settle.values()) clearTimeout(t)
  settle.clear()
  w.close()
  fs.rmSync(root, { recursive: true, force: true })
  return { afterStop }
}

;(async () => {
  const mod = await import(process.env.CHOKIDAR_PATH)
  watch = mod.watch
  const rounds = Number(process.env.ST_ROUNDS) || 5
  // 只跑一个 gap，由环境变量指定，保持输出极短
  const gap = Number(process.env.ST_GAP) || 5
  let tot = 0
  for (let i = 0; i < rounds; i++) { const r = await run(gap, i); tot += r.afterStop }
  res.outcome = 'h' + HOLD + 'g' + gap + '=' + tot
  done()
})()
`

function arm(hold: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'st-'))
  const out = join(dir, 'out.json')
  const r = spawnSync(process.execPath, [CHILD, dir, out, hold], {
    timeout: 400000, killSignal: 'SIGKILL', stdio: 'ignore',
    env: { ...process.env, CHOKIDAR_PATH: new URL('../../../node_modules/chokidar/esm/index.js', import.meta.url).href, ST_ROUNDS: String(ROUNDS) },
  })
  let text = 'killed(' + (r.signal || r.status) + ')'
  if (existsSync(out)) text = JSON.parse(readFileSync(out, 'utf8')).outcome
  rmSync(dir, { recursive: true, force: true })
  return text
}

const CASES: [number, number][] = [[0, 5], [60, 5], [0, 20], [60, 20], [0, 100], [60, 100]]
for (const [hold, gap] of CASES) {
  describe('hold ' + hold + ' gap ' + gap, () => {
    it('counts deliveries', () => {
      rmSync(WORK, { recursive: true, force: true })
      mkdirSync(WORK, { recursive: true })
      writeFileSync(CHILD, SRC)
      const dir = mkdtempSync(join(tmpdir(), 'st-'))
      const out = join(dir, 'out.json')
      const r = spawnSync(process.execPath, [CHILD, dir, out, String(hold)], {
        timeout: 400000, killSignal: 'SIGKILL', stdio: 'ignore',
        env: { ...process.env, CHOKIDAR_PATH: new URL('../../../node_modules/chokidar/esm/index.js', import.meta.url).href, ST_ROUNDS: String(ROUNDS), ST_GAP: String(gap) },
      })
      let text = 'killed'
      if (existsSync(out)) text = JSON.parse(readFileSync(out, 'utf8')).outcome
      console.log('@@ST platform=' + process.platform + ' chokidar=' + CHOKIDAR + ' ' + text)
      rmSync(dir, { recursive: true, force: true })
      rmSync(WORK, { recursive: true, force: true })
      expect(text).toBe('__always_fails__')
    }, 450000)
  })
}
