/**
 * Zine fixtures for scripts/e2e/zine.mjs — hand-built, spec-valid PDFs, the
 * way make-glb.mjs builds its cube: no PDF library in the repo, and the
 * fixtures must exercise real parsing (a page tree, an unembedded standard
 * font, a DCT-encoded image XObject), not a mock.
 *
 *   zine.pdf       6 A5 pages, each a solid, distinct colour with a page
 *                  label in Helvetica (NOT embedded — so pdf.js must fetch
 *                  the copied standard font), and a JPEG image on page 2
 *   one-page.pdf   the allowed single page
 *   too-many.pdf   421 pages, one over ZINE_MAX_PAGES
 *   heavy.pdf      3 pages carrying a 2500 × 2500 noise JPEG (several MB),
 *                  which "optimize for phones" CAN shrink — the fixture for
 *                  the choices that must survive that re-pick
 *   long.pdf       60 pages, the same noise JPEG drawn on EVERY page (one
 *                  shared XObject, so the file stays one image big) and
 *                  page 2 landscape: every page is slow to render, which is
 *                  what the render-cancellation and width-after-aspect
 *                  checks need
 *   odd.pdf        5 pages — a spread that ends on the back cover
 *   locked.pdf     2 pages behind a user password (pdf.js asks for one)
 *   broken.pdf     the magic bytes and nothing a parser can use
 *   big.pdf        2 pages over the 16 MiB soft warning (one noise JPEG)
 *   notapdf.pdf    text bytes with a .pdf name — the magic sniff's case
 *   cover.jpg      the ar://cover-txid still (solid, so a pixel read is
 *                  unambiguous)
 *
 * Usage: node scripts/e2e/make-pdf.mjs <dir>
 */
import fs from 'fs'
import path from 'path'
import sharp from 'sharp'

/** Page fill colours, 0..1 RGB. Page 1 is the cover (a strong red the e2e
 *  reads back at the centre of the rendered page). */
export const PAGE_COLORS = [
  [0.78, 0.16, 0.16],
  [0.55, 0.55, 0.55],
  [0.16, 0.6, 0.3],
  [0.2, 0.3, 0.75],
  [0.8, 0.6, 0.1],
  [0.45, 0.2, 0.6],
]
/** The JPEG drawn on page 2 (its centre), 0..255 RGB. */
export const IMAGE_RGB = { r: 30, g: 120, b: 200 }

const A5 = [0, 0, 420, 595]

/**
 * Serialize a PDF from a list of objects (strings or Buffers for the body of
 * `n 0 obj … endobj`), writing a correct xref table.
 */
function serialize(objects, { encrypt = null, id = null } = {}) {
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  const offsets = []
  let length = parts[0].length
  objects.forEach((body, i) => {
    offsets.push(length)
    const head = Buffer.from(`${i + 1} 0 obj\n`, 'latin1')
    const tail = Buffer.from('\nendobj\n', 'latin1')
    const b = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1')
    parts.push(head, b, tail)
    length += head.length + b.length + tail.length
  })
  const xrefAt = length
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`
  const extra = `${encrypt ? ` /Encrypt ${encrypt} 0 R` : ''}${id ? ` /ID [<${id}> <${id}>]` : ''}`
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${extra} >>\nstartxref\n${xrefAt}\n%%EOF\n`
  parts.push(Buffer.from(xref, 'latin1'))
  return Buffer.concat(parts)
}

function stream(dict, body) {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1')
  return Buffer.concat([
    Buffer.from(`<< ${dict} /Length ${b.length} >>\nstream\n`, 'latin1'),
    b,
    Buffer.from('\nendstream', 'latin1'),
  ])
}

/**
 * Build a PDF with `count` pages. `imageJpeg` (optional) is drawn centred on
 * page 2. Objects: 1 catalog, 2 pages, 3 font, [4 image], then per page a
 * page object and a content stream.
 */
export async function buildPdf({ count, imageJpeg = null, title = 'E2E Zine', landscape = [], imageOnPages = [2], locked = false }) {
  const objects = []
  const add = (body) => { objects.push(body); return objects.length }
  const catalogIdx = add('') // placeholder, filled last
  const pagesIdx = add('')
  const fontIdx = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let imageIdx = null
  let imageSize = null
  if (imageJpeg) {
    const meta = await sharp(imageJpeg).metadata()
    imageSize = { w: meta.width, h: meta.height }
    imageIdx = add(stream(
      `/Type /XObject /Subtype /Image /Width ${meta.width} /Height ${meta.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
      imageJpeg,
    ))
  }
  const pageIdxs = []
  for (let i = 1; i <= count; i++) {
    const [r, g, b] = PAGE_COLORS[(i - 1) % PAGE_COLORS.length]
    // A landscape page swaps the sheet: the reader's slot for it is wider
    // than tall, which is what the width-after-aspect check needs.
    const box = landscape.includes(i) ? [0, 0, A5[3], A5[2]] : A5
    let content = `q ${r} ${g} ${b} rg 0 0 ${box[2]} ${box[3]} re f Q\n`
    content += `BT /F1 36 Tf 1 1 1 rg 40 ${box[3] - 75} Td (${i === 1 ? title : `Page ${i}`}) Tj ET\n`
    content += `BT /F1 14 Tf 1 1 1 rg 40 40 Td (${i} / ${count}) Tj ET\n`
    const xobjects = []
    if (imageIdx && (imageOnPages === 'all' || imageOnPages.includes(i))) {
      // 300pt wide, centred.
      const w = 300
      const h = Math.round((w * imageSize.h) / imageSize.w)
      const x = (box[2] - w) / 2
      const y = (box[3] - h) / 2
      content += `q ${w} 0 0 ${h} ${x} ${y} cm /Im1 Do Q\n`
      xobjects.push(`/Im1 ${imageIdx} 0 R`)
    }
    const contentIdx = add(stream('', content))
    const resources = `/Font << /F1 ${fontIdx} 0 R >>${xobjects.length ? ` /XObject << ${xobjects.join(' ')} >>` : ''}`
    const pageIdx = add(
      `<< /Type /Page /Parent ${pagesIdx} 0 R /MediaBox [${box.join(' ')}] /Resources << ${resources} >> /Contents ${contentIdx} 0 R >>`,
    )
    pageIdxs.push(pageIdx)
  }
  objects[catalogIdx - 1] = `<< /Type /Catalog /Pages ${pagesIdx} 0 R >>`
  objects[pagesIdx - 1] = `<< /Type /Pages /Kids [${pageIdxs.map((n) => `${n} 0 R`).join(' ')}] /Count ${count} >>`
  // A user password: the standard security handler (RC4, R2) with /O and
  // /U that no password derives — pdf.js tries the empty user password,
  // fails the /U check and asks for one (PasswordException), which is all
  // the gate's "password-protected" path needs. The streams are not
  // encrypted; they are never reached.
  const encrypt = locked
    ? add(`<< /Filter /Standard /V 1 /R 2 /Length 40 /P -1 /O <${'ab'.repeat(32)}> /U <${'cd'.repeat(32)}> >>`)
    : null
  return serialize(objects, encrypt ? { encrypt, id: '00'.repeat(16) } : {})
}

export async function writeFixtures(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const jpeg = await sharp({ create: { width: 300, height: 300, channels: 3, background: IMAGE_RGB } }).jpeg({ quality: 90 }).toBuffer()
  fs.writeFileSync(path.join(dir, 'zine.pdf'), await buildPdf({ count: 6, imageJpeg: jpeg }))
  fs.writeFileSync(path.join(dir, 'one-page.pdf'), await buildPdf({ count: 1, title: 'One Page' }))
  fs.writeFileSync(path.join(dir, 'too-many.pdf'), await buildPdf({ count: 421, title: 'Too Many' }))
  fs.writeFileSync(path.join(dir, 'notapdf.pdf'), Buffer.from('this is not a pdf, whatever the name says\n'))
  // Noise does not compress: a scan-sized JPEG the optimizer's 2000 px
  // re-render shrinks by far more than its 15 % threshold.
  const noise = await sharp({ create: { width: 2500, height: 2500, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } })
    .jpeg({ quality: 95 })
    .toBuffer()
  fs.writeFileSync(path.join(dir, 'heavy.pdf'), await buildPdf({ count: 3, imageJpeg: noise, title: 'Heavy' }))
  fs.writeFileSync(path.join(dir, 'long.pdf'), await buildPdf({ count: 60, imageJpeg: noise, title: 'Long', landscape: [2], imageOnPages: 'all' }))
  fs.writeFileSync(path.join(dir, 'odd.pdf'), await buildPdf({ count: 5, title: 'Odd' }))
  fs.writeFileSync(path.join(dir, 'locked.pdf'), await buildPdf({ count: 2, title: 'Locked', locked: true }))
  // Passes the magic sniff, fails the parse: no xref, no objects.
  fs.writeFileSync(path.join(dir, 'broken.pdf'), Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\nthis is where the objects would be\n', 'latin1'))
  // Over the soft warning (16 MiB): one noise JPEG too big to shrink into
  // the budget is enough; page 1 stays a plain fill so the preview is quick.
  const bigNoise = await sharp({ create: { width: 4300, height: 4300, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } })
    .jpeg({ quality: 95 })
    .toBuffer()
  fs.writeFileSync(path.join(dir, 'big.pdf'), await buildPdf({ count: 2, imageJpeg: bigNoise, title: 'Big' }))
  // The cover still: a solid magenta so a centre-pixel read is unambiguous.
  const cover = await sharp({ create: { width: 600, height: 850, channels: 3, background: { r: 190, g: 40, b: 150 } } }).jpeg({ quality: 85 }).toBuffer()
  fs.writeFileSync(path.join(dir, 'cover.jpg'), cover)
  return ['zine.pdf', 'one-page.pdf', 'too-many.pdf', 'notapdf.pdf', 'heavy.pdf', 'long.pdf', 'odd.pdf', 'locked.pdf', 'broken.pdf', 'big.pdf', 'cover.jpg']
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const dir = process.argv[2] || path.join(process.cwd(), '.e2e')
  const files = await writeFixtures(dir)
  for (const f of files) console.log(`${f}\t${fs.statSync(path.join(dir, f)).size} bytes`)
}
