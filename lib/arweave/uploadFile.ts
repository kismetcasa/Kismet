import { TurboFactory } from '@ardrive/turbo-sdk/web'
import { makeProxySigner } from './client'
import { getPaidBy } from './paidBy'
import patchFetch from './patchFetch'
import { describeUploadError, isNonRetryableUploadStatus, uploadErrorStatus } from './uploadError'

const MAX_ATTEMPTS = 3

export async function uploadFile(
  file: File,
  onProgress: (pct: number) => void = () => {},
): Promise<string> {
  const unpatch = patchFetch()
  try {
    const signer = makeProxySigner()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const turbo = TurboFactory.authenticated({ signer: signer as any })

    const paidBy = getPaidBy()
    let lastError: unknown
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        onProgress(0)
        await new Promise((resolve) =>
          setTimeout(resolve, 2000 * Math.pow(2, attempt - 1)),
        )
      }
      try {
        const { id } = await turbo.uploadFile({
          fileStreamFactory: () =>
            file.stream() as unknown as ReadableStream<Uint8Array>,
          fileSizeFactory: () => file.size,
          dataItemOpts: {
            tags: [
              { name: 'Content-Type', value: file.type || 'application/octet-stream' },
              { name: 'File-Name', value: file.name },
            ],
            ...(paidBy && { paidBy }),
          },
          events: {
            onProgress: ({ processedBytes, totalBytes }) => {
              onProgress(Math.round((processedBytes / totalBytes) * 95))
            },
          },
        })

        onProgress(100)
        return `ar://${id}`
      } catch (err) {
        lastError = err
        // Turbo exhausts its OWN retries before throwing, and a 4xx from the
        // upload service is a deterministic verdict — re-running the whole
        // upload can't change a client error, it only delays the toast by the
        // backoff. Most important is 402 `Insufficient balance`, thrown at
        // finalize (after the bytes have streamed — hence the failure landing
        // at a high progress %) when the platform's Turbo credits / the
        // shareCredits approval behind paidBy are depleted. Bail now with a
        // classified message instead of the SDK's opaque "after 1 attempts".
        const status = uploadErrorStatus(err)
        if (isNonRetryableUploadStatus(status)) {
          console.error('[uploadFile] non-retryable upload failure', {
            status,
            detail: err instanceof Error ? err.message : String(err),
          })
          throw Object.assign(new Error(describeUploadError(status)), { status, cause: err })
        }
      }
    }
    // Transient (5xx / network) failure that survived every retry.
    console.error('[uploadFile] upload failed after retries', {
      detail: lastError instanceof Error ? lastError.message : String(lastError),
    })
    throw lastError
  } finally {
    unpatch()
  }
}
