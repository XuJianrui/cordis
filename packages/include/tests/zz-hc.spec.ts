// 事件触发复查的真实代价：每次 change 多读几次、是否触发树更新/事件。
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, '__hcost__')
const CHILD = join(WORK, 'child.ts')
const ROUNDS = Number(process.env.HCR_ROUNDS || 5)

const SRC = String.raw`
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Fs from '@cordisjs/plugin-fs-node'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

async function round(i: number) {
  const home = join(dir, 'c' + i + '-' + Math.random().toString(36).slice(2))
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

  // 计数：refresh 调用、真正改了树的次数（通过 config-update 事件）、写回次数
  let refreshes = 0
  let updates = 0
  const origRefresh = include.refresh.bind(include)
  include.refresh = (...a: any[]) => { refreshes++; return origRefresh(...a) }
  ctx.on('loader/config-update', () => { updates++ })
  await sleep(100)

  const w = ctx.fs.watch(file)
  let st = statSync(file).mtimeMs
  w.on('change', () => {
    try { st = statSync(file).mtimeMs } catch {}
    include.refresh()
    setTimeout(() => {
      // stat 前置：mtime 未变就不读，省一次 readFile
      let now = st
      try { now = statSync(file).mtimeMs } catch { return }
      if (now !== st) { st = now; include.refresh() }
    }, 60)
  })
  ctx.effect(() => () => w.close())
  refreshes = 0; updates = 0

  writeFileSync(file, yml('first'))
  await sleep(10)
  writeFileSync(file, yml('second'))
  await sleep(2000)
  // 收敛判据：稳定后再等 800ms，refresh 是否还在增长。有环会持续涨。
  const settled = refreshes
  await sleep(800)
  const after = refreshes

  const served = Object.keys((ctx.loader.store[id] && ctx.loader.store[id].subtree && ctx.loader.store[id].subtree.store) || {}).includes('second') ? 'second' : 'other'
  const r = { refreshes, updates, served, grew: after - settled }
  await fiber.dispose()
  rmSync(home, { recursive: true, force: true })
  return r
}

const rounds = Number(roundsArg) || 5
const acc = { refreshes: 0, updates: 0, second: 0, grew: 0 }
for (let i = 0; i < rounds; i++) {
  const r = await round(i)
  acc.refreshes += r.refreshes; acc.updates += r.updates; acc.grew += r.grew; if (r.served === 'second') acc.second++
}
res.outcome = 'n=' + rounds + ' refreshes=' + acc.refreshes + ' grewAfterSettle=' + acc.grew + ' servedSecond=' + acc.second
done()
`

describe('cost of the deferred re-check', () => {
  it('counts refreshes and tree updates', () => {
    rmSync(WORK, { recursive: true, force: true })
    mkdirSync(WORK, { recursive: true })
    writeFileSync(CHILD, SRC)
    const dir = mkdtempSync(join(tmpdir(), 'hcr-'))
    const out = join(dir, 'out.json')
    const r = spawnSync(process.execPath, ['--import', 'tsx', CHILD, dir, out, String(ROUNDS)], {
      timeout: 480000, killSignal: 'SIGKILL', stdio: 'ignore', cwd: WORK,
    })
    let text = 'killed(' + (r.signal || r.status) + ')'
    if (existsSync(out)) text = JSON.parse(readFileSync(out, 'utf8')).outcome
    console.log('@@HCR platform=' + process.platform + ' node=' + process.version.slice(1) + ' ' + text)
    rmSync(dir, { recursive: true, force: true })
    rmSync(WORK, { recursive: true, force: true })
    expect(text).toBe('__always_fails__')
  }, 540000)
})
