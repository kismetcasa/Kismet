import { FlatCompat } from '@eslint/eslintrc'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import noUserFacingMoment from './eslint-rules/no-user-facing-moment.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const compat = new FlatCompat({ baseDirectory: __dirname })

// Block reintroducing hex literals that have a design token in tailwind.config.ts.
// New rare hex stays allowed; only the tokenized palette is locked. The list
// also keeps a few RETIRED hexes banned (888/444 = pre-WCAG grays, 8b5cf6/
// c084fc = the abandoned purple accent) so they can't sneak back untokenized.
const TOKENIZED_HEX = '\\[#(111|1a1a1a|2a2a2a|efefef|888|555|444|333|a3a3a3|808080|8b5cf6|c084fc|ff87ce)\\]'
const TOKEN_MSG = 'Use a design token from tailwind.config.ts (surface/raised/line/ink/dim/muted/subtle/faint/accent) instead of this hex literal.'

// /moment is redirect-only legacy since the /artwork rename: app code must
// build /artwork links. Start-anchored so /api/moment/* (Kismet's internal
// API) and the In Process wire's bare '/moment' endpoint stay legal; the two
// sanctioned exceptions (the next.config redirect source and the wire's
// '/moment/comments' path) carry inline disables at the site.
const LEGACY_MOMENT_URL = '^\\/moment\\/'
// Absolute form — catches `https://kismet.art/moment/…` (fixtures, docs
// strings, share URLs), which the start-anchored selector can't see. This
// exact shape was reintroduced by a parallel branch within a day of the
// migration landing, so it has earned its own selector.
const LEGACY_MOMENT_ABS = 'kismet\\.art\\/moment\\/'
const LEGACY_URL_MSG = 'Build /artwork links — /moment is a redirect-only legacy path (see the rename redirect in next.config.mjs).'

// The page rename did NOT move the API: Kismet's internal routes stay
// /api/moment/* by design (lib/inprocess.ts TERMINOLOGY), and no redirect
// covers /api/*, so a phantom /api/artwork/* fetch 404s silently. The
// migration branch itself shipped exactly that — the activity feed went
// dark platform-wide — so this shape has earned its own selector too.
const PHANTOM_ARTWORK_API = '\\/api\\/artwork\\/'
// NB: worded without a trailing slash after "artwork" so the message string
// cannot match the selector regex it accompanies.
const PHANTOM_API_MSG = 'Kismet’s internal API namespace is /api/moment/* — no /api/artwork routes exist, so the fetch 404s (see lib/inprocess.ts TERMINOLOGY).'

const config = [
  {
    // public/ffmpeg-core/* is the third-party UMD bundle copied in by postinstall.
    ignores: ['.next/**', 'node_modules/**', 'public/**', 'next-env.d.ts'],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      // Honor the existing `_var` convention for intentionally-unused bindings.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Two selectors: raw string literals + static segments of template literals.
      'no-restricted-syntax': [
        'error',
        { selector: `Literal[value=/${TOKENIZED_HEX}/i]`, message: TOKEN_MSG },
        { selector: `TemplateElement[value.raw=/${TOKENIZED_HEX}/i]`, message: TOKEN_MSG },
        // Per-quasi matching means `${SITE_URL}/moment/${id}` is caught: its
        // middle TemplateElement is exactly '/moment/'. Regex literals (the
        // dual-accept parsers) have non-string values and never match.
        { selector: `Literal[value=/${LEGACY_MOMENT_URL}/]`, message: LEGACY_URL_MSG },
        { selector: `TemplateElement[value.raw=/${LEGACY_MOMENT_URL}/]`, message: LEGACY_URL_MSG },
        { selector: `Literal[value=/${LEGACY_MOMENT_ABS}/]`, message: LEGACY_URL_MSG },
        { selector: `TemplateElement[value.raw=/${LEGACY_MOMENT_ABS}/]`, message: LEGACY_URL_MSG },
        { selector: `Literal[value=/${PHANTOM_ARTWORK_API}/]`, message: PHANTOM_API_MSG },
        { selector: `TemplateElement[value.raw=/${PHANTOM_ARTWORK_API}/]`, message: PHANTOM_API_MSG },
      ],
    },
  },
  {
    // User-facing copy says "artwork", never "moment" (the In Process wire
    // keeps "moment" — see lib/inprocess.ts TERMINOLOGY). scripts/** is
    // excluded: verify-script test descriptions are not user copy.
    files: [
      'app/**/*.{ts,tsx}',
      'components/**/*.{ts,tsx}',
      'hooks/**/*.{ts,tsx}',
      'lib/**/*.{ts,tsx}',
      'contexts/**/*.{ts,tsx}',
      'providers/**/*.{ts,tsx}',
    ],
    plugins: { local: { rules: { 'no-user-facing-moment': noUserFacingMoment } } },
    rules: { 'local/no-user-facing-moment': 'error' },
  },
]

export default config
