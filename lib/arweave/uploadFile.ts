import { TurboFactory } from '@ardrive/turbo-sdk/web'
import { makeProxySigner } from './client'
import patchFetch from './patchFetch'

export async function uploadFile(
  file: File,
  onProgress: (pct: number) => void = () => {},
  sessionToken: string,
): Promise<string> {
  const unpatch = patchFetch()
  try {
    const signer = makeProxySigner(sessionToken)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const turbo = TurboFactory.authenticated({ signer: signer as any })

    const { id } = await turbo.uploadFile({
      fileStreamFactory: () => file.stream() as unknown as ReadableStream<Uint8Array>,
      fileSizeFactory: () => file.size,
      dataItemOpts: {
        tags: [
          { name: 'Content-Type', value: file.type || 'application/octet-stream' },
          { name: 'File-Name', value: file.name },
        ],
      },
      events: {
        onProgress: ({ processedBytes, totalBytes }) => {
          onProgress(Math.round((processedBytes / totalBytes) * 95))
        },
      },
    })

    onProgress(100)
    return `ar://${id}`
  } finally {
    unpatch()
  }
}
