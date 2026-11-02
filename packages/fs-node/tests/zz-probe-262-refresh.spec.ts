// Probe 262 f: what wiring `unlink` -> `refresh()` would do to a consumer.
//
// The draft asserts three readings about the real plugin: the delete is currently
// silent (no callback, no warning, tree unchanged); calling `refresh()` on the
// already-missing file resolves normally and warns once; and the tree still holds
// its old value afterwards. Silence is already covered by `PROBE262_ROOTIMPL`
// (`shipped` reads 0 deletes on every root where a watch can be established at
// all). What is *not* measured anywhere is the second and third -- whether
// `refresh()` swallows the missing file or throws, and whether the tree moves.
//
// The harness is the one `packages/include/tests/watch.spec.ts` already uses: a
// real `Fs` provider, a real `Loader`, and a real `Include` watching a real
// fixture file. The logger is spied, not replaced: `this.ctx.logger.warn` is a
// method on the context's logger object, and swapping the root logger factory
// breaks it -- the first version of this probe did exactly that and reported its
// own bug as a product failure.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Fs from '@cordisjs/plugin-fs-node'
import { readFile, rm, writeFile } from 'node:fs/promises'
import * as yaml from 'yaml'
import Include from '../../include/src/index.ts'
import { fixture, plugin } from '../../include/tests/utils.ts'

const SETTLE = Number(process.env.PROBE262_SETTLE || 700)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('probe 262 f', () => {
  const filename = fixture('probe262-refresh.yml')
  let fiber: any

  afterEach(async () => {
    await fiber?.dispose()
    fiber = undefined
    await rm(filename, { force: true })
  })

  it('refresh() on an already-missing config file', async () => {
    const seeds = Number(process.env.PROBE262_SEEDS || 3)
    const rows: any[] = []

    for (let seed = 0; seed < seeds; seed++) {
      await writeFile(filename, yaml.stringify([plugin('a', 1)]))
      const ctx = new Context()

      await ctx.plugin(Fs)
      fiber = await ctx.plugin(Loader, { baseUrl: import.meta.url })
      const id = await ctx.loader.create({
        name: '@cordisjs/plugin-include',
        config: { path: filename, watch: true },
      })
      await ctx.loader.store[id]!.innerFiber!.await()
      const include = ctx.loader.store[id]!.subtree as Include
      await sleep(SETTLE)

      // Spy on the context's logger object rather than replacing it.
      const warnSpy = vi.spyOn(ctx.logger, 'warn')

      const valueBefore = ctx.bail('test/config', 'a')?.value ?? null

      await rm(filename, { force: true })
      await sleep(SETTLE)
      const valueAfterDelete = ctx.bail('test/config', 'a')?.value ?? null
      const warningsAfterDelete = warnSpy.mock.calls.length

      let resolved = false
      let threw: string | null = null
      try {
        await include.refresh()
        resolved = true
      } catch (error: any) {
        threw = String(error?.stage ?? error?.code ?? error?.message ?? error).slice(0, 90)
      }
      await sleep(250)
      const valueAfterRefresh = ctx.bail('test/config', 'a')?.value ?? null
      const warningsTotal = warnSpy.mock.calls.length
      const fileRecreated = await readFile(filename, 'utf8').then(() => true, () => false)

      warnSpy.mockRestore()
      await fiber.dispose()
      fiber = undefined

      rows.push({
        seed, valueBefore, valueAfterDelete, valueAfterRefresh,
        refreshResolved: resolved, refreshThrew: threw,
        warningsAfterDelete, warningsTotal, fileRecreated,
      })
    }

    console.log('PROBE262_REFRESH ' + JSON.stringify({
      platform: process.platform, node: process.version, settle: SETTLE, seeds: rows.length,
      silentOnDelete: rows.filter((r) => r.valueAfterDelete === r.valueBefore && r.warningsAfterDelete === 0).length,
      refreshResolved: rows.filter((r) => r.refreshResolved).length,
      refreshThrew: rows.map((r) => r.refreshThrew).filter(Boolean).slice(0, 3),
      treeUnchangedByRefresh: rows.filter((r) => r.valueAfterRefresh === r.valueAfterDelete).length,
      values: [...new Set(rows.map((r) => `${r.valueBefore}/${r.valueAfterDelete}/${r.valueAfterRefresh}`))].slice(0, 3),
      warnedAfterDelete: rows.map((r) => r.warningsAfterDelete).slice(0, 6),
      warnedTotal: rows.map((r) => r.warningsTotal).slice(0, 6),
      fileRecreated: rows.filter((r) => r.fileRecreated).length,
    }))
    expect(rows.length).toBe(seeds)
  }, 120000)
})
