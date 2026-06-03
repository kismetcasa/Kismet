import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

// Lean unit/integration runner. `node` environment (not jsdom) because the
// current suite covers pure logic + Route Handlers — no DOM/components. Add
// jsdom + @vitejs/plugin-react + @testing-library only if/when component tests
// are introduced. tsconfigPaths resolves the `@/*` alias from tsconfig.json.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
