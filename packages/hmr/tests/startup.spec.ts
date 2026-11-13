import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import Hmr from '../src/index.ts'

// Two ways to fail, and one message for both, was the defect: a process too old to
// run HMR was told to pass `--expose-internals`, which it had. The floor now speaks
// for itself, so the two failures are told apart by what they say.
function withNodeVersion<T>(version: string, run: () => Promise<T>): Promise<T> {
  const original = process.versions.node
  Object.defineProperty(process.versions, 'node', { value: version, configurable: true })
  return run().finally(() => {
    Object.defineProperty(process.versions, 'node', { value: original, configurable: true })
  })
}

describe('Hmr startup', () => {
  it('names the Node floor instead of asking for a flag', async () => {
    await withNodeVersion('20.19.0', async () => {
      const ctx = new Context()
      await expect(ctx.plugin(Hmr, { watch: { enabled: false } }))
        .rejects.toThrow('HMR needs Node.js 22 or later; this process is 20.19.0')
    })
  })

  // Without this arm, a constructor that always threw the version message would pass
  // the case above. Node 22 is what the test process runs on.
  it('does not blame the version on a supported Node', async () => {
    expect(Number(process.versions.node.split('.')[0])).to.be.at.least(22)
    const ctx = new Context()
    let message = ''
    try {
      await ctx.plugin(Hmr, { watch: { enabled: false } })
    } catch (error: any) {
      message = String(error?.message)
    }
    expect(message, 'a supported Node must not be reported as too old').to.not.include('Node.js 22 or later')
  })
})
