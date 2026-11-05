import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, posix, relative, resolve, sep } from 'node:path'
import { platform, release } from 'node:os'
import { beforeAll, describe, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { watch } from 'chokidar'
import picomatch from 'picomatch'

// Two readings of the same shape disagree: 1.88 % and 100 %. One of them is a
// property of the watcher and the other is a property of the harness, and no
// amount of argument settles which — so both are run side by side, in one job,
// differing in exactly one thing.
//
// The shapes that reported ~1 % replaced `linked` and left the two directories
// alone. The shape that reported 100 % removed and re-created the whole root
// between rounds. The root's own identity is the only variable:
//
//   keep     the root is created once; a round touches only `linked`
//   rebuild  the root is removed and re-created each round
//
// If `keep` reproduces at a few per cent and `rebuild` at 100 %, the 100 % was
// the harness changing the thing under test — the same mistake the depth curve
// made at the start of this investigation. If both are 100 %, the earlier 1 %
// readings were the anomaly and everything measured from them is suspect.
//
// A third arm separates "the root is new" from "the root was removed": `sibling`
// uses a different root every round but never removes it.

const testDir = dirname(fileURLToPath(import.meta.url))
const base = resolve(testDir, '__hb291__')
const ROUNDS = Number(process.env.HB_ROUNDS || 80)
const BUDGET = 40
const TAG = `${platform()}-${release().split('.')[0]}-${process.version.slice(1)}`

const match = picomatch('linked/**/*.ts', { posix: true })

function contains(a: string, b: string) {
  return !a || b === a || b.startsWith(a + '/')
}

function keepIt(path: string, isDirectory: boolean) {
  for (let end = path.length; end > 0; end = path.lastIndexOf('/', end - 1)) {
    if (match(path.slice(0, end))) return true
  }
  return isDirectory && (contains('linked', path) || contains(path, 'linked'))
}

function makeIgnored(root: string) {
  const remembered = new Map<string, boolean>()
  return (input: string, stats?: any) => {
    const path = resolve(input)
    if (path === root) return false
    if (stats?.isSymbolicLink()) remembered.delete(path)
    else if (stats) remembered.set(path, stats.isDirectory())
    const isDirectory = remembered.get(path)
    if (isDirectory === undefined) return false
    return !keepIt(relative(root, path).split(sep).join(posix.sep), isDirectory)
  }
}

type Arm = 'keep' | 'rebuild' | 'sibling'

function paths(arm: Arm, index: number) {
  const home = arm === 'sibling' ? resolve(base, `s${index}`) : resolve(base, arm)
  return {
    root: resolve(home, 'root'),
    target: resolve(home, 'target'),
    link: resolve(home, 'root/linked'),
  }
}

async function round(arm: Arm, index: number) {
  const p = paths(arm, index)

  if (arm === 'rebuild') {
    rmSync(p.root, { recursive: true, force: true })
    mkdirSync(p.root, { recursive: true })
  }
  if (arm === 'sibling') {
    // created once, before the round, and never removed
    mkdirSync(p.root, { recursive: true })
    mkdirSync(p.target, { recursive: true })
  }

  writeFileSync(resolve(p.target, 'file.ts'), '')
  rmSync(p.link, { recursive: true, force: true })
  writeFileSync(p.link, '')

  const seen: string[] = []
  const raw: string[] = []
  const watcher = watch(p.root, { ignoreInitial: true, ignored: makeIgnored(p.root) })
  watcher.on('raw', () => raw.push('1'))
  watcher.on('all', (_e: string, path: string) => { if (/file/.test(path)) seen.push(path) })
  await new Promise<void>((done) => watcher.once('ready', () => done()))

  rmSync(p.link)
  symlinkSync(p.target, p.link, 'junction')

  let writes = 0
  for (; writes < BUDGET; writes++) {
    if (seen.length) break
    writeFileSync(resolve(p.target, 'file.ts'), `v${writes}`)
    await new Promise(r => setTimeout(r, 100))
  }

  let watched = 0
  try { watched = Object.keys(watcher.getWatched()).length } catch { watched = -1 }
  await watcher.close()
  rmSync(p.link, { recursive: true, force: true })
  return { ok: seen.length > 0, writes, raw: raw.length, watched }
}

const ARMS: Arm[] = ['keep', 'rebuild', 'sibling']

describe('is the 100 % the watcher or the harness', () => {
  beforeAll(() => {
    rmSync(base, { recursive: true, force: true })
    // `keep` gets its two directories once, as the spec's fixture does
    mkdirSync(resolve(base, 'keep/root'), { recursive: true })
    mkdirSync(resolve(base, 'keep/target'), { recursive: true })
    // `sibling` needs one pair per round, all created now and never touched again
    for (let i = 0; i < ROUNDS; i++) {
      mkdirSync(resolve(base, `s${i}/root`), { recursive: true })
      mkdirSync(resolve(base, `s${i}/target`), { recursive: true })
    }
  })

  for (const arm of ARMS) {
    for (let index = 0; index < ROUNDS; index++) {
      it(`${arm} ${index}`, async () => {
        const r = await round(arm, index)
        console.log(
          `@@HB ${arm} ${index} ${r.writes >= BUDGET ? 'timeout' : 'pass'}` +
          ` writes=${r.writes} raw=${r.raw} watched=${r.watched} ${TAG}@@`,
        )
      }, 30000)
    }
  }
})
