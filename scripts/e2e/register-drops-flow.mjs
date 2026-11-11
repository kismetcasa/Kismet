// Registers the drops-flow hooks in front of the verify alias hooks — the
// last registered runs first, so the swaps see every resolved URL.
import { register } from 'node:module'

register('../ts-alias-hooks.mjs', import.meta.url)
register('./drops-flow-hooks.mjs', import.meta.url)
