/* eslint-disable */
// What would `hmr` do with a delete if the driver delivered one?
//
// The consumer spec next door shows the delete never arrives. This one assumes
// it did -- by calling `hmr.reconcile()` with the removed path directly, which
// is exactly what `flush()` does with the stashed filename
// (`packages/hmr/src/index.ts:161`) -- and reads whether the module is
// unloaded.
//
// The question matters because `hmr` has no notion of removal at all:
// `grep -rn "unlink|unlinkDir|deleted|removed" packages/hmr/src/` finds only
// comments about internal cache cleanup. So the interesting answer is not "the
// event is dropped" (already measured) but "what the consumer would do if it
// were not".

import { Context, Fiber } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Fs from '@cordisjs/plugin-fs-node'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Hmr from '../src/index.ts'

const testDir = dirname(fileURLToPath(import.meta.url))
const fixtureDir = resolve(testDir, '__watch262gone__')

const plugin = (name: string, value: string) => `
import { Context } from 'cordis'

export const name = '${name}'

export function apply(ctx: Context) {
  ctx.on('hmr-watch/${name}' as any, () => '${value}')
}
`

describe('verify 262: what hmr does when the deleted path is fed to it', () => {
  let ctx: Context
  let fiber: Fiber<Context> | undefined

  beforeAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
    mkdirSync(fixtureDir, { recursive: true })
  })

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
  })

  afterEach(async () => {
    await fiber?.dispose()
    fiber = undefined
  })

  it('keeps the module loaded and reports a failure, rather than unloading it', async () => {
    ctx = new Context()
    ctx.baseUrl = import.meta.url
    fiber = await ctx.plugin(Loader)
    await ctx.plugin(Fs)
    await ctx.plugin(Hmr, { watch: { enabled: true, root: ['__watch262gone__'], debounce: 50 } })

    const path = resolve(fixtureDir, 'gone.ts')
    writeFileSync(path, plugin('gone', 'v1'))
    const id = await ctx.loader.create({ name: './__watch262gone__/gone.ts' })
    await ctx.loader.store[id]!.innerFiber!.await()
    const before = ctx.bail('hmr-watch/gone' as any)
    console.log('VERIFY262_GONE before=' + JSON.stringify(before))

    // remove the file, then feed its path to reconcile -- what a wired
    // `unlink` listener would end up doing
    rmSync(path, { force: true })
    let outcome = 'resolved'
    let result: any
    try {
      result = await (ctx.hmr as any).reconcile(() => [path])
    } catch (error) {
      outcome = `threw ${(error as Error)?.constructor?.name}`
    }
    console.log(`VERIFY262_GONE reconcile=${outcome}`)
    console.log('VERIFY262_GONE settled=' + JSON.stringify(result?.settledFibers?.length))
    console.log('VERIFY262_GONE import_failures=' + JSON.stringify(result?.importFailures?.length))
    console.log('VERIFY262_GONE failure_is_missing_file=' + JSON.stringify(
      /ENOENT|Cannot find module|Failed to load/.test(String(result?.importFailures?.[0]?.error)),
    ))
    const after = ctx.bail('hmr-watch/gone' as any)
    console.log('VERIFY262_GONE after=' + JSON.stringify(after))
    // still registered as a loader entry?
    const entry = ctx.loader.store[id]
    console.log('VERIFY262_GONE entry_still_present=' + JSON.stringify(!!entry))
    console.log('VERIFY262_GONE entry_value=' + JSON.stringify(entry?.subtree ? 'subtree' : null))

    expect(outcome, 'reconcile threw on a removed path, so a wired listener would need its own error handling')
      .toBe('resolved')
    // The load-bearing reading: the module is NOT unloaded. Its answer survives
    // even when hmr is handed the deletion explicitly.
    expect(after, 'the module was unloaded, so hmr does have removal semantics after all')
      .toBe('v1')
  }, 120_000)
})
