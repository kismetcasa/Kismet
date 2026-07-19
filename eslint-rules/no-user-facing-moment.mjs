// Local ESLint rule: ban NEW *user-facing* "moment".
// Kismet renamed the user-facing noun "moment" -> "artwork". The In Process wire
// (see lib/inprocess.ts TERMINOLOGY) keeps "moment" forever in URLs/response
// keys/Redis keys, and code identifiers (Moment, MomentCard, moment vars) stay.
// This rule flags "moment" ONLY where a user reads it (JSX text + rendered
// string literals), allowlisting every intentional context so it is silent on
// current main. A custom rule (not raw no-restricted-syntax) because the
// allowlist is negative logic that a selector regex can't express cleanly.
//
// Known blind spot: a bare single-token string ('MOMENT') passes as an
// identifier-string — e.g. a share-card label. Nothing cheap distinguishes
// it from the ~1900 legitimate token uses, so label sites carry a comment
// instead (see app/moment/[address]/[tokenId]/opengraph-image.tsx).

const WORD = /\bmoments?\b/i

// Ordinary English word: a determiner/quantifier immediately before "moment".
// Covers "in a moment", "the moment it lands", "take a moment".
// "this/that moment" is deliberately NOT allowed — every historical copy leak
// ('No active sale for this moment', 'Only the creator can hide this moment')
// took exactly that shape. Genuine prose can reword ("right now", "just now")
// or eslint-disable with a reason.
// Possessives (your/their/...) are also omitted so "Your moments" is caught.
const IDIOM =
  /\b(a|an|the|any|one|each|every|another|no|some|last|next|first|final|single|brief|quiet|short|long|right|perfect|current|present|passing|few|several|couple|many)\s+moments?\b/i

function isIntentional(raw, allowSingleToken) {
  const t = String(raw).trim()
  if (!WORD.test(t)) return true
  if (allowSingleToken && !/\s/.test(t)) return true // single token: identifier-string / union tag / path / key / op-label
  if (/\/moment/i.test(t)) return true               // /moment, /api/moment, kismet.art/moment
  if (/kismetart:/i.test(t)) return true             // kismetart:* Redis key or DOM CustomEvent
  if (/["']moments?["']/i.test(t)) return true       // a quoted wire-token reference inside a message
  if (IDIOM.test(t)) return true                     // ordinary English word
  return false
}

// console.*/logger.* calls and thrown Error-constructor messages are the
// diagnostic layer, not rendered UI copy.
function inDiagnosticSink(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (n.type === 'ThrowStatement') return true
    if (n.type === 'CallExpression' || n.type === 'NewExpression') {
      const c = n.callee
      if (c && c.type === 'MemberExpression' && c.object.type === 'Identifier' &&
          (c.object.name === 'console' || c.object.name === 'logger')) return true
      // Capitalized constructor-style names only (Error(), TypeError(),
      // HttpError()). Lowercase *Error helpers are NOT exempt — this repo's
      // toastError() renders user-facing copy and must stay guarded.
      if (c && c.type === 'Identifier' && /^[A-Z]\w*Error$/.test(c.name)) return true
    }
  }
  return false
}
// NB: import/export module-source strings ('./MomentImage', '@/lib/momentCache')
// are Literals with no whitespace, so the single-token allowlist already skips
// them — do NOT add an ExportNamedDeclaration ancestry check, it would wrongly
// suppress every `export function`.

const noUserFacingMoment = {
  meta: {
    type: 'problem',
    docs: { description: 'Ban NEW user-facing "moment"; the user-facing noun is "artwork" (In Process wire keeps "moment"; see lib/inprocess.ts).' },
    schema: [],
    messages: {
      moment:
        'User-facing "moment" is banned — the user-facing noun is "artwork". ' +
        'If this is genuinely an ordinary English "moment", or a new In Process wire token / URL / Redis key, ' +
        'extend the allowlist in this rule; otherwise rename it to "artwork". (See lib/inprocess.ts TERMINOLOGY.)',
    },
  },
  create(context) {
    const check = (node, raw, allowSingleToken) => {
      if (!WORD.test(String(raw))) return
      if (isIntentional(raw, allowSingleToken)) return
      if (inDiagnosticSink(node)) return
      context.report({ node, messageId: 'moment' })
    }
    return {
      Literal(node) { if (typeof node.value === 'string') check(node, node.value, true) },
      // JSX text is always rendered copy — a bare single-word "moment" is NOT an allowed token here.
      JSXText(node) { check(node, node.value, false) },
      TemplateLiteral(node) {
        // Join cooked quasis with a sentinel so an ${expr} gap can't fuse two
        // statics into a false idiom, and a lone " moment" quasi stays a token.
        const raw = node.quasis.map((q) => q.value.cooked ?? q.value.raw).join('\uFFFF')
        check(node, raw, true)
      },
    }
  },
}

export default noUserFacingMoment
