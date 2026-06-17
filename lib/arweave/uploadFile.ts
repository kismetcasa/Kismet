import { TurboFactory } from '@ardrive/turbo-sdk/web'
import { makeProxySigner } from './client'
import { getPaidBy } from './paidBy'
import patchFetch from './patchFetch'

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
      }
    }
    throw lastError
  } finally {
    unpatch()
  }
}
