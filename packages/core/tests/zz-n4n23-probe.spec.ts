// N4 反函数在**应用点**返回，不在参数位预先固定；N23 逆是闭包（连同状态一起捕获）。
// 两条合起来一句可跑的话：**没有成功施加，就不该存在逆**。
//
// 上一版②只断言「状态 FAILED」—— 把 effect 删掉它照样绿，等于没测。
// 这一版改成计数器：逆被**调用**才 +1。于是「没登记」与「登了但没调」在读数上分开。
//
// 三条臂：
//   ① 对照：正常 effect → dispose 前 0、dispose 后 1（证明计数器确实能读到 1）
//   ② 施加即抛 → 失败后 dispose，计数仍为 0（没有逆可跑）
//   ③ 施加成功但逆为空 → 仍被调用（证明①不是靠副作用偶然绿的）
import { Context } from '../src/index.ts'
import { expect, describe, it } from 'vitest'

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

describe('inverse exists only after a successful application (N4/N23)', () => {
  it('① 对照：正常 effect 的逆在 dispose 后被调用一次', async () => {
    const root = new Context()
    let runs = 0
    const fiber = root.use((ctx) => {
      ctx.effect(() => () => { runs++ })
    })
    await fiber
    expect(runs, `dispose 前 runs=${runs}`).to.equal(0)
    await fiber.dispose()
    expect(runs, `dispose 后 runs=${runs}（读不到 1 说明这条装置坏了）`).to.equal(1)
  })

  it('② 施加即抛：失败后 dispose，逆不该被跑过', async () => {
    const root = new Context()
    let runs = 0
    const fiber = root.use((ctx) => {
      // 逆存在，但施加阶段就抛 —— 逆不该有机会被登记
      ctx.effect(() => { throw new Error('probe: apply failed') })
      void runs
    })
    await tick()
    const state = (fiber as any).state
    await fiber.dispose()
    expect(state, `state=${state}（3 = FAILED；若卡在 LOADING 说明失败路径不同）`).to.equal(3)
    expect(runs, `失败后 runs=${runs}（>0 说明施加前就把逆登记了）`).to.equal(0)
  })

  it('③ 逆为空函数：仍应被调用（防①靠副作用偶然绿）', async () => {
    const root = new Context()
    let runs = 0
    const fiber = root.use((ctx) => {
      ctx.effect(() => { runs++; return () => { runs++ } })
    })
    await fiber
    const before = runs
    await fiber.dispose()
    expect(runs, `before=${before} after=${runs}`).to.be.greaterThan(before)
  })
})
