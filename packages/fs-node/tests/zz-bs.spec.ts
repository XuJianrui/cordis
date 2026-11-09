// 更好的方案：不打点内部，改为验证一个可证伪的预测。
//
// 源码确定：handleEvent 先 listener(path)，再对子项 fsWatchBroadcast → 同一 listener 被调两次；
// listener 首行 _throttle(file, 5) 本应拦住第二次，但它随后 await stat(file)。
// 突发时并发 stat 排队 → 第二次调用被推迟到 5ms 之外 → 节流失效。
// 预测：**突发规模越大，额外事件越多**。
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, '__burstscale__')
const CHILD = join(WORK, 'child.cjs')
const CHOKIDAR = JSON.parse(readFileSync(new URL('../../../node_modules/chokidar/package.json', import.meta.url), 'utf8')).version
const ROUNDS = Number(process.env.BS_ROUNDS || 6)

const SRC = String.raw`
const fs = require('node:fs')
const path = require('node:path')
let watch
const [dir, out, roundsArg] = process.argv.slice(2)
const res = { outcome: '-', err: '-' }
const done = () => { fs.writeFileSync(out, JSON.stringify(res)); process.exit(0) }
process.on('uncaughtException', (e) => { res.err = 'throw=' + (e.code || e.message); done() })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 三种突发规模，同样的总写入次数（=48），只是每批的并发文件数不同
async function run(batch, round) {
  const root = path.join(dir, 'b' + batch + '-' + round + '-' + Math.random().toString(36).slice(2))
  const files = []
  for (let d = 0; d < 48; d++) {
    const sub = path.join(root, 'd' + d)
    fs.mkdirSync(sub, { recursive: true })
    const p = path.join(sub, 'f0.ts')
    fs.writeFileSync(p, 'v0')
    files.push(p)
  }
  let extra = 0
  const per = new Map()
  const w = watch(root, { ignoreInitial: true })
  w.on('change', (p) => {
    const k = path.relative(root, p)
    const n = (per.get(k) || 0) + 1
    per.set(k, n)
    if (n > 1) extra++
  })
  await new Promise((r) => w.on('ready', () => r()))
  await sleep(400)

  per.clear(); extra = 0
  for (let i = 0; i < files.length; i++) {
    fs.writeFileSync(files[i], 'v1')
    // batch = 1 时每个之间让出事件循环；batch 大时几乎不让出
    if (batch === 1) await sleep(10)
    else if ((i + 1) % batch === 0) await sleep(5)
  }
  await sleep(1200)
  w.close()
  let paths = 0
  for (const [, n] of per) if (n >= 1) paths++
  fs.rmSync(root, { recursive: true, force: true })
  return { extra, paths, delivered: [...per.values()].reduce((a, b) => a + b, 0) }
}

;(async () => {
  const mod = await import(process.env.CHOKIDAR_PATH)
  watch = mod.watch
  const rounds = Number(roundsArg) || 6
  const out2 = []
  for (const batch of [1, 8, 48]) {
    let e = 0, d = 0
    for (let i = 0; i < rounds; i++) { const r = await run(batch, i); e += r.extra; d += r.delivered }
    out2.push('batch' + batch + ':extra=' + e + '/delivered=' + d + ' of ' + (rounds * 48) + 'writes')
  }
  res.outcome = out2.join(' ')
  done()
})()
`

describe('does duplicate grow with burst size', () => {
  it('same 48 writes, three concurrency levels', () => {
    rmSync(WORK, { recursive: true, force: true })
    mkdirSync(WORK, { recursive: true })
    writeFileSync(CHILD, SRC)
    const dir = mkdtempSync(join(tmpdir(), 'bs-'))
    const out = join(dir, 'out.json')
    const r = spawnSync(process.execPath, [CHILD, dir, out, String(ROUNDS)], {
      timeout: 420000, killSignal: 'SIGKILL', stdio: 'ignore',
      env: { ...process.env, CHOKIDAR_PATH: new URL('../../../node_modules/chokidar/esm/index.js', import.meta.url).href },
    })
    let text = 'killed(' + (r.signal || r.status) + ')'
    if (existsSync(out)) text = JSON.parse(readFileSync(out, 'utf8')).outcome
    console.log('@@BS platform=' + process.platform + ' chokidar=' + CHOKIDAR + ' ' + text)
    rmSync(dir, { recursive: true, force: true })
    rmSync(WORK, { recursive: true, force: true })
    expect(text).toBe('__always_fails__')
  }, 480000)
})
