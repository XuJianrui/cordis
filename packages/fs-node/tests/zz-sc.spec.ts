// 规模：N 个文件各改一次时，stat 前置复查的总开销。
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, '__scale__')
const CHILD = join(WORK, 'child.cjs')

const SRC = String.raw`
const fs = require('node:fs')
const path = require('node:path')
let watch
const [dir, out] = process.argv.slice(2)
const res = { outcome: '-', err: '-' }
const done = () => { fs.writeFileSync(out, JSON.stringify(res)); process.exit(0) }
process.on('uncaughtException', (e) => { res.err = 'throw=' + (e.code || e.message); done() })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run(n) {
  const root = path.join(dir, 's' + n + '-' + Math.random().toString(36).slice(2))
  const sub = path.join(root, 'd0')
  fs.mkdirSync(sub, { recursive: true })
  const files = []
  for (let i = 0; i < n; i++) { const p = path.join(sub, 'f' + i + '.ts'); fs.writeFileSync(p, 'v0'); files.push(p) }
  let stats = 0, reads = 0
  const probe = (p) => {
    let st = 0
    try { st = fs.statSync(p).mtimeMs; stats++ } catch { return }
    // 只有 mtime 变了才读
    reads++
    try { fs.readFileSync(p, 'utf8') } catch {}
  }
  const w = watch(root, { ignoreInitial: true })
  w.on('change', (p) => { probe(p); setTimeout(() => probe(p), 60) })
  await new Promise((r) => w.on('ready', () => r()))
  await sleep(400)
  stats = 0; reads = 0
  const t0 = Date.now()
  for (const p of files) fs.writeFileSync(p, 'v1')
  await sleep(900)
  const ms = Date.now() - t0
  w.close()
  fs.rmSync(root, { recursive: true, force: true })
  return { n, stats, reads, ms }
}

;(async () => {
  const mod = await import(process.env.CHOKIDAR_PATH)
  watch = mod.watch
  const out2 = []
  for (const n of [100, 500, 1000]) {
    const r = await run(n)
    out2.push('n' + r.n + ':stat' + r.stats + '/read' + r.reads + '/' + r.ms + 'ms')
  }
  res.outcome = out2.join(' ')
  done()
})()
`

describe('cost at scale', () => {
  it('100, 500 and 1000 files changed once each', () => {
    rmSync(WORK, { recursive: true, force: true })
    mkdirSync(WORK, { recursive: true })
    writeFileSync(CHILD, SRC)
    const dir = mkdtempSync(join(tmpdir(), 'sc-'))
    const out = join(dir, 'out.json')
    const r = spawnSync(process.execPath, [CHILD, dir, out], {
      timeout: 420000, killSignal: 'SIGKILL', stdio: 'ignore',
      env: { ...process.env, CHOKIDAR_PATH: new URL('../../../node_modules/chokidar/esm/index.js', import.meta.url).href },
    })
    let text = 'killed(' + (r.signal || r.status) + ')'
    if (existsSync(out)) text = JSON.parse(readFileSync(out, 'utf8')).outcome
    console.log('@@SC platform=' + process.platform + ' ' + text)
    rmSync(dir, { recursive: true, force: true })
    rmSync(WORK, { recursive: true, force: true })
    expect(text).toBe('__always_fails__')
  }, 480000)
})
