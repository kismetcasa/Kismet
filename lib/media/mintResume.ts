import { GLB_MIME } from '@/lib/glbFormat'
import { PDF_MIME } from '@/lib/pdfFormat'
import type { ZineAccess } from './zineHint'

/**
 * The mint form's resume decisions, pure (verify-zine-media pins them): may
 * a banked upload session stand in for a new upload, and does the banked
 * media owe a poster? Both were inline conditions in the form, where a
 * collectors-only zine resumed by uploading its cover a second time and a
 * cover changed after a failed attempt went unnoticed.
 */

/** What a banked upload session remembers about the files it uploaded. */
export interface BankedUploadFiles {
  /** The pick the session was banked for. */
  source: File
  /** What went to Arweave as the media: the PDF or the cover of a zine, the
   *  GLB of a model, the still or the video otherwise. */
  mediaFile: File
  /** A zine's cover as picked at the banked attempt (the upload, or the page
   *  captured by the preview), or null when unknown — a reload's record
   *  keeps no File. */
  coverSource: File | null
  verifyFailures: number
}

export interface ZinePickState {
  isZine: boolean
  access: ZineAccess
  /** The cover the form holds now: the upload, else the captured page. */
  cover: File | null
}

/**
 * May the banked session be resumed for this pick? The same file, not yet
 * given up on, and — for a zine — banked under the same choice of who can
 * read it (the PDF goes to Arweave for everyone, the cover for collectors
 * only; a session banked under the other choice would mint the wrong thing)
 * with the same cover (a different one is a different artwork; an unknown
 * one, after a reload, counts as the same).
 */
export function canResumeUpload(
  session: BankedUploadFiles | null,
  file: File | null,
  zine: ZinePickState,
  maxFailures: number,
): boolean {
  if (!session || !file || session.source !== file || session.verifyFailures >= maxFailures) return false
  if (!zine.isZine) return true
  if ((zine.access === 'public') !== (session.mediaFile.type === PDF_MIME)) return false
  if (session.coverSource && session.coverSource !== zine.cover) return false
  return true
}

/**
 * Does the banked media need a poster of its own? Only a PDF or a model: a
 * collectors-only zine banks the cover AS its media, and a poster fallback
 * there would upload that same cover a second time.
 */
export function resumeNeedsPoster(session: Pick<BankedUploadFiles, 'mediaFile'>): boolean {
  return session.mediaFile.type === PDF_MIME || session.mediaFile.type === GLB_MIME
}
