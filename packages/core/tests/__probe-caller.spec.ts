import { Context, Service } from '../src/index.ts'
import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 探针：把草稿里「仅源码推演」的语义断言逐条落地。
// 判据不符时错误消息带出观测值，便于一次读数定论。
const CALLER = Symbol.for('cordis.caller')
const SHADOW = Symbol.for('cordis.shadow')

describe('probe: framework and runtime semantics', () => {
  it('this.ctx ownership across caller scenarios', async () => {
    let serviceOwn: Context | undefined

    class Probe extends Service {
      constructor(ctx: Context) {
        super(ctx, 'probe')
        serviceOwn = ctx
      }

      report(access: Context) {
        const self = this as any
        const thisCtx = this.ctx as any
        return {
          thisCtxIsAccess: thisCtx === access,
          thisCtxIsServiceOwn: thisCtx === serviceOwn,
          shadowOnThis: self[SHADOW] !== undefined,
          shadowOnThisCtx: thisCtx[SHADOW] !== undefined,
          shadowOnThisCtxIsServiceOwn: thisCtx[SHADOW] === serviceOwn,
          protoIsAccess: Object.getPrototypeOf(thisCtx) === access,
          callerIsAccess: self[CALLER] === access,
          thisFiberUid: thisCtx.fiber?.uid ?? null,
          accessFiberUid: (access as any).fiber?.uid ?? null,
          serviceFiberUid: (serviceOwn as any)?.fiber?.uid ?? null,
          thisFiberIsAccessFiber: thisCtx.fiber === (access as any).fiber,
          thisFiberIsServiceOwnFiber: thisCtx.fiber === (serviceOwn as any)?.fiber,
        }
      }
    }

    const root = new Context()
    await root.plugin(Probe)

    // 场景 A：调用方就是服务提供方（同 ctx / 同 fiber）
    const a = (root as any).probe.report(root)

    // 场景 B：调用方是子插件 ctx（跨 fiber）
    let b: ReturnType<Probe['report']> | undefined
    await root.plugin({
      inject: ['probe'],
      apply(ctx) {
        b = (ctx as any).probe.report(ctx)
      },
    })

    // 场景 C：isolate 出的 ctx 能否解析到该服务
    const isolated = root.isolate('probe')
    let cResolved: 'object' | 'undefined' | 'threw' = 'undefined'
    try {
      cResolved = (isolated as any).probe ? 'object' : 'undefined'
    } catch {
      cResolved = 'threw'
    }

    const matrix = { A: a, B: b, C: { resolved: cResolved } }

    // 核心不变量：不论 A 还是 B，effect 落在「调用发生时的那个 fiber」上
    const okA = a.thisFiberIsAccessFiber
    const okB = !!b && b.thisFiberIsAccessFiber
    if (!okA || !okB) throw new Error(`PROBE ${JSON.stringify(matrix)}`)

    expect(okA).toBe(true)
    expect(okB).toBe(true)
  })

  it('a settled-but-alive fiber can still register an effect; a disposed one throws', async () => {
    const root = new Context()
    let settledCtx: Context | undefined
    const fiber = await root.plugin({
      apply(ctx) {
        settledCtx = ctx
      },
    })
    expect(settledCtx).toBeTruthy()

    let settledThrew: string | undefined
    try {
      const dispose = settledCtx!.effect(() => () => {})
      await dispose()
    } catch (error) {
      settledThrew = (error as Error).name
    }

    await fiber.dispose()
    let disposedThrew: string | undefined
    try {
      settledCtx!.effect(() => () => {})
    } catch (error) {
      disposedThrew = (error as any).code ?? (error as Error).name
    }

    if (settledThrew !== undefined || disposedThrew === undefined) {
      throw new Error(`PROBE ${JSON.stringify({ settledThrew, disposedThrew })}`)
    }
    expect(settledThrew).toBeUndefined()
    expect(disposedThrew).toBeTruthy()
  })

  it('an isolated context resolves a service only when it is provided in that realm', async () => {
    class Svc extends Service {
      constructor(ctx: Context) {
        super(ctx, 'svc')
      }
      ping() {
        return 'pong'
      }
    }

    const root = new Context()
    await root.plugin(Svc)

    // 1) 直接访问：不解析
    const direct = root.isolate('svc')
    expect((direct as any).svc).toBeUndefined()

    // 2) 只声明 inject：回调不触发（有 provider 才触发，此处无）
    let injectFired = false
    ;(direct as any).inject(['svc'], () => {
      injectFired = true
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(injectFired).toBe(false)

    // 3) 在 realm 内自行提供：可解析
    const provided = root.isolate('svc')
    await provided.plugin(Svc)
    expect((provided as any).svc?.ping()).toBe('pong')
  })

  it('statSync with throwIfNoEntry:false yields undefined for a missing path', () => {
    const missing = join(tmpdir(), `probe-missing-${process.pid}-${Date.now()}`)
    const stat = statSync(missing, { throwIfNoEntry: false })
    expect(stat).toBeUndefined()
    expect(!(stat as any)?.isDirectory()).toBe(true)
  })

  it('unlinking a symlink does not touch its target', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-link-'))
    const target = join(dir, 'target.txt')
    const link = join(dir, 'link.txt')
    writeFileSync(target, 'payload')
    try {
      symlinkSync(target, link)
    } catch {
      rmSync(dir, { recursive: true, force: true })
      t.skip('symlink not permitted in this environment')
      return
    }
    try {
      unlinkSync(link)
    } catch {
      rmSync(dir, { recursive: true, force: true })
      t.skip('delete is intercepted by the environment')
      return
    }
    const survived = existsSync(target)
    rmSync(dir, { recursive: true, force: true })
    expect(survived).toBe(true)
  })

  it('breaking out of for-await calls iterator.return()', async () => {
    let returned = false
    const iterable = {
      [Symbol.asyncIterator]() {
        let i = 0
        return {
          async next() {
            return { done: false, value: i++ }
          },
          async return() {
            returned = true
            return { done: true, value: undefined }
          },
        }
      },
    }
    for await (const value of iterable) {
      if (value >= 1) break
    }
    expect(returned).toBe(true)
  })
})
