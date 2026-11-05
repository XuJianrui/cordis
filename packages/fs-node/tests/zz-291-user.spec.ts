import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { beforeAll, describe, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { watch } from 'chokidar'
import picomatch from 'picomatch'

// The user's case, not the test's.
//
// Every round so far replaced the entry in the same instant `ready` fired — that
// is what the spec does, and it is why the window is exposed. A user does not do
// that: they create a watcher, and then at some arbitrary later moment something
// changes on disk. So the question that matters for this library's users is not
// "how wide is the window" but "does anything go wrong outside it".
//
//   imm       replace as soon as ready fires        (the spec's shape; control)
//   late500   replace 500 ms later                  (a user's shape)
//   late2000  replace 2 s later                     (a user's shape, colder)
//   write0    write to an existing file at once      (the commonest user action)
//   create0   create a new file at once              (the next commonest)
//
// If the three user arms are all clean at this sample size while `imm` fails,
// then the defect is reachable from the test and not from ordinary use, and the
// two have to be reported separately.

const testDir = dirname(fileURLToPath(import.meta.url))
const base = resolve(testDir, '__user291__')
const ROUNDS = Number(process.env.USER_ROUNDS || 120)
const BUDGET = 40

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
    return !keep(relative(root, path).split(sep).join('/'), isDirectory)
  }
}

type Arm = 'imm' | 'late500' | 'late2000' | 'write0' | 'create0'

async function round(arm: Arm) {
  const root = resolve(base, `${arm}/relinked/root`)
  const target = resolve(base, `${arm}/relinked/target/file.ts`)
  const link = resolve(root, 'linked')
  const fresh = resolve(root, 'fresh.ts')

  rmSync(fresh, { force: true })
  writeFileSync(target, '')
  rmSync(link, { recursive: true, force: true })
  writeFileSync(link, '')

  const seen: string[] = []
  const raw: string[] = []
  const watcher = watch(root, { ignoreInitial: true, ignored: makeIgnored(root) })
  watcher.on('raw', () => raw.push('1'))
  watcher.on('all', (_event: string, path: string) => { if (/file|fresh/.test(path)) seen.push(path) })
  await new Promise<void>((done) => watcher.once('ready', () => done()))

  if (arm === 'imm') {
    rmSync(link)
    symlinkSync(dirname(target), link, 'junction')
  } else if (arm === 'late500' || arm === 'late2000') {
    await new Promise(r => setTimeout(r, arm === 'late500' ? 500 : 2000))
    rmSync(link)
    symlinkSync(dirname(target), link, 'junction')
  } else if (arm === 'write0') {
    writeFileSync(link, 'v0')
  } else {
    writeFileSync(fresh, 'v0')
  }

  let writes = 0
  for (; writes < BUDGET; writes++) {
    if (seen.length) break
    if (arm === 'write0') writeFileSync(link, `w${writes}`)
    else if (arm === 'create0') writeFileSync(fresh, `w${writes}`)
    else writeFileSync(target, `w${writes}`)
    await new Promise(r => setTimeout(r, 100))
  }

  await watcher.close()
  rmSync(fresh, { force: true })
  return { ok: seen.length > 0, writes, raw: raw.length }
}

const ARMS: Arm[] = ['imm', 'late500', 'late2000', 'write0', 'create0']

describe('the user case: a change at an arbitrary later moment', () => {
  beforeAll(() => {
    rmSync(base, { recursive: true, force: true })
    for (const arm of ARMS) {
      mkdirSync(resolve(base, `${arm}/relinked/root`), { recursive: true })
      mkdirSync(resolve(base, `${arm}/relinked/target`), { recursive: true })
    }
  })

  for (const arm of ARMS) {
    for (let index = 0; index < ROUNDS; index++) {
      it(`${arm} ${index}`, async () => {
        const r = await round(arm)
        console.log(`@@US ${arm} ${index} ${r.writes >= BUDGET ? 'timeout' : 'pass'} writes=${r.writes} raw=${r.raw}@@`)
      }, 30000)
    }
  }
})
