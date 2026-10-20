import { Context, Fiber, FiberState } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import LoggerConsole from '@cordisjs/plugin-logger-console'
import { expect, describe, it, afterEach } from 'vitest'
import { copyFile, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const url = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

// entry-level `inject` reaching the loader from a config file on disk. The yaml
// `!!js` tag is what makes an expression, so the parse, the structured clone the
// patches apply and the write-back all have to keep it for the scopes to mean
// anything.
describe('Include: entry inject', () => {
  // the committed document is copied out, never loaded in place: a runtime edit
  // writes the tree back, and the fixture has to survive the suite
  const tmp = url('tmp-inject.yml')
  let ctx: Context
  let fiber: Fiber<Context>
  let rootId: string

  afterEach(async () => {
    await fiber?.dispose()
    await rm(tmp, { force: true })
  })

  async function setup() {
    await copyFile(url('inject.yml'), tmp)
    ctx = new Context()
    // the parent scope an `inject` value reads: only what the app declares
    // itself is visible there, not a service a sibling entry provides
    ctx.provide('env', { tag: 'p' })
    await ctx.plugin(LoggerConsole)
    fiber = await ctx.plugin(Loader, { baseUrl: import.meta.url })
    rootId = await ctx.loader.create({
      name: '@cordisjs/plugin-include',
      config: { path: './fixtures/tmp-inject.yml' },
    })
    await ctx.loader.await()
    await sleep(200)
  }

  function entry(id: string) {
    for (const item of ctx.loader.entries()) {
      if (item.options.id === id) return item
    }
    throw new Error(`entry ${id} not found`)
  }

  it('resolves an object-form value in the parent scope', async () => {
    await setup()

    const consumer = entry('consumer')
    // the source options keep the expression the yaml tag produced
    expect(consumer.options.inject).to.deep.equal({ service: { tag: { __jsExpr: 'env.tag' } } })
    expect(consumer.inject).to.deep.equal({ service: { tag: 'p' } })
    // and the resolved value reaches the plugin fiber
    expect(consumer.fiber!.inject).to.deep.equal({ service: { tag: 'p' } })
  }, 10000)

  it('evaluates disabled against the service the entry injects', async () => {
    await setup()

    const consumer = entry('consumer')
    expect(consumer.disabled).to.equal(false)
    expect(consumer.fiber!.state).to.equal(FiberState.ACTIVE)
    expect(ctx.bail('test/inject').service).to.deep.equal({ tag: 'p' })

    // the control: the verdict has to track the service, otherwise reading it
    // would have been an accident of the value being undefined
    await ctx.loader.update(`${rootId}:provider`, { config: { tag: 'off' } })
    await ctx.loader.await()
    await sleep(200)
    expect(consumer.disabled).to.equal(true)
    expect(consumer.fiber?.state).to.not.equal(FiberState.ACTIVE)
  }, 10000)

  it('keeps the expression when a runtime edit reaches the file', async () => {
    await setup()

    await ctx.loader.update(`${rootId}:consumer`, { config: { label: 'from-runtime' } })
    await ctx.loader.await()
    await sleep(500)

    const text = await readFile(tmp, 'utf-8')
    // the expression, not the value it evaluated to
    expect(text).to.contain('!!js env.tag')
    expect(text).to.contain("!!js service.tag === 'off'")
    expect(ctx.bail('test/inject').config).to.deep.equal({ label: 'from-runtime' })
  }, 10000)
})
