import { Context, FiberState } from '../src'
import { describe, expect, it } from 'vitest'
import { mock } from 'node:test'

describe('Fiber: concurrent updates', () => {
  // #34: a restart during loading must not disappear when dependencies match.
  it.each([false, true])('settles concurrent updates on the latest config (inject: %s)', async (inject) => {
    const root = new Context()
    root.provide('foo', 1)
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const latestStarted = Promise.withResolvers<void>()
    const latestRelease = Promise.withResolvers<void>()
    const applied: number[] = []
    const disposed: number[] = []
    const settled = mock.fn()
    const fiber = await root.plugin({
      inject: inject ? ['foo'] : [],
      async apply(ctx: Context, config: { value: number }) {
        applied.push(config.value)
        if (inject) expect(ctx.foo).to.equal(1)
        if (config.value === 1) {
          started.resolve()
          await release.promise
        } else if (config.value === 3) {
          latestStarted.resolve()
          await latestRelease.promise
        }
        return () => { disposed.push(config.value) }
      },
    }, { value: 0 })

    const first = Promise.resolve(fiber.update({ value: 1 })).then(settled)
    await started.promise
    const second = Promise.resolve(fiber.update({ value: 2 })).then(settled)
    const third = Promise.resolve(fiber.update({ value: 3 })).then(settled)
    release.resolve()
    await latestStarted.promise

    expect(applied).to.deep.equal([0, 1, 3])
    expect(disposed).to.deep.equal([0, 1])
    expect(settled.mock.calls).to.have.length(0)
    expect(fiber.state).to.equal(FiberState.LOADING)
    latestRelease.resolve()
    await Promise.all([first, second, third])

    expect(settled.mock.calls).to.have.length(3)
    expect(fiber.config).to.deep.equal({ value: 3 })
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    await root.fiber.dispose()
    expect(disposed).to.deep.equal([0, 1, 3])
  })

  it('skips superseded loads before executing the plugin', async () => {
    const root = new Context()
    const applied: number[] = []
    const fiber = root.plugin((_ctx, config: { value: number }) => {
      applied.push(config.value)
    }, { value: 1 })
    const first = fiber.update({ value: 2 })
    const second = fiber.update({ value: 3 })
    await Promise.all([first, second, fiber.await()])

    expect(applied).to.deep.equal([3])
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    await root.fiber.dispose()
  })

  it('coalesces updates during unloading', async () => {
    const root = new Context()
    const unloading = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const applied: number[] = []
    const fiber = await root.plugin((_ctx, config: { value: number }) => {
      applied.push(config.value)
      return async () => {
        if (config.value !== 0) return
        unloading.resolve()
        await release.promise
      }
    }, { value: 0 })

    const first = fiber.update({ value: 1 })
    await unloading.promise
    const second = fiber.update({ value: 2 })
    expect(applied).to.deep.equal([0])
    expect(fiber.state).to.equal(FiberState.UNLOADING)
    release.resolve()
    await Promise.all([first, second])

    expect(applied).to.deep.equal([0, 2])
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    await root.fiber.dispose()
  })

  it.each(['restart', 'config ABA'])('honors %s while loading even when config is unchanged', async (mode) => {
    const root = new Context()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const original = { value: 1 }
    const applied: number[] = []
    const fiber = root.plugin(async (_ctx, config: { value: number }) => {
      applied.push(config.value)
      started.resolve()
      await release.promise
    }, original)

    await started.promise
    const updates = mode === 'restart'
      ? [fiber.restart()]
      : [fiber.update({ value: 2 }), fiber.update(original)]
    release.resolve()
    await Promise.all(updates)

    expect(applied).to.deep.equal([1, 1])
    expect(fiber.config).to.equal(original)
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    await root.fiber.dispose()
  })

  it('cleans up a superseded failure without failing the latest update', async () => {
    const root = new Context()
    const logged = mock.fn()
    ;(root.logger as any).error = logged
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const failure = new Error('superseded load')
    const applied: number[] = []
    const disposed: number[] = []
    const fiber = root.plugin(async (ctx, config: { value: number }) => {
      applied.push(config.value)
      ctx.effect(() => () => { disposed.push(config.value) })
      if (config.value !== 1) return
      started.resolve()
      await release.promise
      throw failure
    }, { value: 1 })

    await started.promise
    const updating = fiber.update({ value: 2 })
    release.resolve()
    await Promise.all([updating, fiber.await()])

    expect(applied).to.deep.equal([1, 2])
    expect(disposed).to.deep.equal([1])
    expect(logged.mock.calls).to.have.length(1)
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    await root.fiber.dispose()
    expect(disposed).to.deep.equal([1, 2])
  })

  it('rejects all waiting updates when the latest load fails', async () => {
    const root = new Context()
    ;(root.logger as any).error = mock.fn()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const applied: number[] = []
    const disposed: number[] = []
    const fiber = await root.plugin(async (ctx, config: { value: number }) => {
      applied.push(config.value)
      ctx.effect(() => () => { disposed.push(config.value) })
      if (config.value === 1) {
        started.resolve()
        await release.promise
      } else if (config.value === 2) {
        throw new Error('latest load failed')
      }
    }, { value: 0 })

    const first = fiber.update({ value: 1 })
    await started.promise
    const second = fiber.update({ value: 2 })
    const results = Promise.allSettled([first, second])
    release.resolve()

    for (const result of await results) {
      expect(result.status).to.equal('rejected')
      if (result.status === 'rejected') {
        expect(result.reason.message).to.equal('latest load failed')
      }
    }
    expect(applied).to.deep.equal([0, 1, 2])
    expect(disposed).to.deep.equal([0, 1, 2])
    expect(fiber.state).to.equal(FiberState.FAILED)
    await root.fiber.dispose()
  })

  it('stops advancing an outdated async generator and collects its final yield', async () => {
    const root = new Context()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const events: string[] = []
    const fiber = root.plugin(async function* (_ctx, config: { value: number }) {
      events.push(`load ${config.value}`)
      if (config.value !== 1) return
      started.resolve()
      await release.promise
      yield () => { events.push('dispose 1') }
      events.push('outdated continuation')
    }, { value: 1 })

    await started.promise
    const updating = fiber.update({ value: 2 })
    release.resolve()
    await updating

    expect(events).to.deep.equal(['load 1', 'dispose 1', 'load 2'])
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    await root.fiber.dispose()
  })

  it('waits for dependencies and loads only the latest config', async () => {
    const root = new Context()
    const applied: number[] = []
    const fiber = root.plugin({
      inject: ['foo'],
      apply(ctx: Context, config: { value: number }) {
        expect(ctx.foo).to.equal('available')
        applied.push(config.value)
      },
    }, { value: 0 })

    await Promise.all([fiber.update({ value: 1 }), fiber.update({ value: 2 })])
    expect(fiber.state).to.equal(FiberState.PENDING)
    expect(applied).to.deep.equal([])
    root.provide('foo', 'available')
    await fiber

    expect(applied).to.deep.equal([2])
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    await root.fiber.dispose()
  })

  it('does not restart when a listener accepts an update during loading', async () => {
    const root = new Context()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const applied: number[] = []
    const received: number[] = []
    const fiber = root.plugin(async (ctx, config: { value: number }) => {
      applied.push(config.value)
      ctx.on('internal/update', (config) => { received.push(config.value) })
      started.resolve()
      await release.promise
    }, { value: 1 })

    await started.promise
    await fiber.update({ value: 2 })
    release.resolve()
    await fiber

    expect(applied).to.deep.equal([1])
    expect(received).to.deep.equal([2])
    expect(fiber.config).to.deep.equal({ value: 2 })
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    await root.fiber.dispose()
  })

  it('does not load a queued config after disposal', async () => {
    const root = new Context()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const applied: number[] = []
    const disposed = mock.fn()
    const fiber = root.plugin(async (_ctx, config: { value: number }) => {
      applied.push(config.value)
      started.resolve()
      await release.promise
      return disposed
    }, { value: 1 })

    await started.promise
    const updating = fiber.update({ value: 2 })
    const disposing = fiber.dispose()
    release.resolve()
    await Promise.all([updating, disposing])

    expect(applied).to.deep.equal([1])
    expect(disposed.mock.calls).to.have.length(1)
    expect(fiber.state).to.equal(FiberState.DISPOSED)
    await root.fiber.dispose()
  })
})

// ---- D/E-probe: where a post-dispose write lands ----
import { expect, it } from 'vitest'

// Questioning my own claim. I wrote "the model says the work runs to
// completion, but core's provide() does not go through assertActive, so the
// model and the implementation disagree". That is an inference from reading
// two things. Measure it instead.
//
// If the resumed handler's write is genuinely lost, then:
//
//   D1  where did it go? the fiber's own store, or the root registry?
//   D2  is it observable by anyone? (a service another fiber reads)
//   D3  does the fiber's own ctx still resolve it?
//   D4  does the fiber re-appear in the registry (i.e. resurrect)?
//
// And the sharper question: is the *effect* cleanup ordered before the resume?
// If yes, the handler runs against a context whose effects are already gone --
// which is the strongest form of "resumes against a disposed context".

it('probe D: where does a post-dispose write actually land', async () => {
  const root = new Context()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const order: string[] = []
  let storeHas = false
  let rootHas = false
  let ownCtxHas: unknown = 'unset'
  let uidDuringResume: unknown = 'unset'

  const fiber = await root.plugin((ctx: any) => {
    ctx.effect(() => {
      order.push('effect:installed')
      return () => order.push('effect:cleaned')
    })
    ctx.on('internal/update', async () => {
      started.resolve()
      await release.promise
      order.push('handler:resumed')
      uidDuringResume = fiber.uid
      ctx.provide('svc', 'from-resumed')
      // D1: did it land in this fiber's own store?
      storeHas = Object.prototype.hasOwnProperty.call(
        (fiber as any)._store ?? {}, 'svc')
      // D2: observable at the root?
      rootHas = root.registry.has('svc')
      // D3: through the fiber's own ctx?
      try {
        ownCtxHas = ctx.svc
      } catch (error) {
        ownCtxHas = `threw:${(error as Error).message}`
      }
    })
  }, { value: 1 })

  const updating = fiber.update({ value: 2 })
  await started.promise
  const disposing = fiber.dispose()
  release.resolve()
  await Promise.all([updating, disposing]).catch(() => {})
  await new Promise(r => setTimeout(r, 30))

  console.log('D0 ORDER', JSON.stringify(order))
  console.log('D1 STORE_HAS', storeHas)
  console.log('D2 ROOT_HAS', rootHas)
  console.log('D3 OWN_CTX', JSON.stringify(ownCtxHas))
  console.log('D4 UID_DURING_RESUME', uidDuringResume)
  console.log('D5 ROOT_HAS_AFTER_SETTLE', root.registry.has('svc'))
  console.log('D6 FIBER_STATE', fiber.state)
  expect(true).to.equal(true)
})

// The comparison case: the SAME provide from a handler whose fiber is still
// alive. If this one lands, the difference is liveness, not the update path.
it('probe E: the same write while the fiber is alive', async () => {
  const root = new Context()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let rootHasDuring = false
  let ownCtxHas: unknown = 'unset'
  let uidDuring: unknown = 'unset'

  const fiber = await root.plugin((ctx: any) => {
    ctx.on('internal/update', async () => {
      started.resolve()
      await release.promise
      uidDuring = fiber.uid
      ctx.provide('svc2', 'from-alive')
      rootHasDuring = root.registry.has('svc2')
      ownCtxHas = ctx.svc2
    })
  }, { value: 1 })

  const updating = fiber.update({ value: 2 })
  await started.promise
  release.resolve()
  await updating
  await fiber.await()
  await new Promise(r => setTimeout(r, 30))

  console.log('E0 UID_DURING', uidDuring)
  console.log('E1 ROOT_HAS_DURING', rootHasDuring)
  console.log('E2 OWN_CTX', JSON.stringify(ownCtxHas))
  console.log('E3 ROOT_HAS_AFTER', root.registry.has('svc2'))
  console.log('E4 STATE', fiber.state)
  expect(true).to.equal(true)
})
