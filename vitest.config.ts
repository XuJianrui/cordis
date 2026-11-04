import { defineConfig } from 'vitest/config'
import unyaml from '@cordisjs/unyaml/vite'

export default defineConfig({
  plugins: [unyaml()],
  test: {
    pool: 'forks',
    // Fork-only: keeps the #262 evidence probes log-only, so an instrument can
    // never redden the build. Applies to `zz-{probe,verify}-262*` only; every
    // other test keeps throwing. See vitest.probe-setup.ts.
    setupFiles: ['./vitest.probe-setup.ts'],
    execArgv: ['--expose-internals', '--import', 'tsx', '--import', '@cordisjs/unyaml'],
  },
})
