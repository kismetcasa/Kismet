// Dynamic import keeps @ardrive/turbo-sdk/web out of the initial bundle —
// it loads a separate webpack chunk over the network at call time. A
// transient CDN/network blip (or an in-flight deploy that rotated chunk
// hashes while this client kept an old page open) makes import() throw a
// ChunkLoadError. Retry a couple times with a short backoff so a blip
// self-heals; a genuinely-missing chunk (stale deploy) still throws after
// the retries, where toastError surfaces a Reload action (see lib/toast.ts).
const uploadToArweave = async (
  file: File,
  getProgress: (progress: number) => void = () => {},
): Promise<string> => {
  const { uploadFile } = await importUploadFile()
  return uploadFile(file, getProgress)
}

async function importUploadFile(): Promise<typeof import('./uploadFile')> {
  const MAX_ATTEMPTS = 3
  let lastErr: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
    }
    try {
      return await import('./uploadFile')
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}

export default uploadToArweave
