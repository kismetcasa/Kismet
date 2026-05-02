import type { UploadAuth } from './uploadJson'

// Dynamic import keeps @ardrive/turbo-sdk/web out of the initial bundle.
const uploadToArweave = async (
  file: File,
  getProgress: (progress: number) => void = () => {},
  auth: UploadAuth,
): Promise<string> => {
  const { uploadFile } = await import('./uploadFile')
  return uploadFile(file, getProgress, auth)
}

export default uploadToArweave
