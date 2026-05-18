import type { Config } from 'tailwindcss'

// Semantic design tokens — use these instead of `[#hex]` colors.
// ESLint rule in eslint.config.mjs blocks reintroduction of the hex literals.
const config: Config = {
  content: [
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      colors: {
        surface: '#111',
        raised: '#1a1a1a',
        line: '#2a2a2a',
        ink: '#efefef',
        dim: '#888',
        muted: '#555',
        faint: '#333',
        // Single-color representative of the wordmark gradient. Used by
        // every `bg-accent`/`text-accent`/`border-accent`/`ring-accent`
        // and their `/opacity` variants. Picked as the first stop of the
        // brand gradient (logo's top-left petal violet) — sits at a
        // similar hue position to the historical purple #6B3FA0, so
        // existing UI rhythm (cards, badges, focus rings) stays
        // perceptually anchored while shifting to the logo's palette.
        accent: '#bf81f2',
      },
    },
  },
  plugins: [],
}

export default config
