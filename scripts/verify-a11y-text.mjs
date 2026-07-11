// A11y text-contrast oracle. The tailwind tokens define a text ladder where
// `subtle` (#555, ~2.5:1 on the #111 surface) and `faint` (#333, ~1.5:1) are
// sub-AA and permitted ONLY for decorative/large text and borders — never for
// informational body text. Two class-level rules, enforced here (mirroring
// the verify-agent-* oracle pattern — pure scan, exits 1 with file:line):
//
//   1. text-faint / placeholder-faint — banned outright: faint is a border/
//      ornament token, not a text tier. Use text-subtle (decorative) or
//      text-muted (readable, ≥4.5:1).
//   2. text-[#hex] literals — allowed only when the color actually clears
//      WCAG AA (4.5:1) against the #111 surface, computed for real (not
//      guessed from the hex shape — a bright success-green passes, a mid
//      grey fails). Sub-AA hexes must become text-muted or text-subtle.
//
// `text-subtle` itself stays allowed — it is the sanctioned decorative tier —
// so this oracle guards the boundary, not the aesthetic.
// Run: node scripts/verify-a11y-text.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['components', 'app']
const SURFACE = '#111111'
const AA = 4.5

function relLuminance(hex) {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(hexA, hexB) {
  const [l1, l2] = [relLuminance(hexA), relLuminance(hexB)].sort((a, b) => b - a)
  return (l1 + 0.05) / (l2 + 0.05)
}

const TEXT_HEX_RE = /\btext-\[(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}))\]/g
const BANNED_TOKENS = [
  { re: /\btext-faint\b/, why: 'faint is a border/ornament token — use text-subtle (decorative) or text-muted (readable)' },
  { re: /\bplaceholder-faint\b/, why: 'placeholder-faint is near-invisible — use placeholder-subtle' },
]

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const s = statSync(p)
    if (s.isDirectory()) yield* walk(p)
    else if (/\.(tsx|ts|jsx|js)$/.test(name)) yield p
  }
}

let failures = 0
const fail = (file, i, why, line) => {
  console.log(`  FAIL  ${file}:${i + 1} — ${why}\n        ${line.trim().slice(0, 160)}`)
  failures++
}

// Escape hatch for text that does NOT sit on the #111 surface (e.g. dark
// text on the featured hero's light panel). Annotate the same line or the
// line above with `a11y-ok:` and a reason.
const OK_RE = /a11y-ok:/

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (OK_RE.test(line) || (i > 0 && OK_RE.test(lines[i - 1]))) return
      for (const { re, why } of BANNED_TOKENS) {
        if (re.test(line)) fail(file, i, why, line)
      }
      for (const m of line.matchAll(TEXT_HEX_RE)) {
        const ratio = contrast(m[1], SURFACE)
        if (ratio < AA) {
          fail(
            file,
            i,
            `text-[${m[1]}] is ${ratio.toFixed(1)}:1 on the #111 surface (AA needs ${AA}:1) — use text-muted or text-subtle`,
            line,
          )
        }
      }
    })
  }
}

if (failures === 0) {
  console.log('OK — no sub-AA text classes in components/ or app/')
  process.exit(0)
}
console.log(`\nFAILED — ${failures} sub-AA text usage(s)`)
process.exit(1)
