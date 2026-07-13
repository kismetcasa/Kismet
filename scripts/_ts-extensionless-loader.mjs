// Registers the resolve hook (sibling file) so the verify scripts that need to
// import non-leaf lib modules can omit the `.ts` extension on relative imports
// — the app's bundler resolves those, raw Node ESM does not. Uses register()
// (Node ≥20.6, safely within the repo's >=22.11 engines floor) rather than the
// newer module.registerHooks (Node ≥22.15) so it can't break CI on 22.11–22.14.
//
// Usage: node --experimental-strip-types --import ./scripts/_ts-extensionless-loader.mjs <script.ts>
import { register } from 'node:module'

register('./_ts-extensionless-hook.mjs', import.meta.url)
