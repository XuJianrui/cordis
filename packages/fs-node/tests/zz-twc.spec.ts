// 决定性问题：那条幸存的报告，接收者看到的路径是文件还是目录？
// 在 change 回调里立刻 stat 一次——这就是调用方会看到的类型。
//   若 main 的 1 条是 DIR → 两臂都没送达真实写入，main 只多一条误报，本 PR 不是退化
//   若 main 的 1 条是 file → 本 PR 确实丢了真实写入，是退化
import { Context } from 'cordis'
import Fs from '@cordisjs/plugin-fs-node'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '__twc295__')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const hardRm = (p: string) => { try { rmSync(p, { recursive: true, force: true }) } catch {} }
afterAll(() => hardRm(root))

it('what a receiver sees at the moment of the report', async () => {
  for (const gap of [0, 1, 3, 10, 30, 80]) {
    hardRm(root)
    mkdirSync(root, { recursive: true })
    const entry = resolve(root, 'e.ts')
    writeFileSync(entry, 'v0')
    const ctx = new Context()
    ctx.baseUrl = import.meta.url
    await ctx.plugin(Fs)
    const seen: string[] = []
    const w = ctx.fs.watch(root, {})
    w.on('change', (f: string) => {
      const st = statSync(f, { throwIfNoEntry: false })
      seen.push(st?.isDirectory() ? 'DIR' : st ? 'file' : 'gone')
    })
    await new Promise<void>(r => w.on('ready', () => r()))
    await sleep(300)

    seen.length = 0
    writeFileSync(entry, 'ctl')
    await sleep(600)
    const ctl = seen.length > 0 ? 1 : 0

    seen.length = 0
    rmSync(entry, { force: true })
    mkdirSync(entry, { recursive: true })
    if (gap) await sleep(gap)
    rmSync(entry, { recursive: true, force: true })
    writeFileSync(entry, 'real-write')
    await sleep(1200)
    console.log('@@TWC ' + JSON.stringify({ gap, ctl, seen: seen.join(',') || 'none' }))
    await w.dispose()
    await sleep(80)
  }
}, 120000)
