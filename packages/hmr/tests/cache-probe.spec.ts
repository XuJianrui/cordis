import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Hmr from '../src/index.ts'

// probe only: observes what the current module cache does with a module that
// failed to import. Not for merge.

const testDir = dirname(fileURLToPath(import.meta.url))
const fixtureDir = resolve(testDir, '__cacheprobe__')

function fixture(name: string, content: string) {
  const path = resolve(fixtureDir, name)
  writeFileSync(path, content)
  return path
}

describe('module cache probe', () => {
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
    const id = await ctx.loader.create({ name: `./__cacheprobe__/${name}` })
    await ctx.loader.store[id]!.innerFiber!.await().catch(() => {})
    return path
  }

  it('observes a fix to a module that failed to import', async () => {
    await setup()
    const host = await load('host.ts', `
export const name = 'host'

export async function apply(ctx: any) {
  ctx.on('reconcile/host' as any, () => 'v1')
}
`)
    expect(ctx.bail('reconcile/host' as any)).to.equal('v1')
    const seen: string[] = []

    // the plugin is rewritten to import a new module, which is broken
    writeFileSync(host, `
import { value } from './dep.ts'

export const name = 'host'

export async function apply(ctx: any) {
  ctx.on('reconcile/host' as any, () => value)
}
`)
    const dep = fixture('dep.ts', `export const value = 'broken'\n(this is not valid (\n`)
    const r1 = await ctx.hmr.reconcile({ files: [host, dep] })
    seen.push(`break: replaced=${r1.replaced.length} aborted=${!!r1.aborted} pending=${JSON.stringify(r1.pending.map(p => p.reason))} bail=${ctx.bail('reconcile/host' as any)}`)

    // the broken module is fixed on disk
    writeFileSync(dep, `export const value = 'fixed'\n`)
    const r2 = await ctx.hmr.reconcile({ files: [dep] })
    seen.push(`fix-dep: replaced=${r2.replaced.length} aborted=${!!r2.aborted} pending=${JSON.stringify(r2.pending.map(p => p.reason))} bail=${ctx.bail('reconcile/host' as any)}`)

    // the plugin is touched again, which must pick the fixed module up
    writeFileSync(host, `
import { value } from './dep.ts'

export const name = 'host'

export async function apply(ctx: any) {
  ctx.on('reconcile/host' as any, () => value)
  // touched
}
`)
    const r3 = await ctx.hmr.reconcile({ files: [host] })
    seen.push(`touch-host: replaced=${r3.replaced.length} aborted=${!!r3.aborted} pending=${JSON.stringify(r3.pending.map(p => p.reason))} bail=${ctx.bail('reconcile/host' as any)}`)

    // what the fix is expected to produce once the failed module no longer
    // poisons its url: the last step reloads the plugin with the fixed value
    expect(seen).to.deep.equal([
      'break: replaced=0 aborted=true pending=[] bail=v1',
      'fix-dep: replaced=0 aborted=false pending=["no-plugin"] bail=v1',
      'touch-host: replaced=1 aborted=false pending=[] bail=fixed',
    ])
  }, 30000)
})
