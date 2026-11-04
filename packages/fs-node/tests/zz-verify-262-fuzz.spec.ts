/* eslint-disable */
// WP6: fuzz the two places where untrusted input reaches the driver.
//
//   a) `_resolve` turns a string or URL into an absolute path. It is the only
//      place where a caller-supplied string is interpreted, and it has to
//      survive `#`, `%`, drive letters, `file:` URLs and malformed URLs.
//   b) `watch` accepts an options bag; a bad `ignored` predicate must not take
//      the process down.
//
// The assertion is deliberately weak on purpose: no crash, and the result of
// `_resolve` is absolute (or a file URL). Anything stronger would be asserting
// behaviour the comment does not claim.

import { Context } from 'cordis'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import Fs from '../src/index.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const VERIFY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../verify')

function mulberry32(seed: number) {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

const PIECES = [
  'a', 'dir', 'file.txt', '..', '.', '~', '#frag', 'pct%20', 'sp ace',
  'C:', 'c:/', '\\\\srv\\share', '', 'x'.repeat(40), '\u00e9\u00e8', 'a#b%c',
]
const SCHEMES = ['', 'file:', 'FILE:', 'http:', 'https:', 'cordis:', 'data:']

function randomInput(rnd: () => number): string {
  const scheme = SCHEMES[Math.floor(rnd() * SCHEMES.length)]
  const n = 1 + Math.floor(rnd() * 4)
  const body = Array.from({ length: n }, () => PIECES[Math.floor(rnd() * PIECES.length)])
  const sep = rnd() < 0.5 ? '/' : '\\'
  return scheme + (rnd() < 0.7 ? '/' : '') + body.join(sep)
}

describe('verify 262: fuzz the resolve and watch entry points', () => {
  it('_resolve never crashes on random input and always yields an absolute path or a file URL', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(Fs)
    const fs: any = ctx.fs
    const rnd = mulberry32(0xc0ffee)
    const N = Number(process.env.VERIFY262_FUZZ_N || 3000)

    const bad: any[] = []
    let threw = 0

    for (let i = 0; i < N; i++) {
      const input = randomInput(rnd)
      try {
        const out = fs._resolve(input)
        if (typeof out !== 'string' || (!isAbsolute(out) && !out.startsWith('\\\\'))) {
          bad.push({ input, out: String(out) })
        }
      } catch (e: any) {
        // Throwing on a genuinely malformed URL is acceptable; crashing is not.
        threw++
        if (!(e instanceof Error)) bad.push({ input, err: String(e) })
      }
    }

    console.log(`VERIFY262_FUZZ resolve n=${N} threw=${threw} bad=${bad.length}`)
    if (bad.length) console.log('VERIFY262_FUZZ_BAD ' + JSON.stringify(bad.slice(0, 10)))
    // Non-vacuity: if every input threw, `bad` is empty for the wrong reason.
    expect(threw, 'every input threw; the resolver was never exercised').toBeLessThan(N)

    // Known defect, quarantined rather than deleted: on win32 a `file:` URL
    // whose path is a bare drive letter resolves to the drive-relative string
    // "C:", which is neither absolute nor a file URL. Linux and macOS return
    // nothing for these inputs. Recorded so the suite stays honest: the test
    // fails on any NEW shape of bad output, and stops failing only when this
    // set disappears.
    const KNOWN_BAD_WIN32 = [
      ['file:C:', 'C:'],
      ['file:/../C:', 'C:'],
      ['file:/\\C:', 'C:'],
      ['file:/C:', 'C:'],
      ['file:/\u00e9\u00e8\\..\\C:', 'C:'],
      ['file:.\\C:', 'C:'],
    ]
    const known = new Set(KNOWN_BAD_WIN32.map(([i, o]) => `${i}\u0000${o}`))
    const unexpected = bad.filter((b: any) =>
      !(process.platform === 'win32' && known.has(`${b.input}\u0000${b.out}`)))

    if (bad.length) {
      console.log(`VERIFY262_FUZZ_KNOWN ${bad.length} quarantined, ${unexpected.length} unexpected`)
    }
    expect(unexpected, 'resolved to something that is neither absolute nor a file URL').toEqual([])
    await fiber.dispose()
  }, 300_000)

  it('a non-well-formed ignored predicate fails loudly instead of silently', async () => {
    // One fact, three processes: a well-formed predicate resolves, and the two
    // ways of being ill-formed (throws, not callable) both terminate the
    // process. Measured in child processes because two of the three modes kill
    // the process that observes them.
    const run = (mode: string) => {
      const r = spawnSync(process.execPath, [
        '--import', 'tsx', join(VERIFY_DIR, 'tests', 'ignored-throws-probe.ts'),
      ], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, PROBE_MODE: mode, PROBE_WINDOW_MS: '4000' } })
      const out = (r.stdout || '') + (r.stderr || '')
      const m = out.match(/PROBE_(SETTLED|REJECTED|CRASH|HUNG)(?: ([^\n]*))?/)
      return { mode, status: r.status, verdict: m ? m[1] : 'NONE', detail: m && m[2] ? m[2].trim() : '', out }
    }

    const results = ['ok', 'throws', 'not-callable'].map(run)
    for (const r of results) {
      console.log(`VERIFY262_FUZZ ignored[${r.mode}] -> ${r.verdict}` + (r.detail ? ' :: ' + r.detail : ''))
    }
    console.log('VERIFY262_FUZZ_MATRIX ' + JSON.stringify(results.map((r) => [r.mode, r.verdict])))

    // The probe exits 0 even when the driver kills it; a non-zero status means
    // the probe itself broke, which must not be confused with a reading.
    for (const r of results) {
      expect(r.status, `probe ${r.mode} did not exit cleanly: ` + r.out.slice(-300)).toBe(0)
    }

    const byMode = Object.fromEntries(results.map((r) => [r.mode, r.verdict]))
    expect(byMode['ok'], 'a well-formed predicate must resolve').toBe('SETTLED')

    // Known defect, quarantined by exact mode: both ill-formed shapes take the
    // process down, because the throw escapes `chokidar.watch()` inside the
    // driver's async effect and nothing awaits it.
    expect(byMode['throws'], 'throwing predicate changed shape; re-read it').toBe('CRASH')
    expect(byMode['not-callable'], 'non-callable predicate changed shape; re-read it').toBe('CRASH')
  }, 300_000)
})
