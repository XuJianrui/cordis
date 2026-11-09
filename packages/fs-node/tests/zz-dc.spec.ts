// maxWait 形态是否产生额外事件：一次写应只产生一条 change。
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, '__dupcheck__')
const CHILD = join(WORK, 'child.cjs')
const ROUNDS = Number(process.env.DC_ROUNDS || 8)

const SRC = String.raw`
const fs = require('node:fs')
const path = require('node:path')
let watch
const [dir, out, roundsArg] = process.argv.slice(2)
const res = { outcome: '-', err: '-' }
const done = () => { fs.writeFileSync(out, JSON.stringify(res)); process.exit(0) }
process.on('uncaughtException', (e) => { res.err = 'throw=' + (e.code || e.message); done() })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run(round) {
  const root = path.join(dir, 'd' + round + '-' + Math.random().toString(36).slice(2))
  const sub = path.join(root, 'd0')
  fs.mkdirSync(sub, { recursive: true })
  const target = path.join(sub, 'f0.ts')
  fs.writeFileSync(target, 'v0')
  let n = 0
  const w = watch(root, { ignoreInitial: true })
  w.on('change', (p) => { if (path.basename(p) === 'f0.ts') n++ })
  await new Promise((r) => w.on('ready', () => r()))
  await sleep(300)
  n = 0
  writeFileSync_many(target, 1)
  await sleep(700)
  const one = n
  n = 0
  writeFileSync_many(target, 2)
  await sleep(700)
  const two = n
  w.close()
  fs.rmSync(root, { recursive: true, force: true })
  return { one, two }
}
function writeFileSync_many(t, k) { fs.writeFileSync(t, 'v' + k) }

;(async () => {
  const mod = await import(process.env.CHOKIDAR_PATH)
  watch = mod.watch
  const rounds = Number(roundsArg) || 8
  let one = 0, two = 0
  for (let i = 0; i < rounds; i++) { const r = await run(i); one += r.one; two += r.two }
  res.outcome = 'n=' + rounds + ' singleWrite=' + one + '/' + rounds + ' twoWrites=' + two + '/' + (rounds * 2)
  done()
})()
`

describe('does one write produce one event', () => {
  it('counts events for one and for two writes', () => {
    rmSync(WORK, { recursive: true, force: true })
    mkdirSync(WORK, { recursive: true })
    writeFileSync(CHILD, SRC)
    const dir = mkdtempSync(join(tmpdir(), 'dc-'))
    const out = join(dir, 'out.json')
    const r = spawnSync(process.execPath, [CHILD, dir, out, String(ROUNDS)], {
      timeout: 300000, killSignal: 'SIGKILL', stdio: 'ignore',
      env: { ...process.env, CHOKIDAR_PATH: new URL('../../../node_modules/chokidar/esm/index.js', import.meta.url).href },
    })
    let text = 'killed'
    if (existsSync(out)) text = JSON.parse(readFileSync(out, 'utf8')).outcome
    console.log('@@DC ' + text)
    rmSync(dir, { recursive: true, force: true })
    rmSync(WORK, { recursive: true, force: true })
    expect(text).toBe('__always_fails__')
  }, 360000)
})
