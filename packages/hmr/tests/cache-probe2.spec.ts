import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Hmr from '../src/index.ts'

// probe only: observes the key a failed import leaves behind and a CJS
// module that outlives its eviction. Not for merge.

const testDir = dirname(fileURLToPath(import.meta.url))
const fixtureDir = resolve(testDir, '__cacheprobe2__')
const req = createRequire(import.meta.url)

function fixture(name: string, content: string) {
  const path = resolve(fixtureDir, name)
  writeFileSync(path, content)
  return path
}

describe('module cache probe 2', () => {
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
    const id = await ctx.loader.create({ name: `./__cacheprobe2__/${name}` })
    await ctx.loader.store[id]!.innerFiber!.await().catch(() => {})
    return path
  }

  it('observes the key a failed import leaves behind', async () => {
    await setup()
    const host = await load('host.ts', `
export const name = 'host'

export async function apply(ctx: any) {
  ctx.on('reconcile/host' as any, () => 'v1')
}
`)
    const keys = () => [...Map.prototype.keys.call(ctx.hmr.internal!.loadCache) as Iterable<string>]
    const depPath = resolve(fixtureDir, 'dep.ts')
    const depUrl = pathToFileURL(depPath).href

    writeFileSync(host, `
import { value } from './dep.ts'

export const name = 'host'

export async function apply(ctx: any) {
  ctx.on('reconcile/host' as any, () => value)
}
`)
    fixture('dep.ts', `export const value = 'broken'\n(this is not valid (\n`)
    const r1 = await ctx.hmr.reconcile({ files: [host, depPath] })
    const deadKeys = keys().filter(url => url === depUrl)

    fixture('dep.ts', `export const value = 'fixed'\n`)
    writeFileSync(host, `
import { value } from './dep.ts'

export const name = 'host'

export async function apply(ctx: any) {
  ctx.on('reconcile/host' as any, () => value)
  // touched
}
`)
    const r2 = await ctx.hmr.reconcile({ files: [host] })

    expect({
      aborted: !!r1.aborted,
      deadKeys: deadKeys.length,
      hasAfterAbort: ctx.hmr.internal!.loadCache.has(depUrl),
      fixed: r2.replaced.length === 1 && ctx.bail('reconcile/host' as any) === 'fixed',
    }).to.deep.equal({
      aborted: true,
      deadKeys: 1,
      hasAfterAbort: false,
      fixed: true,
    })
  }, 30000)

  it('observes a CJS module that outlives its eviction', async () => {
    await setup()
    fixture('c.cjs', `exports.value = 'a'\n`)
    fixture('q.cjs', `const { value } = require('./c.cjs')\n\nexports.value = value\n`)
    await load('m.ts', `
import { value } from './c.cjs'

export const name = 'm'

export async function apply(ctx: any) {
  ctx.on('reconcile/m' as any, () => value)
}
`)
    await load('n.ts', `
import { value } from './q.cjs'

export const name = 'n'

export async function apply(ctx: any) {
  ctx.on('reconcile/n' as any, () => value)
}
`)
    expect(ctx.bail('reconcile/m' as any)).to.equal('a')
    expect(ctx.bail('reconcile/n' as any)).to.equal('a')

    const cPath = resolve(fixtureDir, 'c.cjs')
    const qPath = resolve(fixtureDir, 'q.cjs')
    const oldC = req.cache[cPath]
    expect(oldC).to.be.ok
    const oldQ = req.cache[qPath]
    expect(oldQ).to.be.ok

    fixture('c.cjs', `exports.value = 'b'\n`)
    const result = await ctx.hmr.reconcile({ files: [cPath] })

    // every surviving module that still reaches the old one through `children`
    const holders = Object.keys(req.cache)
      .filter(p => p !== cPath && req.cache[p]?.children?.includes(oldC))
      .map(p => p.split('/').pop())
    const newC = req.cache[cPath]
    const sameQ = req.cache[qPath] === oldQ

    expect({
      replaced: result.replaced.length,
      m: ctx.bail('reconcile/m' as any),
      n: ctx.bail('reconcile/n' as any),
      sameQ,
      holders,
      newCIsOld: newC === oldC,
    }).to.deep.equal({
      replaced: 1,
      m: 'b',
      n: 'a',
      sameQ: true,
      holders: ['q.cjs'],
      newCIsOld: false,
    })
  }, 30000)
})
