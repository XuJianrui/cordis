// Probe: the decision table's "status quo" for 6c must name the right actor.
//
//   (1) Does node:fs/promises writeFile create a missing parent?  -> expected ENOENT
//   (2) Does cordis expose ctx.fs.writeFile at all?               -> expected: no
//   (3) Do the two real writers reach node:fs directly?           -> by import, checked separately
//
// (2) matters because the draft's table said "writeFile does not create missing
// parents today" as if that were Cordis behaviour; there is no such method.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { Context, Service } from '../../core/src/index.ts'
import Fs from '../src/index.ts'

describe('6c: who owns the missing-parent behaviour', () => {
  it('node writeFile throws ENOENT on a missing parent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe262-6c-'))
    try {
      const target = join(dir, 'missing-sub', 'file.txt')
      let code = 'NO ERROR'
      try {
        await writeFile(target, 'x')
      } catch (e: any) {
        code = e.code
      }
      console.log('NODE_WRITEFILE_MISSING_PARENT =', code)
      expect(code).toBe('ENOENT')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ctx.fs exposes watch and nothing else', async () => {
    const ctx = new Context()
    await ctx.plugin(Fs)
    const fs: any = ctx.get('fs')
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(fs))
      .filter((k) => k !== 'constructor' && typeof fs[k] === 'function')
    console.log('CTX_FS_METHODS =', JSON.stringify(methods))
    console.log('HAS_WRITEFILE =', typeof fs.writeFile)
    console.log('HAS_READFILE =', typeof fs.readFile)
    console.log('HAS_STAT =', typeof fs.stat)
    expect(typeof fs.writeFile).toBe('undefined')
    expect(typeof fs.watch).toBe('function')
  })
})
