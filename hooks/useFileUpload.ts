'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * File picker + drop-zone state with automatic blob-URL lifecycle:
 * createObjectURL on accept, revokeObjectURL on replace / clear / unmount.
 * `maxBytes` rejects oversized files via the `onTooLarge` callback.
 *
 * `accept` is the TYPE gate, and it is not optional rigour — an <input
 * accept="…"> attribute filters only the OS picker dialog, and
 * DRAG-AND-DROP BYPASSES IT ENTIRELY. Without a gate here, any file at all
 * reached the mint form: a dropped `.glb` (whose `File.type` is `''`,
 * because `.glb` has no registered browser MIME) rendered as a broken
 * <img>, and — worse — minting proceeded and wrote the model's URI into
 * `metadata.image`, producing a permanently broken artwork. Callers that
 * care about type MUST pass this; the attribute alone is decorative.
 */
export function useFileUpload(
  opts: {
    maxBytes?: number
    onTooLarge?: () => void
    /**
     * Type gate, run after the size check. Async so callers can sniff magic
     * bytes rather than trusting the extension or `File.type` (see
     * lib/media/modelMedia.isGlbFile). Return null to accept, or a
     * human-readable reason to reject.
     */
    accept?: (f: File) => string | null | Promise<string | null>
    /** Called with the rejected file and the reason `accept` gave. */
    onRejected?: (f: File, reason: string) => void
  } = {},
) {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // The live object URL. A ref (not the `preview` state) because the async
  // `accept` gate below means the revoke can run a tick after the closure
  // that scheduled it, and a stale closure would leak the previous blob.
  const urlRef = useRef<string | null>(null)
  // Monotonic token so a slow `accept` on an earlier file can never install
  // itself over a later pick (drop twice quickly and the second wins).
  const pickRef = useRef(0)

  const setUrl = (url: string | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = url
    setPreview(url)
  }

  // Deliberately NOT memoized. It is only ever reached through the
  // `onChange` / `onDrop` closures below, which are rebuilt every render
  // anyway, so a stable identity would buy nothing — and buying it would mean
  // holding `opts` in a ref to dodge the stale-closure problem that
  // memoization itself creates. Reading `opts` straight from this render is
  // both simpler and always current.
  const accept = async (f: File | undefined) => {
    if (!f) return
    const token = ++pickRef.current
    if (opts.maxBytes && f.size > opts.maxBytes) { opts.onTooLarge?.(); return }
    if (opts.accept) {
      let reason: string | null
      try {
        reason = await opts.accept(f)
      } catch {
        reason = 'That file could not be read'
      }
      // A newer pick landed while we were sniffing — drop this one silently.
      if (token !== pickRef.current) return
      if (reason !== null) { opts.onRejected?.(f, reason); return }
    }
    setFile(f)
    setUrl(URL.createObjectURL(f))
  }

  // Release the blob on unmount so it doesn't pin memory until full GC.
  useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = null
  }, [])

  return {
    file,
    preview,
    inputRef,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const picked = e.target.files?.[0]
      // Reset the input NOW, not on clear(): re-picking the same file after a
      // rejection fires no change event while the value still names it.
      e.target.value = ''
      void accept(picked)
    },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); void accept(e.dataTransfer.files[0]) },
    clear: () => {
      pickRef.current++
      setFile(null)
      setUrl(null)
      if (inputRef.current) inputRef.current.value = ''
    },
  }
}
