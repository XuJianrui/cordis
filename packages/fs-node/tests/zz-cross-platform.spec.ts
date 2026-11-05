import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, relative, resolve } from 'node:path'
import { platform, release } from 'node:os'
import { beforeAll, describe, it } from 'vitest'
import { fileURLToPath } from 'node:url'

// Is the minimal combination the same on every platform?
//
// On Windows, 1024 cells showed that the two transitions fail unless both `handler.js:481`
// and `handler.js:347` are relaxed, and that the other seven candidate gates make no
// difference. That result is local to one platform. The gates are not obviously
// platform-neutral — the readdir throttle and the two watch throttles interact with
// inotify, FSEvents and the Windows recursive backend differently — so the claim to test
// here is narrower than the full factorial: does `.BC` work, and do `B` and `C` alone
// still fail, on Linux and macOS as well?
//
// Four combinations, chosen so the answer is meaningful rather than exhaustive:
//
//   ......    nothing relaxed      — must fail, or the premise is wrong here
//   .B....    only 481             — must fail, if C is also necessary
//   ..C...    only 347             — must fail, if B is also necessary
//   .BC...    both                 — must succeed, if B+C are sufficient
//
// A success at `.BC` together with failures at `.B` and `..C` reproduces the local
// structure; anything else means the platform differs and the local conclusion does not
// carry over.

const testDir = dirname(fileURLToPath(import.meta.url))
const base = resolve(testDir, '__xp__')
const ROUNDS = Number(process.env.XP_ROUNDS || 6)
const TAG = `${platform()}-${release().split('.')[0]}-${process.version.slice(1)}`

const PKG = resolve(testDir, '../../../node_modules/chokidar')
const SHARED = ['esm/index.js', 'esm/index.d.ts', 'esm/handler.d.ts', 'esm/package.json', 'package.json', 'index.js', 'index.d.ts', 'handler.js', 'handler.d.ts']

const GATES = {
  B: {
    from: `            if (item === target || (!target && !previous.has(item))) {`,
    to: `            if (item === target || (!target && !previous.has(item)) || true) {`,
    witness: `!previous.has(item)) || true`,
  },
  C: {
    from: `        // if the file is already being watched, do nothing
        if (parent.has(basename))
            return;`,
    to: `        // test
        if (false)
            return;`,
    witness: `        // test
        if (false)
            return;`,
  },
}

function prep(name: string, keys: string[]) {
  const dir = resolve(base, 'pkg/' + name)
  mkdirSync(resolve(dir, 'esm'), { recursive: true })
  for (const f of SHARED) {
    const target = resolve(dir, f)
    if (existsSync(target)) continue
    copyFileSync(resolve(PKG, f), target)
  }
  const original = readFileSync(resolve(PKG, 'esm/handler.js'), 'utf8')
  let src = original
  const problems: string[] = []
  for (const k of keys) {
    const g = GATES[k]
    const n = src.split(g.from).length - 1
    if (n !== 1) { problems.push(`${k}:anchor x${n}`); continue }
    src = src.replace(g.from, g.to)
  }
  const p = resolve(dir, 'esm/handler.js')
  writeFileSync(p, src, 'utf8')
  for (const k of keys) {
    if (!src.includes(GATES[k].witness)) problems.push(`${k}:witness`)
  }
  if (problems.length) return { dir, ok: false, why: problems.join(',') }
  try {
    execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' })
  } catch (e: any) {
    const line = (String(e.stderr).match(/handler\.js:(\d+)/) || [])[1]
    return { dir, ok: false, why: `syntax@${line}` }
  }
  return { dir, ok: true, why: '' }
}

async function round(imp: string, arm: 'retarget' | 'link2dir') {
  const home = resolve(base, `fx/${Math.random().toString(36).slice(2)}`)
  const root = resolve(home, 'root')
  const a = resolve(home, 'a')
  const b = resolve(home, 'b')
  for (const d of [root, a, b]) mkdirSync(d, { recursive: true })
  writeFileSync(resolve(a, 'file.ts'), 'v0')
  writeFileSync(resolve(b, 'file.ts'), 'v0')
  const link = resolve(root, 'linked')
  symlinkSync(a, link, 'junction')

  let watch: any
  try {
    ({ watch } = await import(imp))
  } catch {
    return 'LOADFAIL'
  }
  const events: string[] = []
  const errors: string[] = []
  const w = watch(root, { ignoreInitial: true })
  w.on('all', (e: string, p: string) => events.push(`${e}:${relative(root, p) || '.'}`))
  w.on('error', (e: any) => errors.push(e?.code || 'e'))
  await new Promise<void>((done) => w.once('ready', () => done()))
  const mark = events.length

  let writeTo: string
  if (arm === 'retarget') {
    rmSync(link, { recursive: true, force: true })
    symlinkSync(b, link, 'junction')
    writeTo = resolve(b, 'file.ts')
  } else {
    rmSync(link, { recursive: true, force: true })
    mkdirSync(link, { recursive: true })
    writeTo = resolve(link, 'file.ts')
  }

  for (let i = 0; i < 15; i++) {
    if (events.length > mark) break
    writeFileSync(writeTo, `v${i + 1}`)
    await new Promise(r => setTimeout(r, 100))
  }
  await w.close()
  try { rmSync(home, { recursive: true, force: true }) } catch {}

  const got = events.slice(mark)
  if (got.some(e => /linked[\\/].*file\.ts$/.test(e))) return 'file'
  if (got.some(e => /:linked$/.test(e))) return 'self'
  if (got.length) return 'other'
  return errors.length ? 'err' : 'none'
}

const CELLS: Array<[string, string[]]> = [
  ['......', []],
  ['.B....', ['B']],
  ['..C...', ['C']],
  ['.BC...', ['B', 'C']],
]

describe('the minimal combination, per platform', () => {
  beforeAll(() => { rmSync(base, { recursive: true, force: true }) })

  for (const [label, keys] of CELLS) {
    for (const arm of ['retarget', 'link2dir'] as const) {
      for (let i = 0; i < ROUNDS; i++) {
        it(`${label} ${arm} ${i}`, async () => {
          const { dir, ok, why } = prep(`${label.replace(/\./g, '_')}-${arm}`, keys)
          if (!ok) {
            console.log(`@@XP ${TAG} ${label} ${arm} ${i} INVALID ${why}@@`)
            return
          }
          const imp = 'file:///' + resolve(dir, 'esm/index.js').replace(/\\/g, '/')
          let v = 'THREW'
          try { v = await round(imp, arm) } catch { v = 'THREW' }
          console.log(`@@XP ${TAG} ${label} ${arm} ${i} ${v}@@`)
        }, 40000)
      }
    }
  }
})
