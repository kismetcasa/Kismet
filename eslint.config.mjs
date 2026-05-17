import { FlatCompat } from '@eslint/eslintrc'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const compat = new FlatCompat({ baseDirectory: __dirname })

// Hex literals for the colors that live as design tokens in
// tailwind.config.ts. Reintroducing them inline (e.g. `bg-[#111]`)
// would silently drift the palette out of one-place control. New
// rare colors outside this set stay allowed — only the tokenized
// ones are blocked. Case-insensitive flag handles e.g. `[#8B5CF6]`
// vs `[#8b5cf6]`.
//
//   #111      → surface
//   #1a1a1a   → raised
//   #2a2a2a   → line
//   #efefef   → ink
//   #888      → dim
//   #555      → muted
//   #333      → faint
//   #8B5CF6   → accent (legacy purple stop A)
//   #C084FC   → accent (legacy purple stop B)
const TOKENIZED_HEX_PATTERN =
  '\\[#(111|1a1a1a|2a2a2a|efefef|888|555|333|8b5cf6|c084fc)\\]'

const TOKEN_MIGRATION_MESSAGE =
  'Use a design token from tailwind.config.ts (surface/raised/line/ink/dim/muted/faint/accent) instead of this hex literal — keeps the palette centralized.'

const config = [
  {
    // `public/ffmpeg-core/*` is the @ffmpeg/core UMD bundle copied in
    // by scripts/copy-ffmpeg-core.mjs at install time — third-party
    // generated code, not ours to clean up. Same reason we don't lint
    // `.next/**` or `node_modules/**`.
    ignores: ['.next/**', 'node_modules/**', 'public/**', 'next-env.d.ts'],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      // Honor the existing `_var` convention for intentionally unused
      // bindings (destructure-and-discard, fetch-API duplex strip, etc.)
      // instead of flagging them.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Block tokenized hex colors so the design palette stays in one
      // place. Add new tokens to tailwind.config.ts rather than
      // reintroducing inline hex. Two selectors cover both raw string
      // literals (className="bg-[#111]") and the static segments of
      // template literals (className={`bg-[#111] ${cond}`}).
      'no-restricted-syntax': [
        'error',
        {
          selector: `Literal[value=/${TOKENIZED_HEX_PATTERN}/i]`,
          message: TOKEN_MIGRATION_MESSAGE,
        },
        {
          selector: `TemplateElement[value.raw=/${TOKENIZED_HEX_PATTERN}/i]`,
          message: TOKEN_MIGRATION_MESSAGE,
        },
      ],
    },
  },
]

export default config
