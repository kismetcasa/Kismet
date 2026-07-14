import { FlatCompat } from '@eslint/eslintrc'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const compat = new FlatCompat({ baseDirectory: __dirname })

// Block reintroducing hex literals that have a design token in tailwind.config.ts.
// New rare hex stays allowed; only the tokenized palette is locked.
const TOKENIZED_HEX = '\\[#(111|1a1a1a|2a2a2a|efefef|888|555|333|8b5cf6|c084fc)\\]'
const TOKEN_MSG = 'Use a design token from tailwind.config.ts (surface/raised/line/ink/dim/muted/faint/accent) instead of this hex literal.'

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
      ],
    },
  },
]

export default config
