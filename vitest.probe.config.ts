import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import unyaml from '@cordisjs/unyaml/vite'

// Probe-only config: builds workspace aliases from each packages/*/package.json
// so `import ... from 'cordis'` resolves inside plain vitest.
const root = resolve(dirname(fileURLToPath(import.meta.url)))
const alias: Record<string, string> = {}
for (const dir of readdirSync(resolve(root, 'packages'))) {
  const file = resolve(root, 'packages', dir, 'package.json')
  let name: string
  try {
    name = JSON.parse(readFileSync(file, 'utf8')).name
  } catch {
    continue
  }
  alias[name] = resolve(root, 'packages', dir, 'src/index.ts')
}

export default defineConfig({
  plugins: [unyaml()],
  resolve: { alias },
  test: {
    pool: 'forks',
    execArgv: ['--expose-internals', '--import', 'tsx', '--import', '@cordisjs/unyaml'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
})
