import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { beforeAll, describe, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { watch } from 'chokidar'

// Is the watch live by the time `ready` resolves?
//
// 800 rounds of the case gave a clean split: every pass had raw events, every
// failure had none — the watch on the root never fired at all, on a directory
// that is created once and never touched. Rounds that watch a never-before-seen
// root fail at the same rate as rounds that reuse one, so the state is made
// inside a round, not inherited.
//
// That leaves one candidate: `ready` resolves before the watch is armed, so a
// mutation in that window is missed and never rescanned. It is testable without
// the case: after `ready`, write a file straight into the watched directory and
// see whether it is reported.
//
//   at0    write as soon as `ready` resolves
//   at100  write 100 ms later
//
// If `at0` misses sometimes and `at100` never does, `ready` is early, and every
// reading that was taken right after `ready` inherits that window.

const testDir = dirname(fileURLToPath(import.meta.url))
const base = resolve(testDir, '__live291__')
const ROUNDS = Number(process.env.LIVE_ROUNDS || 200)
const WAIT = 600

async function probe(dir: string, delay: number) {
  const scratch = resolve(dir, 'scratch.ts')
  rmSync(scratch, { force: true })
  const seen: string[] = []
  const watcher = watch(dir, { ignoreInitial: true })
  watcher.on('all', (event: string, path: string) => { if (/scratch/.test(path)) seen.push(`${event}:${path}`) })
  await new Promise<void>((done) => watcher.once('ready', () => done()))
  const armed = Date.now()
  if (delay) await new Promise(r => setTimeout(r, delay))

  writeFileSync(scratch, 'x')
  const deadline = Date.now() + WAIT
  while (!seen.length && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5))
  }
  const ms = Date.now() - armed
  await watcher.close()
  return { live: seen.length > 0, ms }
}

describe('is the watch live when ready resolves', () => {
  beforeAll(() => {
    rmSync(base, { recursive: true, force: true })
    mkdirSync(resolve(base, 'at0'), { recursive: true })
    mkdirSync(resolve(base, 'at100'), { recursive: true })
  })

  for (let i = 0; i < ROUNDS; i++) {
    it(`at0 ${i}`, async () => {
      const { live, ms } = await probe(resolve(base, 'at0'), 0)
      console.log(`@@LV at0 ${i} ${live ? 'live' : 'DEAD'} ms=${ms}@@`)
    }, 30000)
  }

  for (let i = 0; i < ROUNDS; i++) {
    it(`at100 ${i}`, async () => {
      const { live, ms } = await probe(resolve(base, 'at100'), 100)
      console.log(`@@LV at100 ${i} ${live ? 'live' : 'DEAD'} ms=${ms}@@`)
    }, 30000)
  }
})
