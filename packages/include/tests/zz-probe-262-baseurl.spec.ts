/* eslint-disable */
// Probe 262: does the `baseUrl` that `include` sets on its own context reach the
// entries of its config subtree, and does it mutate the loader tree's baseUrl?
import { it } from 'vitest'
import { harness } from './utils.ts'

it('probe 262: include baseUrl shadow', async () => {
  const { setup } = harness()
  const app = await setup('tmp-probe-baseurl.yml', [
    '- id: child',
    '  name: ./config-plugin',
    '  config: { tag: child, value: 1 }',
    '',
  ].join('\n'))

  const include = app.include() as any
  const loader = app.ctx.loader as any
  const entries = Object.entries(loader.store ?? {})
  const subtree = include.ctx?.fiber?.entry?.subtree
  const subEntries = Object.entries(subtree?.store ?? {})
  const child = [...entries, ...subEntries]
    .find(([id, entry]: any) => id.endsWith('child') || entry?.options?.id === 'child')?.[1] as any

  const report = {
    storeIds: [...entries, ...subEntries].map(([id]) => id),
    rootCtx: app.ctx.baseUrl,
    loaderCtx: loader.ctx?.baseUrl,
    loaderRootCtx: loader.root?.ctx?.baseUrl,
    includeCtx: include.ctx?.baseUrl,
    includeFilename: include.filename,
    childCtx: child?.ctx?.baseUrl,
    childResolve: (() => {
      try {
        return new URL('relative.txt', child?.ctx?.baseUrl).href
      } catch (error: any) {
        return `error:${error?.message}`
      }
    })(),
  }
  console.log('PROBE262_BASEURL ' + JSON.stringify(report))
}, 20000)
