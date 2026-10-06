import uploadToArweave from '@/lib/arweave/uploadToArweave'
import { canTranscode, extractGifPoster } from '@/lib/media/transcodeGif'
import { isAnimatedImage, isSvg } from '@/lib/media/flashScreen'
import { generateThumbhash } from '@/lib/media/thumbhash'
import { serially } from './frameUpload'
import type { MachineCover } from './types'

/**
 * A machine's cover as it will be uploaded — a still, as a cover is
 * everywhere it shows, the card and the stage among them: a gif becomes its
 * first frame (as a collection's cover does, EditCollectionForm), and any
 * other image that moves, or can (an SVG), is refused, as is a gif whose first
 * frame cannot be taken. Never the moving original: the stage would show it unscreened
 * (lib/media/flashScreen). Prepared as it is picked, so the creator hears at
 * once; a string says why not.
 */
export async function prepareCover(file: File): Promise<File | string> {
  if (canTranscode(file)) {
    try {
      return await serially(() => extractGifPoster(file))
    } catch {
      return 'This gif could not be made a still — try it again, or as a png or jpg'
    }
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (isAnimatedImage(bytes)) {
    return 'This image moves — a cover is a still: use a png or jpg, or a gif (its first frame is used)'
  }
  if (isSvg(bytes)) {
    return 'An SVG can move by itself — a cover is a still: use a png or jpg, or a gif (its first frame is used)'
  }
  return file
}

/** Upload a prepared cover (prepareCover) with its thumbhash. */
export async function uploadCover(image: File): Promise<MachineCover> {
  const thumbhash = generateThumbhash(image)
  const uri = await uploadToArweave(image)
  const hash = await thumbhash
  return { uri, ...(hash ? { thumbhash: hash } : {}) }
}
