// Dynamic import keeps @ardrive/turbo-sdk/web out of the initial bundle.
const uploadToArweave = async (
  file: File,
  getProgress: (progress: number) => void = () => {},
  sessionToken: string,
): Promise<string> => {
  const { uploadFile } = await import('./uploadFile')
  return uploadFile(file, getProgress, sessionToken)
}

export default uploadToArweave
