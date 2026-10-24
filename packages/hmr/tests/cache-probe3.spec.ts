import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Hmr from '../src/index.ts'

// probe only: observes how long a failed import stays visible in the module
// cache, at both timings. Not for merge.

const testDir = dirname(fileURLToPath(import.meta.url))
const fixtureDir = resolve(testDir, '__cacheprobe3__')

function fixture(name: string, content: string) {
  const path = resolve(fixtureDir, name)
  writeFileSync(path, content)
  return path
}

describe('module cache probe 3', () => {
  let ctx: Context
  let fiber: any

  beforeAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
    mkdirSync(fixtureDir, { recursive: true })
  })

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
  })

  async function setup() {
    ctx = new Context()
    fiber = await ctx.plugin(Loader, { baseUrl: import.meta.url })
    await ctx.plugin(Hmr)
    return ctx
  }

  async function load(name: string, content: string) {
    const path = fixture(name, content)
    const id = await ctx.loader.create({ name: `./__cacheprobe3__/${name}` })
    await ctx.loader.store[id]!.innerFiber!.await().catch(() => {})
    return path
  }

  it('observes how long a failed import stays visible', async () => {
    await setup()
    const host = await load('host.ts', `
export const name = 'host'

export async function apply(ctx: any) {
  ctx.on('reconcile/host' as any, () => 'v1')
}
`)
    const depPath = resolve(fixtureDir, 'dep.ts')
    const depUrl = pathToFileURL(depPath).href
    const cache = ctx.hmr.internal!.loadCache
    const view = () => ({
      has: cache.has(depUrl),
      rawGet: !!Map.prototype.get.call(cache, depUrl),
      keys: [...Map.prototype.keys.call(cache) as Iterable<string>].filter(url => url === depUrl).length,
    })

    writeFileSync(host, `
import { value } from './dep.ts'

export const name = 'host'

export async function apply(ctx: any) {
  ctx.on('reconcile/host' as any, () => value)
}
`)
    fixture('dep.ts', `export const value = 'broken'\n(this is not valid (\n`)
    const r1 = await ctx.hmr.reconcile({ files: [host, depPath] })
    const now = view()

    // let the loader settle before reading again
    await new Promise(done => setTimeout(done, 50))
    const settled = view()

    // a reconcile on the failed module alone, before the file is fixed
    const r2 = await ctx.hmr.reconcile({ files: [depPath] })

    // fix the module and touch the plugin: the fix must land
    fixture('dep.ts', `export const value = 'fixed'\n`)
    writeFileSync(host, `
import { value } from './dep.ts'

export const name = 'host'

export async function apply(ctx: any) {
  ctx.on('reconcile/host' as any, () => value)
  // touched
}
`)
    const r3 = await ctx.hmr.reconcile({ files: [host] })

    expect({
      aborted: !!r1.aborted,
      now,
      settled,
      r2Pending: r2.pending.map(p => p.reason),
      r3Replaced: r3.replaced.length,
      r3Bail: ctx.bail('reconcile/host' as any),
    }).to.deep.equal({
      aborted: true,
      now: { has: true, rawGet: false, keys: 0 },
      settled: { has: false, rawGet: false, keys: 0 },
      r2Pending: ['not-loaded'],
      r3Replaced: 1,
      r3Bail: 'fixed',
    })
  }, 30000)
})
