import { mkdirSync, rmSync, symlinkSync, watch as bareWatch, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { beforeAll, describe, it } from 'vitest'
import { fileURLToPath } from 'node:url'

// Can the platform deliver an event about the file below the link at all?
//
// An earlier control answered a weaker question and I read it as this one: it
// watched the directory, and stopped at the first event of any kind. Removing
// `linked` fires a rename on that directory, so the control was satisfied by
// the replacement itself and never had to report anything about the file.
//
// Here the pass condition is an event whose path names the file, and the arms
// separate what the platform can and cannot do:
//
//   target      watch the real directory: writes must be reported (sanity)
//   link-after  watch the link path, created after the replacement
//   dir-rec     watch the root recursively, created after the replacement
//   link-before watch the link path, created before the replacement

const testDir = dirname(fileURLToPath(import.meta.url))
const base = resolve(testDir, '__plat291__')
const ROUNDS = 20
const BUDGET = 40

const root = resolve(base, 'relinked/root')
const target = resolve(base, 'relinked/target')
const file = resolve(target, 'file.ts')
const link = resolve(root, 'linked')

// an event counts only if it is about the file, not about the link
function names(event: string, path: string) {
  return /file/.test(String(path)) || /file/.test(String(event))
}

async function writes(count: number, hits: () => number) {
  for (let i = 0; i < count; i++) {
    if (hits() > 0) return true
    writeFileSync(file, `v${i}`)
    await new Promise(r => setTimeout(r, 100))
  }
  return hits() > 0
}

function reset() {
  writeFileSync(file, '')
  rmSync(link, { recursive: true, force: true })
  writeFileSync(link, '')
}

describe('platform delivery through a replaced link', () => {
  beforeAll(() => {
    rmSync(base, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    mkdirSync(target, { recursive: true })
  })

  for (let i = 0; i < ROUNDS; i++) {
    it(`target ${i}`, async () => {
      reset()
      let hits = 0
      const w = bareWatch(target, (event, path) => { if (names(event, path!)) hits++ })
      rmSync(link)
      symlinkSync(target, link, 'junction')
      const ok = await writes(BUDGET, () => hits)
      w.close()
      console.log(`@@PL target ${i} ${ok ? 'pass' : 'lost'} hits=${hits}@@`)
    }, 20000)
  }

  for (let i = 0; i < ROUNDS; i++) {
    it(`link-after ${i}`, async () => {
      reset()
      rmSync(link)
      symlinkSync(target, link, 'junction')
      let hits = 0
      const w = bareWatch(link, (event, path) => { if (names(event, path!)) hits++ })
      const ok = await writes(BUDGET, () => hits)
      w.close()
      console.log(`@@PL link-after ${i} ${ok ? 'pass' : 'lost'} hits=${hits}@@`)
    }, 20000)
  }

  for (let i = 0; i < ROUNDS; i++) {
    it(`dir-rec ${i}`, async () => {
      reset()
      rmSync(link)
      symlinkSync(target, link, 'junction')
      let hits = 0
      let w: ReturnType<typeof bareWatch>
      try {
        w = bareWatch(root, { recursive: true }, (event, path) => { if (names(event, path!)) hits++ })
      } catch {
        console.log(`@@PL dir-rec ${i} unsupported@@`)
        return
      }
      const ok = await writes(BUDGET, () => hits)
      w.close()
      console.log(`@@PL dir-rec ${i} ${ok ? 'pass' : 'lost'} hits=${hits}@@`)
    }, 20000)
  }

  for (let i = 0; i < ROUNDS; i++) {
    it(`link-before ${i}`, async () => {
      reset()
      let hits = 0
      const w = bareWatch(link, (event, path) => { if (names(event, path!)) hits++ })
      rmSync(link)
      symlinkSync(target, link, 'junction')
      const ok = await writes(BUDGET, () => hits)
      w.close()
      console.log(`@@PL link-before ${i} ${ok ? 'pass' : 'lost'} hits=${hits}@@`)
    }, 20000)
  }
})
