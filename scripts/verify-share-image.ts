// Verifies lib/media/shareImage.shareImageSource — the image a share card
// (app/**/opengraph-image.tsx) draws — against the renderer the cards use
// (the @vercel/og bundled with Next), with no network:
//   1. why it hands the card inlined bytes: a source the renderer cannot load
//      or decode (unreachable, or a webp) draws a BLANK card, not its alt;
//   2. a cover already in /api/img's variant cache is inlined as a jpeg, as
//      before;
//   3. on a miss the source is fetched and inlined the same way — a webp
//      included, which the renderer then draws;
//   4. and anything that cannot be — refused, unreachable, not an image, too
//      slow, too big, redirected somewhere shareImageUrl would not go — is
//      nothing, so the card falls back to its text layout.
//
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//        --import ./scripts/register-ts-alias.mjs scripts/verify-share-image.ts

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import sharp from 'sharp'
import { ImageResponse } from 'next/dist/compiled/@vercel/og/index.node.js'
import { shareImageSource } from '../lib/media/shareImage.ts'
import { bucketWidth, variantFileName } from '../lib/media/imgVariantCache.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

const BACKGROUND = [10, 10, 10]
/** Draw `src` full frame on a card's dark background, as the share card does,
 *  and say whether anything but the background came out. */
async function draws(src: string): Promise<boolean> {
  const card = createElement('div', { style: { display: 'flex', width: 120, height: 120, background: `rgb(${BACKGROUND})` } },
    createElement('img', { src, width: 120, height: 120, alt: 'a title the renderer does not draw' }))
  const png = Buffer.from(await new ImageResponse(card, { width: 120, height: 120 }).arrayBuffer())
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  for (let i = 0; i < data.length; i += info.channels) {
    if (BACKGROUND.some((v, k) => Math.abs(data[i + k] - v) > 8)) return true
  }
  return false
}

const pink = (format: 'png' | 'webp' | 'jpeg') =>
  sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 135, b: 206 } } })[format]().toBuffer()
const isJpegDataUri = (s: string | undefined) =>
  !!s && s.startsWith('data:image/jpeg;base64,') && Buffer.from(s.slice(23), 'base64').subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))

type Reply = { status?: number; headers?: Record<string, string>; body?: Buffer | ReadableStream<Uint8Array> | null }
/** A fetch that answers from `routes` by URL, and records what it was asked. */
function fetcher(routes: Record<string, Reply | 'hang' | 'fail'>) {
  const asked: string[] = []
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    asked.push(url)
    const r = routes[url]
    if (!r || r === 'fail') throw new TypeError('fetch failed')
    if (r === 'hang') {
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))
    }
    return new Response(r.body === undefined ? null : r.body, { status: r.status ?? 200, headers: r.headers })
  }) as typeof fetch
  return { fn, asked }
}

const cacheDir = mkdtempSync(join(tmpdir(), 'share-image-'))
const COVER = 'ar://cover-tx'
const AT = 'https://arweave.net/cover-tx'

try {
  console.log('\n1. what the card renderer draws, handed a URL as the cards were')
  {
    // A local host serving the same cover as a png and as a webp.
    const files: Record<string, [string, Buffer]> = { '/cover.png': ['image/png', await pink('png')], '/cover.webp': ['image/webp', await pink('webp')] }
    const server = createServer((req, res) => {
      const f = files[req.url ?? '']
      res.writeHead(f ? 200 : 404, f ? { 'content-type': f[0] } : {}).end(f?.[1])
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      check('a png it can load, it draws', await draws(`${at}/cover.png`))
      check('the same cover as a webp draws nothing — a blank card, its alt not drawn', !(await draws(`${at}/cover.webp`)))
      check('nor does a cover that is not there yet', !(await draws(`${at}/propagating.png`)))
      server.close()
      check('nor one it cannot reach', !(await draws(`${at}/cover.png`)))
    } finally {
      server.close()
    }
  }

  console.log('\n2. a cover already in the variant cache')
  {
    writeFileSync(join(cacheDir, variantFileName(COVER, bucketWidth(2048))), await pink('webp'))
    const { fn, asked } = fetcher({})
    const src = await shareImageSource(COVER, undefined, cacheDir, fn)
    check('is inlined as a jpeg, without a fetch', isJpegDataUri(src) && asked.length === 0, `${src?.slice(0, 40)} | ${asked}`)
    check('which the renderer draws', !!src && (await draws(src)))
    rmSync(join(cacheDir, variantFileName(COVER, bucketWidth(2048))))
  }

  console.log('\n3. a miss is fetched and inlined')
  {
    const { fn, asked } = fetcher({ [AT]: { body: await pink('webp'), headers: { 'content-type': 'image/webp' } } })
    const src = await shareImageSource(COVER, undefined, cacheDir, fn)
    check('a webp source comes back a jpeg', isJpegDataUri(src) && asked.join() === AT, `${src?.slice(0, 40)} | ${asked}`)
    check('which the renderer draws, where the webp itself drew nothing', !!src && (await draws(src)))
  }
  {
    const big = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: '#fff' } }).png().toBuffer()
    const { fn } = fetcher({ [AT]: { body: big } })
    const src = await shareImageSource(COVER, undefined, cacheDir, fn)
    const meta = isJpegDataUri(src) ? await sharp(Buffer.from(src!.slice(23), 'base64')).metadata() : null
    check('a large one is scaled to fit the card (1200 across)', meta?.width === 1200 && meta?.height === 600, `${meta?.width}×${meta?.height}`)
  }
  {
    const hop = 'https://gateway.example/cover-tx'
    const { fn, asked } = fetcher({ [AT]: { status: 302, headers: { location: hop } }, [hop]: { body: await pink('png') } })
    const src = await shareImageSource(COVER, undefined, cacheDir, fn)
    check('a redirect to another public https host is followed', isJpegDataUri(src) && asked.join() === `${AT},${hop}`, asked.join())
  }
  {
    const { fn, asked } = fetcher({ [AT]: { status: 301, headers: { location: '/moved' } }, 'https://arweave.net/moved': { body: await pink('png') } })
    const src = await shareImageSource(COVER, undefined, cacheDir, fn)
    check('and a relative one, against the URL that gave it', isJpegDataUri(src) && asked.at(-1) === 'https://arweave.net/moved', asked.join())
  }

  console.log('\n4. anything else is nothing — the text card')
  const nothing = async (name: string, routes: Parameters<typeof fetcher>[0], expectAsked: string[], uri: string | undefined = COVER, guard?: string) => {
    const { fn, asked } = fetcher(routes)
    const started = Date.now()
    // The budget's timer does not hold a process open (a server always is);
    // this does, for the checks that wait on it.
    const open = setTimeout(() => {}, 10_000)
    const src = await shareImageSource(uri, guard, cacheDir, fn).finally(() => clearTimeout(open))
    check(name, src === undefined && asked.join() === expectAsked.join(), `${src?.slice(0, 40)} | asked ${asked.join()} | ${Date.now() - started} ms`)
    return Date.now() - started
  }
  await nothing('no image is not fetched', {}, [], '')
  await nothing('a data: URI is not fetched', {}, [], 'data:image/svg+xml,<svg/>')
  await nothing('nor is the moment\'s own video', {}, [], COVER, COVER)
  await nothing('nor a host shareImageUrl refuses', {}, [], 'http://169.254.169.254/latest/meta-data')
  await nothing('an unreachable source', { [AT]: 'fail' }, [AT])
  await nothing('a source that is not there', { [AT]: { status: 404, body: Buffer.from('not found') } }, [AT])
  await nothing('a source that is not an image', { [AT]: { body: Buffer.from('<html>propagating</html>') } }, [AT])
  await nothing('a redirect to an IP address — never followed',
    { [AT]: { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } } }, [AT])
  await nothing('a redirect to plain http — never followed', { [AT]: { status: 302, headers: { location: 'http://arweave.net/x' } } }, [AT])
  await nothing('a redirect to localhost — never followed', { [AT]: { status: 307, headers: { location: 'https://localhost/x' } } }, [AT])
  await nothing('a redirect with nowhere to go', { [AT]: { status: 302 } }, [AT])
  {
    const loop = (n: number) => `https://arweave.net/hop-${n}`
    const routes: Parameters<typeof fetcher>[0] = { [AT]: { status: 302, headers: { location: loop(1) } } }
    for (let n = 1; n <= 5; n++) routes[loop(n)] = { status: 302, headers: { location: loop(n + 1) } }
    await nothing('more than three redirects', routes, [AT, loop(1), loop(2), loop(3)])
  }
  await nothing('a source that says it is over 30 MB — not read',
    { [AT]: { headers: { 'content-length': String(31 * 1024 * 1024) }, body: Buffer.from('x') } }, [AT])
  {
    // No length given: read until it passes the cap, then stopped.
    let pulled = 0
    let cancelled = false
    const chunk = new Uint8Array(1024 * 1024)
    const endless = new ReadableStream<Uint8Array>({
      pull(c) { pulled++; c.enqueue(chunk) },
      cancel() { cancelled = true },
    })
    await nothing('a source that grows past 30 MB unannounced', { [AT]: { body: endless } }, [AT])
    check('and it is read no further than the cap', cancelled && pulled <= 32, `pulled ${pulled} MB, cancelled ${cancelled}`)
  }
  {
    const ms = await nothing('a source that never answers', { [AT]: 'hang' }, [AT])
    check('given up on within the budget (4 s)', ms >= 3900 && ms < 5000, `${ms} ms`)
  }
  {
    // Answers, then stalls mid-body: the same budget covers the read.
    const stalls = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(10)) }, pull: () => new Promise(() => {}) })
    const { fn } = fetcher({ [AT]: { body: stalls } })
    const wrapped = (async (u: RequestInfo | URL, init?: RequestInit) => {
      const res = await fn(u, init)
      // Tie the body to the signal, as a real fetch does.
      const reader = res.body!.getReader()
      const body = new ReadableStream<Uint8Array>({
        pull: (c) => Promise.race([
          reader.read().then(({ done, value }) => (done ? c.close() : c.enqueue(value))),
          new Promise<void>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })),
        ]),
      })
      return new Response(body, { status: res.status, headers: res.headers })
    }) as typeof fetch
    const started = Date.now()
    const open = setTimeout(() => {}, 10_000)
    const src = await shareImageSource(COVER, undefined, cacheDir, wrapped).finally(() => clearTimeout(open))
    const ms = Date.now() - started
    check('and on a body that stalls part way', src === undefined && ms >= 3900 && ms < 5000, `${src?.slice(0, 30)} | ${ms} ms`)
  }
} finally {
  rmSync(cacheDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`\n${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nOK — a share card draws its image, or its text, never a blank')
