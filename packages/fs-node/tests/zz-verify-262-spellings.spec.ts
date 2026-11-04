/* eslint-disable */
// Which legal spellings of the same watched file deliver nothing?
//
// The filter (packages/fs-node/src/index.ts:55-57) compares a *normalized*
// candidate against `root` / `filename` as `_resolve` produced them:
//
//   ignored: (path) => {
//     path = resolve(path)
//     if (isFile && path !== root && path !== filename) return true
//
// `_resolve` does `fileURLToPath(path)` verbatim for a `file:` URL and
// `resolve(...)` for paths, so most spellings converge. Rather than reason
// about which inputs diverge, this enumerates the spellings a caller can
// legitimately pass and measures each one through the real service. Every arm
// uses the same file, so a difference is the driver's, not the fixture's.
//
// The gate is per-arm only in the sense that "delivered > 0" is required for
// the plain spelling; the other arms are recorded, and any arm that delivers
// zero while the plain one delivers is reported as a defect rather than
// asserted, because which spellings are legal is the contract question this
// review is meant to inform, not to settle.

import { Context, Fiber } from 'cordis'
import Fs from '@cordisjs/plugin-fs-node'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { isAbsolute, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('verify 262: which spellings of the watched file deliver at all', () => {
  let fiber: Fiber<Context> | undefined
  let root: string | undefined
  let file = ''

  afterEach(async () => {
    await fiber?.dispose()
    fiber = undefined
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  async function deliver(target: string | URL) {
    return deliverWithBase(target, undefined)
  }

  /** Same, but with `ctx.baseUrl` set, which `_resolve` prefers for relatives. */
  async function deliverWithBase(target: string | URL, baseUrl: string | undefined) {
    const ctx = new Context()
    if (baseUrl) ctx.baseUrl = baseUrl
    fiber = await ctx.plugin(Fs)
    const seen: string[] = []
    try {
      ctx.fs.watch(target, (p: string) => seen.push(p))
    } catch (error) {
      await fiber.dispose()
      fiber = undefined
      return { seen, threw: (error as Error)?.constructor?.name ?? 'Error' }
    }
    await sleep(700)
    for (let i = 0; i < 12 && seen.length === 0; i++) {
      writeFileSync(file, 'v' + i)
      await sleep(180)
    }
    await fiber.dispose()
    fiber = undefined
    return { seen, threw: undefined as string | undefined }
  }

  it('reports a count per spelling, and a defect where one is silent', async () => {
    root = mkdtempSync(join(tmpdir(), 'spell262-'))
    mkdirSync(join(root, 'a'))
    mkdirSync(join(root, 'b'))
    file = join(root, 'b', 'probe.yml')
    writeFileSync(file, 'v')

    // `realpathSync` is the long spelling on win32 only when the input is a
    // short 8.3 name; otherwise it is the input. Both are kept as arms.
    const long = process.env.USERPROFILE && /~/.test(root)
      ? join(process.env.USERPROFILE, root.slice(root.toLowerCase().indexOf('\\appdata')))
      : root
    const longFile = join(long, 'b', 'probe.yml')

    // A relative path is explicitly supported (`_resolve` has a branch for it)
    // and resolves against `ctx.baseUrl` when set, else `process.cwd()`.
    //
    // The arm is built with `relative()`, NOT by slicing off the cwd prefix:
    // on Windows the temp directory is often on a *different drive* from the
    // repository, and `relative()` then returns an absolute path, so a sliced
    // string is not a path at all. An earlier version of this file sliced and
    // reported the arm as "silent", which was the fixture being wrong rather
    // than the driver -- the very mistake this review keeps catching.
    const relativeToCwd = relative(process.cwd(), file)
    const relativeIsUsable = !isAbsolute(relativeToCwd)
    console.log('VERIFY262_SPELLING relative_to_cwd=' + JSON.stringify(relativeToCwd))
    console.log('VERIFY262_SPELLING relative_is_usable=' + JSON.stringify(relativeIsUsable))

    const arms: Array<[string, string | URL]> = [
      ['plain', file],
      ['with_dotdot', join(root, 'a', '..', 'b', 'probe.yml')],
      ['trailing_sep', join(root, 'b') + sep],
      ['file_url', pathToFileURL(file)],
      ['file_url_dotdot', pathToFileURL(join(root, 'a', '..', 'b', 'probe.yml'))],
      ['long_spelling', longFile],
    ]
    if (relativeIsUsable) arms.push(['relative_to_cwd', relativeToCwd])

    const results: Record<string, number | string> = {}
    for (const [name, target] of arms) {
      const { seen, threw } = await deliver(target)
      results[name] = threw ? `threw ${threw}` : seen.length
      console.log(`VERIFY262_SPELLING ${name}=${JSON.stringify(results[name])}`)
    }

    // The same relative path with a baseUrl set to this test file. If baseUrl
    // is honoured, the relative path now denotes <this dir>/<relative>, which
    // is a different file (usually nonexistent) -- and the driver must not go
    // silent about it.
    const relativeTarget = relativeToCwd
    const withBase = await deliverWithBase(relativeTarget, import.meta.url)
    console.log('VERIFY262_SPELLING relative_with_baseUrl=' + JSON.stringify(withBase))

    const plain = results.plain
    console.log('VERIFY262_SPELLING plain_count=' + JSON.stringify(plain))
    console.log('VERIFY262_SPELLING summary=' + JSON.stringify(results))

    // The gate: the plain spelling must deliver, or nothing here is a reading.
    expect(typeof plain === 'number' && plain > 0, 'the plain spelling delivered nothing, so the probe is not measuring the driver')
      .toBe(true)

    // The defect report, as a reading rather than an assertion: any spelling
    // that delivers zero while the plain one delivers. Printed so it can be
    // quoted; the assertion is that at least the plain spelling works, which
    // keeps this file honest without pinning behaviour the contract has not
    // settled.
    const silent = Object.entries(results)
      .filter(([, v]) => v === 0)
      .map(([k]) => k)
    console.log('VERIFY262_SPELLING silent_spellings=' + JSON.stringify(silent))
    console.log('VERIFY262_SPELLING verdict=' + JSON.stringify(
      silent.length ? `defect candidates: ${silent.join(', ')}` : 'every spelling delivered'))
  }, 180_000)
})
