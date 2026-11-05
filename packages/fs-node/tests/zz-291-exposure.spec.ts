import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, posix, relative, resolve, sep } from 'node:path'
import { beforeAll, describe, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { watch } from 'chokidar'
import picomatch from 'picomatch'
import { platform, release } from 'node:os'

// How far does the unbound subtree reach?
//
// `getWatched()` at `ready` is the reading that explains everything else, so it
// is taken once per platform before anything is changed. In the case the entry
// is a *plain file* when the scan runs, so it is added as a file and no
// directory watch is created for it; after the replacement a watch has to be
// created, and that is the step a sub-frame window can swallow. When the entry
// is already a link, the directory watch exists from the start and there is
// nothing to create — which is why that shape never fails.
//
// The fixture is built once per arm and only touched afterwards: an earlier
// version rebuilt the root every round, which changes the root's inode and made
// every round fail on Windows. That was the probe, not the platform.
//
//   imm        entry is a file; replace it into a link, at once   (the case)
//   replace50  the same, 50 ms later
//   under0     entry is a link from the start; edit a file under it, at once
//   under50    the same, 50 ms later
//   deep0      the same, one directory deeper
//   bound      no change: what getWatched() holds at ready

const testDir = dirname(fileURLToPath(import.meta.url))
const base = resolve(testDir, '__exp291__')
const ROUNDS = Number(process.env.EXP_ROUNDS || 100)
const BUDGET = 40
const TAG = `${platform()}-${release().split('.')[0]}-${process.version.slice(1)}`

const match = picomatch('linked/**/*.ts', { posix: true })

function contains(a: string, b: string) {
  return !a || b === a || b.startsWith(a + '/')
}

function keep(path: string, isDirectory: boolean) {
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
    // the separator follows the platform; chokidar compares posix-style
    const rel = relative(root, path).split(sep).join(posix.sep)
    return !keep(rel, isDirectory)
  }
}

type Arm = 'imm' | 'replace50' | 'under0' | 'under50' | 'deep0' | 'bound'

// built once, before any round; a round only ever touches what it must
const FIXTURE = resolve(base, 'fx')
const ROOT = resolve(FIXTURE, 'root')
const TARGET = resolve(FIXTURE, 'target')
const NESTED = resolve(TARGET, 'sub')
const LINK = resolve(ROOT, 'linked')

function build(entryIsLink: boolean) {
  rmSync(LINK, { recursive: true, force: true })
  if (entryIsLink) symlinkSync(TARGET, LINK, 'junction')
  else writeFileSync(LINK, '')
}

async function round(arm: Arm) {
  const probe = resolve(TARGET, 'probe.ts')
  const deepProbe = resolve(NESTED, 'probe.ts')
  rmSync(probe, { force: true })
  rmSync(deepProbe, { force: true })

  build(arm === 'under0' || arm === 'under50' || arm === 'deep0' || arm === 'bound')

  const seen: string[] = []
  const watcher = watch(ROOT, { ignoreInitial: true, ignored: makeIgnored(ROOT) })
  watcher.on('all', (_event: string, path: string) => { if (/probe/.test(path)) seen.push(path) })
  await new Promise<void>((done) => watcher.once('ready', () => done()))

  const keys = Object.keys(watcher.getWatched())
  const bound = {
    count: keys.length,
    hasLink: keys.some((k) => /[\\/]linked$/.test(k) || k === 'linked'),
    hasSub: keys.some((k) => /[\\/]linked[\\/]sub$/.test(k)),
  }

  if (arm === 'bound') {
    await watcher.close()
    return { bound, writes: 0 }
  }

  const act = () => {
    if (arm === 'imm' || arm === 'replace50') {
      rmSync(LINK, { recursive: true, force: true })
      symlinkSync(TARGET, LINK, 'junction')
    } else if (arm === 'deep0') {
      writeFileSync(deepProbe, 'x')
    } else {
      writeFileSync(probe, 'x')
    }
  }

  if (arm === 'replace50' || arm === 'under50') {
    await new Promise(r => setTimeout(r, 50))
  }
  act()

  let writes = 0
  for (; writes < BUDGET; writes++) {
    if (seen.length) break
    await new Promise(r => setTimeout(r, 100))
  }

  await watcher.close()
  return { bound, writes }
}

const ARMS: Arm[] = ['imm', 'replace50', 'under0', 'under50', 'deep0']

describe('how far the unbound subtree reaches', () => {
  beforeAll(() => {
    rmSync(base, { recursive: true, force: true })
    mkdirSync(ROOT, { recursive: true })
    mkdirSync(NESTED, { recursive: true })
    writeFileSync(resolve(TARGET, 'file.ts'), '')
    writeFileSync(resolve(NESTED, 'deep.ts'), '')
  })

  it(`bound ${TAG}`, async () => {
    const r = await round('bound')
    console.log(`@@EX bound ${TAG} count=${r.bound.count} link=${r.bound.hasLink ? 'L' : 'n'} sub=${r.bound.hasSub ? 'L' : 'n'}@@`)
  }, 20000)

  for (const arm of ARMS) {
    for (let index = 0; index < ROUNDS; index++) {
      it(`${arm} ${index}`, async () => {
        const r = await round(arm)
        console.log(
          `@@EX ${arm} ${index} ${r.writes >= BUDGET ? 'timeout' : 'pass'}` +
          ` writes=${r.writes} count=${r.bound.count} link=${r.bound.hasLink ? 'L' : 'n'}` +
          ` sub=${r.bound.hasSub ? 'L' : 'n'} tag=${TAG}@@`,
        )
      }, 30000)
    }
  }
})
