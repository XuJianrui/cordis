// 质疑 302 的问题准确性：50ms 内的两次写，在真实工具里有多常见？
// 不构造 sleep，而是实测三类真实写法的实际间隔分布。
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, '__realgaps__')
const CHILD = join(WORK, 'child.cjs')

const SRC = String.raw`
const fs = require('node:fs')
const path = require('node:path')
const [dir, out] = process.argv.slice(2)
const res = { outcome: '-', err: '-' }
const done = () => { fs.writeFileSync(out, JSON.stringify(res)); process.exit(0) }
process.on('uncaughtException', (e) => { res.err = 'throw=' + (e.code || e.message); done() })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 三类真实写法的实测间隔（微秒精度）
function gapsOf(fn, n) {
  const root = path.join(dir, 'g' + Math.random().toString(36).slice(2))
  fs.mkdirSync(root, { recursive: true })
  const target = path.join(root, 'a.ts')
  fs.writeFileSync(target, 'x')
  const t = []
  fn(target, n, t)
  fs.rmSync(root, { recursive: true, force: true })
  const g = []
  for (let i = 1; i < t.length; i++) g.push(t[i] - t[i - 1])
  g.sort((a, b) => a - b)
  return g
}

// 1) 直接连写（构建器常这样）
const direct = gapsOf((p, n, t) => { for (let i = 0; i < n; i++) { fs.writeFileSync(p, 'v' + i); t.push(Number(process.hrtime.bigint() / 1000n)) } }, 20)

// 2) 临时文件 + rename（编辑器原子保存）
const atomic = gapsOf((p, n, t) => {
  for (let i = 0; i < n; i++) {
    const tmp = p + '.tmp'
    fs.writeFileSync(tmp, 'v' + i)
    fs.renameSync(tmp, p)
    t.push(Number(process.hrtime.bigint() / 1000n))
  }
}, 20)

// 3) write + fsync（更谨慎的工具）
const fsync = gapsOf((p, n, t) => {
  for (let i = 0; i < n; i++) {
    const fd = fs.openSync(p, 'w')
    fs.writeSync(fd, 'v' + i)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    t.push(Number(process.hrtime.bigint() / 1000n))
  }
}, 20)

const fmt = (g) => ({ min: g[0], median: g[Math.floor(g.length / 2)], max: g[g.length - 1], under50: g.filter(x => x < 50000).length, n: g.length })
res.outcome = 'direct=' + JSON.stringify(fmt(direct)) + ' atomic=' + JSON.stringify(fmt(atomic)) + ' fsync=' + JSON.stringify(fmt(fsync))
done()
`

describe('real write gaps in microseconds', () => {
  it('measures three realistic write patterns', () => {
    rmSync(WORK, { recursive: true, force: true })
    mkdirSync(WORK, { recursive: true })
    writeFileSync(CHILD, SRC)
    const dir = mkdtempSync(join(tmpdir(), 'rg-'))
    const out = join(dir, 'out.json')
    const r = spawnSync(process.execPath, [CHILD, dir, out], {
      timeout: 200000, killSignal: 'SIGKILL', stdio: 'ignore',
    })
    let text = 'killed(' + (r.signal || r.status) + ')'
    if (existsSync(out)) text = JSON.parse(readFileSync(out, 'utf8')).outcome
    console.log('@@RG platform=' + process.platform + ' ' + text)
    rmSync(dir, { recursive: true, force: true })
    rmSync(WORK, { recursive: true, force: true })
    expect(text).toBe('__always_fails__')
  }, 240000)
})
