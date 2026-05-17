import type { Config } from 'tailwindcss'

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
      // Semantic design tokens. Use these instead of inline `[#hex]` colors.
      // The ESLint rule in eslint.config.mjs blocks new hex literals in
      // color utilities to keep the palette centralized — repalette by
      // editing this file, not by sed'ing 700 call sites.
      //
      // Print metaphor: paper (backgrounds), ink (text), line (borders).
      // Single source of truth for every grayscale shade in the codebase.
      colors: {
        // Surfaces (dark-only UI; values darken into the page)
        surface: '#111',     // bg-surface — cards, inputs, modals (default raised surface)
        raised: '#1a1a1a',   // bg-raised — gradient origin, callout banners

        // Borders + dividers
        line: '#2a2a2a',     // border-line — standard border weight

        // Text + ink (high contrast → low)
        ink: '#efefef',      // text-ink — primary body text + titles
        dim: '#888',         // text-dim — labels, captions, secondary text
        muted: '#555',       // text-muted — de-emphasized; also border-muted on hover/focus
        faint: '#333',       // text-faint / placeholder-faint — placeholders + disabled

        // Brand accent (was a 2-stop purple gradient #8B5CF6 → #C084FC;
        // now a single solid color. accent-grad/btn-accent in globals.css
        // still use linear-gradient syntax for the gradient utility class,
        // but with both stops set to this same value.)
        accent: '#6B3FA0',
      },
    },
  },
  plugins: [],
}

export default config
