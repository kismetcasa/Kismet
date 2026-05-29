/**
 * Ask the server to transcode an already-uploaded GIF (ar://) to MP4 +
 * poster. Used as the fallback when a GIF is too large for the in-browser
 * ffmpeg.wasm path (canTranscode() === false) or that path throws. The raw
 * GIF stays on Arweave as the archival source; the returned MP4 + poster
 * become the rendered asset so iOS WebKit (which can't decode large
 * animated GIFs) plays a video instead.
 */
export async function serverTranscodeGif(
  gifUri: string,
): Promise<{ animationUri: string; posterUri: string; thumbhash: string | null }> {
  const res = await fetch('/api/transcode-gif', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gifUri }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    animationUri?: string
    posterUri?: string
    thumbhash?: string | null
    error?: string
  }
  if (!res.ok || !data.animationUri || !data.posterUri) {
    throw new Error(data.error ?? 'Server transcode failed')
  }
  return {
    animationUri: data.animationUri,
    posterUri: data.posterUri,
    thumbhash: data.thumbhash ?? null,
  }
}
