// 质疑问题准确性：突发重复是否影响任何真实消费者？
// 16 个文件同时写 → 可能多报事件。但 include 只看一个配置文件，hmr 有 debounce+重读。
// 若两者都不受影响，这个现象就该降级为「观察到但无消费者影响」。
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, '__burstimpact__')
const CHILD = join(WORK, 'child.ts')
const ROUNDS = Number(process.env.BI_ROUNDS || 5)

const SRC = String.raw`
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Hmr from '@cordisjs/plugin-hmr'
import Fs from '@cordisjs/plugin-fs-node'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [dir, out, roundsArg] = process.argv.slice(2)
const res: Record<string, unknown> = { outcome: '-', err: '-' }
const done = () => { writeFileSync(out, JSON.stringify(res)); process.exit(0) }
process.on('uncaughtException', (e: any) => { res.err = 'throw=' + (e.code || e.message); done() })
process.on('unhandledRejection', (e: any) => { res.err = 'reject=' + (e?.code || e?.message); done() })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const NL = String.fromCharCode(10)
const yml = (n: string) => Array.from({ length: n }, (_, i) => '- id: p' + i + NL + '  name: ./noop.ts').join(NL) + NL

// 突发：16 个配置项一起写（等价于一次大改），看 include 会不会重复 refresh 或漏项
async function includeBurst(i: number) {
  const home = join(dir, 'i' + i + '-' + Math.random().toString(36).slice(2))
  mkdirSync(home, { recursive: true })
  const file = join(home, 'cordis.yml')
  writeFileSync(file, yml(2))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(home + '/').href
  const fiber = await ctx.plugin(Loader, { baseUrl: pathToFileURL(home + '/').href })
  await ctx.plugin(Fs)
  const id = await ctx.loader.create({ name: '@cordisjs/plugin-include', config: { path: file, watch: true } })
  await ctx.loader.store[id].innerFiber.await()
  const include: any = ctx.loader.store[id].subtree
  await sleep(700)
  let refreshes = 0
  const orig = include.refresh.bind(include)
  include.refresh = (...a: any[]) => { refreshes++; return orig(...a) }
  refreshes = 0

  // 一个文件写 16 次（模拟大改），间隔 0
  for (let k = 0; k < 16; k++) writeFileSync(file, yml(2 + k + 1))
  await sleep(2500)
  const keys = Object.keys((ctx.loader.store[id] && ctx.loader.store[id].subtree && ctx.loader.store[id].subtree.store) || {})
  const finalOk = keys.includes('p17')
  const r = { refreshes, finalOk, count: keys.length }
  await fiber.dispose()
  rmSync(home, { recursive: true, force: true })
  return r
}

// hmr：16 个模块一起改，看最终是否全部加载最新
async function hmrBurst(i: number) {
  const home = join(dir, 'h' + i + '-' + Math.random().toString(36).slice(2))
  const src = join(home, 'src')
  mkdirSync(src, { recursive: true })
  const mods: string[] = []
  for (let k = 0; k < 16; k++) { const p = join(src, 'm' + k + '.ts'); writeFileSync(p, 'export const v = 0' + NL); mods.push(p) }
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(home + '/').href
  await ctx.plugin(Fs)
  await ctx.plugin(Hmr, { root: ['.'], watch: { enabled: true, files: ['.', '!**/node_modules', '!**/.*'] } })
  for (const p of mods) await import(pathToFileURL(p).href)
  await sleep(900)
  for (const p of mods) writeFileSync(p, 'export const v = 9' + NL)
  await sleep(2500)
  let ok = 0
  for (const p of mods) {
    try { const m: any = await import(pathToFileURL(p).href + '?r=' + Math.random()); if (m.v === 9) ok++ } catch {}
  }
  await (ctx as any).fiber.dispose()
  rmSync(home, { recursive: true, force: true })
  return { ok, total: 16 }
}

const rounds = Number(roundsArg) || 5
let inclRefresh = 0, inclOk = 0
for (let i = 0; i < rounds; i++) { const r = await includeBurst(i); inclRefresh += r.refreshes; if (r.finalOk) inclOk++ }
let hmrOk = 0
for (let i = 0; i < rounds; i++) { const r = await hmrBurst(i); hmrOk += r.ok }
res.outcome = 'n=' + rounds + ' include{refreshTotal=' + inclRefresh + ',finalOk=' + inclOk + '/' + rounds + '} hmr{loaded=' + hmrOk + '/' + (rounds * 16) + '}'
done()
`

describe('does the burst duplicate reach a real consumer', () => {
  it('16 writes into one config, and 16 modules at once', () => {
    rmSync(WORK, { recursive: true, force: true })
    mkdirSync(WORK, { recursive: true })
    writeFileSync(CHILD, SRC)
    const dir = mkdtempSync(join(tmpdir(), 'bi-'))
    const out = join(dir, 'out.json')
    const r = spawnSync(process.execPath, ['--expose-internals', '--import', 'tsx', CHILD, dir, out, String(ROUNDS)], {
      timeout: 480000, killSignal: 'SIGKILL', stdio: 'ignore', cwd: WORK,
    })
    let text = 'killed(' + (r.signal || r.status) + ')'
    if (existsSync(out)) text = JSON.parse(readFileSync(out, 'utf8')).outcome
    console.log('@@BI platform=' + process.platform + ' ' + text)
    rmSync(dir, { recursive: true, force: true })
    rmSync(WORK, { recursive: true, force: true })
    expect(text).toBe('__always_fails__')
  }, 540000)
})
