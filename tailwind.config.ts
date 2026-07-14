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
        // Single-color representative of the brand gradient, used by
        // every `bg-accent`/`text-accent`/`border-accent`/`ring-accent`
        // and their `/opacity` variants. Picked as the gradient's
        // middle stop — the most "Kismet pink", distinctly not purple.
        // CSS can't render gradients in single-color properties
        // (borders, rings, opacity-tinted backgrounds), so they sit on
        // this color while text + button-fill surfaces use the full
        // gradient via .accent-grad / .accent-grad-hover.
        //
        // Var-backed (`--accent` is an "R G B" triplet, default = the pink
        // below) so a scoped override — e.g. a content-themed profile root —
        // re-skins EVERY accent surface and its /opacity variants with zero
        // component changes. The app is pixel-identical wherever no theme
        // overrides `--accent`.
        accent: 'rgb(var(--accent) / <alpha-value>)',
      },
    },
  },
  plugins: [],
}

export default config
