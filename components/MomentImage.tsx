'use client'

import { useState, useEffect, useMemo } from 'react'
import Image, { type ImageProps } from 'next/image'
import { gatewayUrls } from '@/lib/arweave/gateways'

interface CommonProps {
  /** Raw URI: ar://, ipfs://, https://, blob:, or data: */
  src: string
  /** Fired once every gateway has errored, so the parent can swap in a placeholder. */
  onAllError?: () => void
}

function useFallbackUrl(uri: string, onAllError?: () => void) {
  const urls = useMemo(() => gatewayUrls(uri), [uri])
  const [index, setIndex] = useState(0)
  // Reset when the URI changes (different moment, edit replaced the image, etc.)
  useEffect(() => { setIndex(0) }, [uri])
  return {
    url: index < urls.length ? urls[index] : null,
    onError: () => {
      const next = index + 1
      if (next >= urls.length) onAllError?.()
      setIndex(next)
    },
  }
}

type NextImageProps = CommonProps & Omit<ImageProps, 'src' | 'onError'>

/**
 * next/image wrapper that walks the public gateway pool on error. ar:// and
 * ipfs:// URIs fan out to every gateway in turn — the first 200 wins, and
 * onAllError fires once the pool is exhausted so the parent can show its
 * "no preview" fallback. https://, blob:, and data: URIs are rendered as-is.
 */
export function MomentImage({ src, onAllError, ...rest }: NextImageProps) {
  const { url, onError } = useFallbackUrl(src, onAllError)
  if (!url) return null
  // alt comes through ...rest; ImageProps already requires it at the type level.
  // eslint-disable-next-line jsx-a11y/alt-text
  return <Image key={url} src={url} onError={onError} {...rest} />
}

type ImgProps = CommonProps & Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onError'>

/**
 * Plain <img> with the same fallback behaviour as MomentImage. Use when raw
 * <img> semantics are needed — the lightbox shows a full-res unoptimized
 * image, and the edit-preview thumbnail can hold a blob URL from the file
 * picker (which next/image's optimizer doesn't accept).
 */
export function MomentImg({ src, onAllError, ...rest }: ImgProps) {
  const { url, onError } = useFallbackUrl(src, onAllError)
  if (!url) return null
  // alt comes through ...rest; the lightbox/edit-preview call sites pass it.
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  return <img key={url} src={url} onError={onError} {...rest} />
}
