'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * File picker + drop-zone state with automatic blob-URL lifecycle:
 * createObjectURL on accept, revokeObjectURL on replace / clear / unmount.
 * `maxBytes` rejects oversized files via the `onTooLarge` callback.
 */
export function useFileUpload(
  opts: { maxBytes?: number; onTooLarge?: () => void } = {},
) {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const accept = (f: File | undefined) => {
    if (!f) return
    if (opts.maxBytes && f.size > opts.maxBytes) { opts.onTooLarge?.(); return }
    if (preview) URL.revokeObjectURL(preview)
    setFile(f)
    setPreview(URL.createObjectURL(f))
  }

  // Release the blob on unmount so it doesn't pin memory until full GC.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])

  return {
    file,
    preview,
    inputRef,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => accept(e.target.files?.[0]),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); accept(e.dataTransfer.files[0]) },
    clear: () => {
      if (preview) URL.revokeObjectURL(preview)
      setFile(null)
      setPreview(null)
      if (inputRef.current) inputRef.current.value = ''
    },
  }
}
