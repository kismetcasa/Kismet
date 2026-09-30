import uploadToArweave from '@/lib/arweave/uploadToArweave'
import { canTranscode, extractGifPoster } from '@/lib/media/transcodeGif'
import { generateThumbhash } from '@/lib/media/thumbhash'
import { serially } from './frameUpload'
import type { MachineCover } from './types'

/**
 * Upload a machine's cover the way a collection's cover is uploaded
 * (EditCollectionForm): a gif becomes its first frame — a cover is a still
 * everywhere it shows — then the image goes to Arweave with its thumbhash.
 */
export async function uploadCover(file: File): Promise<MachineCover> {
  let image = file
  if (canTranscode(file)) {
    try {
      image = await serially(() => extractGifPoster(file))
    } catch (err) {
      console.warn('[cover] gif first-frame extraction failed; uploading the original', err)
    }
  }
  const thumbhash = generateThumbhash(image)
  const uri = await uploadToArweave(image)
  const hash = await thumbhash
  return { uri, ...(hash ? { thumbhash: hash } : {}) }
}
