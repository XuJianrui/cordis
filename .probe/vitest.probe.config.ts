import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import unyaml from '@cordisjs/unyaml/vite'

// Probe-only config. The root config relies on yakumo to supply workspace path
// aliases (vite-tsconfig-paths does not pick them up here), so they are built
// from each workspace package.json.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
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
