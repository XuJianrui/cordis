import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

const base = mkdtempSync(join(tmpdir(), 'zz-sym-'))

// Which shapes can this platform create, and what does a watch report when a file becomes each of
// them. Prints one @@SYM line per shape; a shape that cannot be created prints SKIP with the code.
describe('file replaced by each link shape', () => {
  it('reports per shape', async () => {
    const { Context } = await import('cordis')
    const Fs = (await import('../src/index.ts')).default
    const ctx = new Context()
    await ctx.plugin(Fs)
    mkdirSync(base, { recursive: true })

    const target = join(base, 'target.txt')
    writeFileSync(target, 'target')
    const dirTarget = join(base, 'dir')
    mkdirSync(dirTarget)

    const shapes: [string, (p: string) => void][] = [
      ['hard link to a file', (p) => linkSync(target, p)],
      ['symlink to a file', (p) => symlinkSync(target, p, 'file')],
      ['broken symlink', (p) => symlinkSync(join(base, 'nope.txt'), p, 'file')],
      ['junction to a dir', (p) => symlinkSync(dirTarget, p, 'junction')],
    ]

    for (const [label, make] of shapes) {
      const path = join(base, label.replace(/[^a-z0-9]+/gi, '-') + '.txt')
      writeFileSync(path, 'v0')
      const watcher = ctx.fs.watch(path)
      const heard: string[] = []
      watcher.on('change', (f: string) => heard.push(f))
      await new Promise<void>((r) => watcher.on('ready', () => r()))
      await new Promise((r) => setTimeout(r, 150))
      const before = heard.length

      rmSync(path)
      let skipped = ''
      try { make(path) } catch (error: any) { skipped = error?.code ?? 'ERR' }
      if (skipped) {
        console.log(`@@SYM ${label} SKIP ${skipped}`)
        await watcher.dispose()
        continue
      }
      await new Promise((r) => setTimeout(r, 400))
      try { writeFileSync(path, 'v1') } catch {}
      await new Promise((r) => setTimeout(r, 400))
      console.log(`@@SYM ${label} reports=${heard.length - before} stale=${watcher.stale} shape=${watcher.shape}`)
      await watcher.dispose()
    }
    console.log(`@@SYM platform=${process.platform}`)
  }, 90000)
})
