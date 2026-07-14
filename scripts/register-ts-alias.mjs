// Registers the `@/` alias + extensionless `.ts` resolution hooks (see
// ts-alias-hooks.mjs) for a single `node` invocation. Used via
// `node --experimental-strip-types --import ./scripts/register-ts-alias.mjs <script>.ts`
// so a verify script can import the real production builders. Kept separate
// from the hooks module because `register` must run on the main thread while
// the hooks execute on the loader thread.
import { register } from 'node:module'

register('./ts-alias-hooks.mjs', import.meta.url)
