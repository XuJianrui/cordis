import { Context, FiberState } from '../src/index.ts'
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

// ---- B/C-probe: disposal guarantees vs the model ----
import { expect, it } from 'vitest'

// Where the paper and #194 disagree about disposal, measured rather than argued.
//
// Paper §4.4 Asynchrony (L2518-2521, L2526-2527):
//   "In an asynchronous host the iterations and the inverses yield futures, so a
//    map in flight runs to completion WHETHER OR NOT IT IS STILL WANTED"
//   "An inverse in flight calls for no counterpart of inertia: THE RULES NEVER
//    DECLINE A DEACTIVATION, UNLOADING being left by L-Unload alone with no
//    premise on the target view"
//
// So the model settles two questions #194 leaves open:
//   Q1  may an inertial host refuse to run work that is no longer wanted?
//       -> no: "never decline"
//   Q2  what happens to work that is in flight when a deactivation begins?
//       -> it completes: "runs to completion whether or not it is still wanted"
//
// #194 issue line 58 asks that older update work "not leave resources running
// after disposal". If the handler's own writes are not a resource the fiber
// owns, Q2 says letting it finish is CORRECT and cancelling it would be the
// deviation. This probe measures whether that reading is self-consistent:
//
//   B1  does the fiber's own effect cleanup still run while the handler is
//       held? (if yes, the fiber's resources do NOT survive disposal)
//   B2  does the handler, resuming afterwards, touch anything the fiber owns?
//   B3  is a write by the resumed handler observable in the registry?
//   B4  does the handler observe itself as running against a dead fiber?

it('probe B: what disposal guarantees, measured', async () => {
  const root = new Context()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const log: string[] = []
  let effectCleanups = 0
  let handlerRuns = 0
  let resumedAfterCleanup = -1

  const fiber = await root.plugin((ctx: any, config: { value: number }) => {
    ctx.effect(() => {
      log.push('effect:installed')
      return () => {
        effectCleanups++
        log.push('effect:cleaned')
      }
    })
    ctx.on('internal/update', async () => {
      handlerRuns++
      started.resolve()
      await release.promise
      // where in the disposal order does this resume?
      resumedAfterCleanup = effectCleanups
      // can the resumed handler still register fiber-scoped work?
      try {
        ctx.on('some/event', () => {})
        log.push('handler:on-after-dispose:ok')
      } catch (error) {
        log.push(`handler:on-after-dispose:${(error as Error).message}`)
      }
      ctx.provide('from-resumed-handler', true)
      log.push('handler:provided')
    })
  }, { value: 1 })

  const updating = fiber.update({ value: 2 })
  await started.promise
  const disposing = fiber.dispose()
  release.resolve()
  await Promise.all([updating, disposing]).catch(() => {})
  await new Promise(r => setTimeout(r, 30))

  console.log('B1 EFFECT_CLEANUPS', effectCleanups)
  console.log('B2 RESUMED_AFTER_CLEANUP', resumedAfterCleanup)
  console.log('B3 PROVIDER_VISIBLE', root.registry.has('from-resumed-handler'))
  console.log('B3b HANDLER_RUNS', handlerRuns)
  console.log('B4 LOG', JSON.stringify(log))
  console.log('B4b STATE', fiber.state)
  console.log('B4c UID', fiber.uid)
  expect(true).to.equal(true)
})

// Does a handler that DOES own resources behave differently? This is the case
// where cancelling work would leak, so it decides whether "cancel on dispose"
// is even safe as a rule.
it('probe C: a handler holding a resource across disposal', async () => {
  const root = new Context()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let released = 0
  let sawState: number[] = []

  const fiber = await root.plugin((ctx: any, config: { value: number }) => {
    ctx.on('internal/update', async () => {
      started.resolve()
      await release.promise
      // the handler itself owns something that must be given back
      try {
        ctx.set('resource', 'held-by-handler')
        sawState.push(fiber.state)
        // and tries to clean it up itself
        ctx.set('resource', undefined)
        released++
      } catch (error) {
        sawState.push(-(error as any)?.code ?? -999)
      }
    })
  }, { value: 1 })

  const updating = fiber.update({ value: 2 })
  await started.promise
  const disposing = fiber.dispose()
  release.resolve()
  await Promise.all([updating, disposing]).catch(() => {})
  await new Promise(r => setTimeout(r, 30))

  console.log('C1 RELEASED_BY_HANDLER', released)
  console.log('C2 STATE_WHEN_RESUMED', JSON.stringify(sawState))
  console.log('C3 RESOURCE_LEFT', root.registry.has('resource'))
  console.log('C4 FINAL_STATE', fiber.state)
  expect(true).to.equal(true)
})
