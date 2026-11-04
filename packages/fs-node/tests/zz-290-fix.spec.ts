import { Context, Fiber } from 'cordis'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { afterAll, describe, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import Fs, { WatchOptions } from '../src/index.ts'

// The case exactly as `watch.spec.ts` has it — flat layout, one directory
// between the temp root and the watched tree — repeated so a change in the
// miss rate is visible.
//
// `#291` measured this layout at 48% over 48 rounds. A fix has to move that,
// not the deepened layout.

const testDir = dirname(fileURLToPath(import.meta.url))
const base = resolve(testDir, '__probe290fix__')
const ROUNDS = Number(process.env.PROBE_ROUNDS || 40)

let unique = 0

async function once() {
  const n = `${process.pid}-${Date.now()}-${++unique}`
  const root = resolve(base, n)
  const target = resolve(root, 'target/file.ts')
  const link = resolve(root, 'root/linked')
  mkdirSync(dirname(target), { recursive: true })
  mkdirSync(dirname(link), { recursive: true })
  writeFileSync(target, 'v')
  writeFileSync(link, 'f')

  const ctxRoot = new Context()
  ctxRoot.baseUrl = import.meta.url
  const fiber: Fiber<Context> = await ctxRoot.plugin(Fs)
  let ctx!: Context
  await ctxRoot.inject(['fs'], (inner) => { ctx = inner })

  const seen: string[] = []
  const watcher = ctx.fs.watch(dirname(link), { filter: ['linked/**/*.ts'] } as WatchOptions)
  watcher.on('change', (filename: string) => seen.push(filename))
  await new Promise<void>((done) => watcher.on('ready', done))

  let delivered = false
  try {
    rmSync(link, { force: true })
    symlinkSync(dirname(target), link, 'junction')
    for (let i = 0; i < 80; i++) {
      writeFileSync(target, `w${i}`)
      await new Promise(r => setTimeout(r, 100))
      if (seen.length) break
    }
    delivered = seen.includes(resolve(link, 'file.ts'))
  } finally {
    await fiber.dispose()
    try { rmSync(root, { recursive: true, force: true }) } catch {}
  }
  return delivered
}

describe('relink, flat layout', () => {
  afterAll(() => { rmSync(base, { recursive: true, force: true }) })

  it(`runs ${ROUNDS} rounds`, async () => {
    let ok = 0
    for (let i = 0; i < ROUNDS; i++) if (await once()) ok++
    console.log('\n@@PROBE290FIX@@\n' + [
      `platform=${process.platform} node=${process.version}`,
      `flat pass=${ok}/${ROUNDS}`,
    ].join('\n') + '\n@@END@@\n')
  }, 900000)
})
