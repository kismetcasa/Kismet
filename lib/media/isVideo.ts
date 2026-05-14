// Recognised video container extensions. Kismet mints today produce `.mp4`
// via the GIF transcoder; the rest cover artist-uploaded files that arrived
// at Arweave with their original extension preserved.
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.ogv', '.m4v']

// Strip query + fragment before the extension test — signed gateway URLs
// like `…/foo.mp4?sig=…` would otherwise fail `endsWith('.mp4')`.
function pathname(uri: string): string {
  const noFragment = uri.split('#', 1)[0]
  const noQuery = noFragment.split('?', 1)[0]
  return noQuery.toLowerCase()
}

/**
 * Single source of truth for "is this moment a video?". Prefers the explicit
 * MIME hint from `metadata.content.mime`; falls back to extension sniffing
 * the `animation_url` (ar://-hash URIs have no extension, but
 * `https://…/foo.mp4` style URLs still occur).
 */
export function isVideoMoment(meta: {
  content?: { mime?: string }
  animation_url?: string
}): boolean {
  if (meta.content?.mime?.startsWith('video/')) return true
  if (!meta.animation_url) return false
  const path = pathname(meta.animation_url)
  return VIDEO_EXTENSIONS.some((ext) => path.endsWith(ext))
}
