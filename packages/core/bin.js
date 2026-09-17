#!/usr/bin/env node

import { Context } from 'cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@cordisjs/plugin-loader'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

let failed = false
// surface bootstrap errors that core buffers without a console exporter
const dispose = ctx.logger.exporter({
  export(msg) {
    if (msg.type === 'error') {
      failed = true
      process.exitCode = 1
      for (const arg of msg.args) {
        console.error(arg)
      }
    }
  },
})

await ctx.plugin(Loader)
try {
  await ctx.loader.create({
    name: '@cordisjs/plugin-include',
    config: {
      path: './cordis.yml',
    },
  })
  await ctx.loader.await()
} catch (error) {
  failed = true
  process.exitCode = 1
  console.error(error)
}

if (failed) {
  process.exitCode = 1
} else {
  dispose()
}
