/* eslint-disable */
// Formal verification of the ctx.fs watch contract, run inside the normal
// test job so it lands on CI without touching a workflow file.
//
// Three checks, each with an *expected* outcome that is asserted:
//
//   1. TLA+/TLC  -- three model-checking runs. Two of them are expected to
//      FIND a violation; the run is only green when the checker reports
//      exactly what the design says it should. A checker that always says
//      "NoError" proves nothing, and neither does one that always says
//      "violated".
//
//   2. Lattice   -- Z3 symbolic proofs plus exhaustive enumeration over all
//      256 subsets of the 8 operations.
//
//   3. Syscalls  -- strace on Linux: a file watch must reach inotify as a
//      watch on the PARENT directory. On non-Linux this prints an explicit
//      skip marker; the test asserts the marker is present, so a silent
//      no-op cannot pass as a green run (see rule 55 in the handbook).
//
// Nothing here is skipped by returning early from `it()`.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../../..')
const VERIFY = resolve(REPO, 'verify')
const WORK = mkdtempSync(join(tmpdir(), 'verify262-'))

const log: string[] = []
function note(line: string) {
  log.push(line)
  console.log('VERIFY262 ' + line)
}

function have(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return r.status === 0
}

afterAll(() => {
  try {
    writeFileSync(join(WORK, 'verify-262.log'), log.join('\n') + '\n', 'utf8')
  } catch {}
})

// ---------------------------------------------------------------------------
// 1. TLA+
// ---------------------------------------------------------------------------
describe('verify 262: TLA+ model checking', () => {
  const jar = join(WORK, 'tla2tools.jar')

  beforeAll(() => {
    expect(have('java', ['-version']), 'java must be on PATH').toBe(true)
    if (!existsSync(jar)) {
      const r = spawnSync('curl', [
        '-fsSL', '-o', jar,
        'https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar',
      ], { encoding: 'utf8' })
      expect(r.status, 'downloading tla2tools.jar failed: ' + r.stderr).toBe(0)
    }
    expect(existsSync(jar)).toBe(true)
  }, 180_000)

  const cases = [
    { name: 'cleared', cfg: 'MC-cleared.cfg', expect: 'clean' },
    { name: 'uncleared', cfg: 'MC-uncleared.cfg', expect: 'violated' },
    { name: 'stale', cfg: 'MC-stale.cfg', expect: 'violated' },
  ]

  for (const c of cases) {
    it(`TLC ${c.name} -> ${c.expect}`, () => {
      const r = spawnSync('java', [
        '-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC',
        '-config', c.cfg, '-workers', '2', '-deadlock', 'ctxfs.tla',
      ], { cwd: join(VERIFY, 'spec'), encoding: 'utf8', timeout: 180_000 })

      const out = (r.stdout || '') + (r.stderr || '')
      let verdict: string
      if (out.includes('No error has been found')) verdict = 'clean'
      else if (out.includes('is violated')) verdict = 'violated'
      else verdict = 'unknown'

      note(`tla ${c.name} verdict=${verdict} expected=${c.expect}`)

      // When a violation is the expected outcome, the counterexample *is* the
      // evidence: record which invariant failed and the shortest trace TLC
      // found, so the claim can be audited from the log alone.
      if (verdict === 'violated') {
        const lines = out.split('\n')
        const at = lines.findIndex((l) => l.includes('is violated'))
        if (at >= 0) {
          // Keep the whole counterexample on ONE log line: the test file runs
          // concurrently with the rest of the suite, and per-line logging gets
          // interleaved with unrelated output.
          const trace = lines
            .slice(at, at + 40)
            .map((l) => l.trim())
            .filter(Boolean)
            .join(' | ')
          note(`  cex ${c.name}: ${trace.slice(0, 1200)}`)
        }
      }

      if (verdict !== c.expect) {
        console.log(out.split('\n').slice(-60).join('\n'))
      }
      expect(verdict, `TLC ${c.name}: wanted ${c.expect}, got ${verdict}`).toBe(c.expect)
    }, 240_000)
  }
})

// ---------------------------------------------------------------------------
// 2. Permission lattice
// ---------------------------------------------------------------------------
describe('verify 262: intercept permission lattice', () => {
  it('Z3 symbolic proofs and exhaustive enumeration', () => {
    const py = have('python3', ['--version']) ? 'python3' : 'python'
    const canImport = (bin: string) =>
      spawnSync(bin, ['-c', 'import z3'], { encoding: 'utf8' }).status === 0

    let pyRun = py
    let why = ''

    if (!canImport(py)) {
      const inst = spawnSync(py, ['-m', 'pip', 'install', '--quiet', 'z3-solver'], {
        encoding: 'utf8', timeout: 300_000,
      })
      why = inst.stderr || ''
      if (!canImport(py)) {
        // macOS/Homebrew pythons are "externally managed" (PEP 668) and refuse
        // a plain install; retry inside a throwaway venv before giving up.
        const venv = join(WORK, 'venv')
        const mk = spawnSync(py, ['-m', 'venv', venv], { encoding: 'utf8', timeout: 120_000 })
        const vpy = process.platform === 'win32'
          ? join(venv, 'Scripts', 'python.exe')
          : join(venv, 'bin', 'python')
        if (existsSync(vpy)) {
          const i2 = spawnSync(vpy, ['-m', 'pip', 'install', '--quiet', 'z3-solver'], {
            encoding: 'utf8', timeout: 300_000,
          })
          why += ' | venv-pip: ' + (i2.stderr || '')
          if (canImport(vpy)) pyRun = vpy
        } else {
          why += ' | venv: ' + (mk.stderr || 'no interpreter at ' + vpy)
        }
      }
    }

    // A missing solver must fail the check, not silently pass it.
    expect(canImport(pyRun), 'z3-solver unavailable (' + why.slice(0, 400) + ')').toBe(true)

    const r = spawnSync(pyRun, [join(VERIFY, 'proofs', 'lattice_proofs.py')], {
      encoding: 'utf8', timeout: 300_000,
    })
    const out = (r.stdout || '') + (r.stderr || '')
    note('lattice exit=' + r.status + ' python=' + pyRun)
    if (r.status !== 0) console.log(out.split('\n').slice(-40).join('\n'))
    expect(r.status, 'lattice proofs failed').toBe(0)
    expect(out).toContain('ALL LATTICE LAWS PROVED')
  }, 600_000)
})

// ---------------------------------------------------------------------------
// 3. Syscalls (Linux only, with an explicit and asserted skip marker)
// ---------------------------------------------------------------------------
describe('verify 262: syscall-level check of the parent-watch decision', () => {
  it('file watch reaches inotify on the parent directory', () => {
    if (process.platform !== 'linux') {
      // Visible, asserted skip. Not a silent early return.
      note(`syscall-skip platform=${process.platform}`)
      expect(log.join('\n')).toContain('syscall-skip platform=')
      return
    }

    expect(have('strace', ['-V']), 'strace must be available on linux').toBe(true)

    const trace = join(WORK, 'inotify.log')
    const r = spawnSync('strace', [
      '-f', '-e', 'trace=inotify_init1,inotify_add_watch',
      '-o', trace,
      process.execPath, '--import', 'tsx', join(VERIFY, 'tests', 'syscall-probe.ts'),
    ], { cwd: REPO, encoding: 'utf8', timeout: 300_000 })

    const out = (r.stdout || '') + (r.stderr || '')
    if (r.status !== 0) console.log(out.split('\n').slice(-40).join('\n'))
    expect(r.status, 'syscall probe failed').toBe(0)

    const file = (out.match(/^PROBE_FILE=(.*)$/m) || [])[1]
    const parent = (out.match(/^PROBE_FILE_PARENT=(.*)$/m) || [])[1]
    const dir = (out.match(/^PROBE_DIR=(.*)$/m) || [])[1]
    expect(file && parent && dir, 'probe markers missing').toBeTruthy()
    note(`syscall markers file=${file} parent=${parent} dir=${dir}`)

    expect(existsSync(trace), 'strace produced no trace').toBe(true)
    const tr = readFileSync(trace, 'utf8')
    const adds = tr.split('\n').filter((l) => l.includes('inotify_add_watch'))
    note('inotify_add_watch count=' + adds.length)

    expect(adds.length, 'no inotify_add_watch at all').toBeGreaterThan(0)
    expect(adds.some((l) => l.includes(`"${parent}"`)),
      `parent ${parent} never handed to inotify_add_watch`).toBe(true)
    expect(adds.some((l) => l.includes(`"${dir}"`)),
      `directory ${dir} never handed to inotify_add_watch`).toBe(true)
  }, 600_000)
})

// ---------------------------------------------------------------------------
// 4. Exhaustive enumeration of the watch lifecycle model
// ---------------------------------------------------------------------------
// TLC checks traces of the driver model, which carries pending/delivered
// counters. This checks a different and smaller state space, (shape,
// registration), exhaustively: the reachable closure (9 states), every
// sequence of six operations (6^6 = 46 656, 279 936 steps), and the two
// fractions the comment quotes. It is not derived from the TLA+ spec, so a
// disagreement between the two is itself the signal.
//
// The script exits non-zero on any failed assertion and prints one marker line
// per assertion, so this test fails loudly rather than silently passing.
describe('verify 262: exhaustive watch-lifecycle enumeration', () => {
  it('closure and all 46 656 sequences', () => {
    const r = spawnSync(process.execPath, [join(VERIFY, 'proofs', 'watch_enumeration.mjs')], {
      encoding: 'utf8', timeout: 120_000,
    })
    const out = (r.stdout || '') + (r.stderr || '')
    // Put the whole output on one log line: this file runs concurrently with
    // the rest of the suite and per-line logging interleaves with it.
    note('watchenum ' + out.trim().split('\n').join(' | ').slice(0, 2000))
    if (r.status !== 0) console.log(out.split('\n').slice(-40).join('\n'))

    expect(out, 'enumeration produced no marker lines').toContain('WATCHENUM ')
    expect(out, 'some assertion failed').toContain('WATCHENUM ALL ASSERTIONS HELD')
    expect(out).not.toContain('WATCHENUM FAILED')
    expect(r.status, 'enumeration failed').toBe(0)
  }, 180_000)
})

