// 消费者自愈：不改驱动，只让 include 自己定期核对 mtime。
// 若可行，这就是「不需要 owner 决策」的修法：不改变任何接口、默认行为不变。
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, '__heal__')
const CHILD = join(WORK, 'child.ts')
const CHOKIDAR = JSON.parse(readFileSync(new URL('../../../node_modules/chokidar/package.json', import.meta.url), 'utf8')).version
const ROUNDS = Number(process.env.HL_ROUNDS || 8)

const SRC = String.raw`
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Fs from '@cordisjs/plugin-fs-node'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [dir, out, roundsArg] = process.argv.slice(2)
const res: Record<string, unknown> = { outcome: '-', err: '-' }
const done = () => { writeFileSync(out, JSON.stringify(res)); process.exit(0) }
process.on('uncaughtException', (e: any) => { res.err = 'throw=' + (e.code || e.message); done() })
process.on('unhandledRejection', (e: any) => { res.err = 'reject=' + (e?.code || e?.message); done() })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const NL = String.fromCharCode(10)
const yml = (tag: string) => '- id: ' + tag + NL + '  name: ./noop.ts' + NL

async function round(mode: string, i: number, period = 0) {
  const home = join(dir, mode + '-' + i + '-' + Math.random().toString(36).slice(2))
  mkdirSync(home, { recursive: true })
  const file = join(home, 'cordis.yml')
  writeFileSync(file, yml('before'))

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(home + '/').href
  const fiber = await ctx.plugin(Loader, { baseUrl: pathToFileURL(home + '/').href })
  await ctx.plugin(Fs)
  const id = await ctx.loader.create({ name: '@cordisjs/plugin-include', config: { path: file, watch: true } })
  await ctx.loader.store[id].innerFiber.await()
  const include: any = ctx.loader.store[id].subtree
  await sleep(600)

  // 消费者自愈：只在消费者侧做，不动驱动。定期核对 mtime，变了就 refresh。
  if (mode === 'trail') {
    // 事件触发：收到 change 就 refresh（立刻），再在窗口之后 refresh 一次。
    // 不发任何额外事件，只调 refresh；refresh 内容相同会提前返回。
    const w = ctx.fs.watch(file)
    w.on('change', () => {
      include.refresh()
      setTimeout(() => include.refresh(), 60)
    })
    ctx.effect(() => () => w.close())
  }
  if (mode.startsWith('heal')) {
    let last = statSync(file).mtimeMs
    const t = setInterval(() => {
      let now = 0
      try { now = statSync(file).mtimeMs } catch { return }
      if (now !== last) { last = now; include.refresh() }
    }, period)
    ctx.effect(() => () => clearInterval(t))
  }

  // 两次真实写，间隔 10ms —— 落在 chokidar 的 50ms 窗口内
  writeFileSync(file, yml('first'))
  await sleep(10)
  writeFileSync(file, yml('second'))
  await sleep(2200)

  // 记录 refresh 被调用次数：若 trail 引发反馈环，这个数会远大于 2
  let served = 'none'
  try {
    const keys = Object.keys((ctx.loader.store[id] && ctx.loader.store[id].subtree && ctx.loader.store[id].subtree.store) || {})
    served = keys.includes('second') ? 'second' : keys.includes('first') ? 'first' : keys.includes('before') ? 'before' : 'other'
  } catch {}
  await fiber.dispose()
  rmSync(home, { recursive: true, force: true })
  return served
}

const rounds = Number(roundsArg) || 8
const tally: Record<string, Record<string, number>> = {}
const arms: [string, number][] = [['asis', 0], ['heal300', 300], ['trail', 0]]
for (const [mode, period] of arms) {
  tally[mode] = {}
  for (let i = 0; i < rounds; i++) {
    const s = await round(mode, i, period)
    tally[mode][s] = (tally[mode][s] || 0) + 1
  }
}
res.outcome = 'n=' + rounds + ' ' + Object.entries(tally).map(([m, t]) => m + '{' + Object.entries(t).map(([k, v]) => k + '=' + v).join(',') + '}').join(' ')
done()
`

describe('can the consumer heal itself without touching the driver', () => {
  it('compares as-is against a periodic mtime check', () => {
    rmSync(WORK, { recursive: true, force: true })
    mkdirSync(WORK, { recursive: true })
    writeFileSync(CHILD, SRC)
    const dir = mkdtempSync(join(tmpdir(), 'hl-'))
    const out = join(dir, 'out.json')
    const r = spawnSync(process.execPath, ['--import', 'tsx', CHILD, dir, out, String(ROUNDS)], {
      timeout: 480000, killSignal: 'SIGKILL', stdio: 'ignore', cwd: WORK,
    })
    let text = 'killed(' + (r.signal || r.status) + ')'
    if (existsSync(out)) text = JSON.parse(readFileSync(out, 'utf8')).outcome
    console.log('@@HL platform=' + process.platform + ' node=' + process.version.slice(1) + ' chokidar=' + CHOKIDAR + ' ' + text)
    rmSync(dir, { recursive: true, force: true })
    rmSync(WORK, { recursive: true, force: true })
    expect('chokidar=' + CHOKIDAR + ' ' + text).toBe('__always_fails__')
  }, 540000)
})
