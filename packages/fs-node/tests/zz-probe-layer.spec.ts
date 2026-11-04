import { describe, it, expect } from 'vitest'
import { Context } from '../../core/src/index.ts'
import Fs from '../src/index.ts'
import { mkdtempSync, rmSync, watch as fsWatch, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import chokidar from 'chokidar'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const WRITES = 30
const GAP = 250

describe('mechanism: which layer stops delivering', () => {
  it('counts callbacks per layer for the same sequence of writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe262-layer-'))
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'v0')

    const layer = {
      L0_fileRaw: 0,
      L1_dirRaw: 0,
      L2_chokidar: 0,
      L3_ctxfs: 0,
      writes: 0,
    }

    const w0 = fsWatch(file, () => {
      layer.L0_fileRaw += 1
    })
    const w1 = fsWatch(dir, () => {
      layer.L1_dirRaw += 1
    })

    const w2 = chokidar.watch(dir, {
      ignoreInitial: true,
      depth: 0,
      ignored: (path) => {
        path = resolve(path)
        return path !== dir && path !== file
      },
    })
    await new Promise((r) => w2.once('ready', () => r(undefined)))

    const bumpL2 = () => {
      layer.L2_chokidar += 1
    }
    w2.on('add', bumpL2)
    w2.on('change', bumpL2)

    const ctx = new Context()
    await ctx.plugin(Fs)
    const fs = ctx.get('fs')
    const stop3 = await fs.watch(file, () => {
      layer.L3_ctxfs += 1
    })

    try {
      for (let i = 1; i <= WRITES; i += 1) {
        await writeFile(file, 'v' + i + 'y'.repeat(i % 40))
        layer.writes = i
        await sleep(GAP)
        console.log('ADJ_LAYER =', JSON.stringify({ i, ...layer }))
      }
    } finally {
      await stop3()
      await w2.close()
      w0.close()
      w1.close()
      rmSync(dir, { recursive: true, force: true })
    }

    expect(WRITES).toBe(30)
  }, 120_000)
})
