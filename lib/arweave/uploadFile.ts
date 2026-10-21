import { TurboFactory, multipartFailedStatus } from '@ardrive/turbo-sdk/web'
import { makeProxySigner } from './client'
import { getPaidBy } from './paidBy'
import patchFetch from './patchFetch'
import { describeUploadError, isNonRetryableUploadStatus, uploadErrorStatus } from './uploadError'

// Over 10 MiB, Turbo confirms an upload after taking its chunks. The SDK waits 2.5
// minutes per started GiB for that, then signs and sends the file again: a new data
// item each time, billable if Turbo confirms it. So the confirmation gets a longer
// window, and once the finalize request is sent no other data item is made.
const FINALIZE_WINDOW_MS = 15 * 60_000
const MAX_ATTEMPTS = 3
const MAX_SIGNINGS = 5

// The SDK's HTTP service is per client, so watching it sees this upload alone, however
// many run at once. Not public API: scripts/verify-upload-policy.ts fails if it changes.
type TurboHttp = Record<'get' | 'post', (req: { endpoint: string }) => Promise<unknown>>
const INIT_RE = /^\/chunks\/[^/]+\/-1\/-1(\?|$)/
const FINALIZE_RE = /^\/chunks\/[^/]+\/[^/]+\/finalize(\?|$)/
const STATUS_RE = /^\/chunks\/[^/]+\/[^/]+\/status(\?|$)/

export async function uploadFile(
  file: File,
  onProgress: (pct: number) => void = () => {},
  onFinalizing: () => void = () => {},
): Promise<string> {
  const abort = new AbortController()
  let backstop: ReturnType<typeof setTimeout> | undefined
  let uploadId: string | undefined
  let lastStatus: string | undefined
  let finalizeStartedAt: number | undefined
  let signings = 0

  // How a confirmation that started has ended. One line: lib/toast.ts shows only the first.
  const finalizeOutcome = () => {
    const ref = `ref ${uploadId ?? 'unknown'}`
    if (lastStatus !== undefined && (multipartFailedStatus as readonly string[]).includes(lastStatus)) {
      return new Error(`Arweave rejected this upload (${lastStatus}). Nothing was minted (${ref})`)
    }
    const waited = Math.max(1, Math.round((Date.now() - (finalizeStartedAt ?? Date.now())) / 60_000))
    return new Error(
      `Arweave hasn't confirmed this upload after ${waited} minute${waited === 1 ? '' : 's'}. Nothing was minted; try again later (${ref})`,
    )
  }

  const signer = makeProxySigner()
  const guardedSigner = {
    ...signer,
    async sign(hash: Uint8Array): Promise<Uint8Array> {
      // The SDK signs once per attempt; an attempt after finalize would be a second
      // billable data item for the same file.
      if (finalizeStartedAt !== undefined) throw finalizeOutcome()
      if (signings >= MAX_SIGNINGS) throw new Error(`No upload after ${MAX_SIGNINGS} signings`)
      const signature = await signer.sign(hash)
      signings++
      return signature
    },
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const turbo = TurboFactory.authenticated({ signer: guardedSigner as any })
  const http = (turbo as unknown as { uploadService?: { httpService?: Partial<TurboHttp> } }).uploadService?.httpService
  if (typeof http?.get === 'function' && typeof http.post === 'function') {
    const get = http.get.bind(http)
    const post = http.post.bind(http)
    http.get = async (req) => {
      const body = await get(req)
      if (INIT_RE.test(req.endpoint)) uploadId = (body as { id?: string }).id
      else if (STATUS_RE.test(req.endpoint)) lastStatus = (body as { status?: string }).status
      return body
    }
    http.post = (req) => {
      if (FINALIZE_RE.test(req.endpoint) && finalizeStartedAt === undefined) {
        finalizeStartedAt = Date.now()
        onFinalizing()
        // maxFinalizeMs bounds the status polling; this bounds a request that never answers.
        backstop = setTimeout(() => abort.abort(), FINALIZE_WINDOW_MS + 30_000)
      }
      return post(req)
    }
  }

  const paidBy = getPaidBy()
  const upload = () =>
    turbo.uploadFile({
      fileStreamFactory: () => file.stream() as unknown as ReadableStream<Uint8Array>,
      fileSizeFactory: () => file.size,
      dataItemOpts: {
        tags: [
          { name: 'Content-Type', value: file.type || 'application/octet-stream' },
          { name: 'File-Name', value: file.name },
        ],
        ...(paidBy && { paidBy }),
      },
      signal: abort.signal,
      maxFinalizeMs: FINALIZE_WINDOW_MS,
      events: {
        onProgress: ({ processedBytes, totalBytes }) => {
          onProgress(Math.round((processedBytes / totalBytes) * 95))
        },
      },
    })

  const classify = (err: unknown): Error => {
    // /api/sign already said why (signed out, daily limit): show its words.
    if (err instanceof Error && (err as Error & { signing?: boolean }).signing === true) {
      return new Error(err.message.split('\n')[0])
    }
    // A 4xx is Turbo's verdict and a retry can't change it. 402 (the credits behind
    // paidBy are spent) arrives only at finalize, after every byte has gone.
    const status = uploadErrorStatus(err)
    if (!isNonRetryableUploadStatus(status) && finalizeStartedAt !== undefined) return finalizeOutcome()
    return Object.assign(new Error(describeUploadError(status)), { status, cause: err })
  }

  const unpatch = patchFetch()
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        const { id } = await upload()
        onProgress(100)
        return `ar://${id}`
      } catch (err) {
        // The SDK has already retried what it can. This retry is for a failure before
        // Turbo holds the bytes (a sign request that failed, say), never after.
        const retry =
          attempt < MAX_ATTEMPTS &&
          signings < MAX_SIGNINGS &&
          finalizeStartedAt === undefined &&
          !isNonRetryableUploadStatus(uploadErrorStatus(err))
        if (!retry) {
          console.error('[uploadFile] upload failed', {
            detail: err instanceof Error ? err.message : String(err),
            uploadId,
            lastStatus,
            signings,
          })
          throw classify(err)
        }
        onProgress(0)
        await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** (attempt - 1)))
      }
    }
  } finally {
    clearTimeout(backstop)
    unpatch()
  }
}
