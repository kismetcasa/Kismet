// Shared classification for ArDrive Turbo upload failures, used by both the
// client streaming path (uploadFile.ts) and the server JSON path
// (app/api/upload). Turbo's `FailedRequestError` carries the upload service's
// HTTP status on `.status`; we duck-type it rather than importing the SDK's
// internal error class (the web and node entrypoints ship different copies,
// and it isn't part of the public surface).

/** Pull the upload-service HTTP status off a Turbo error, if present. */
export function uploadErrorStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'status' in err) {
    const s = (err as { status?: unknown }).status
    if (typeof s === 'number') return s
  }
  return undefined
}

/**
 * A 4xx from the upload service is a deterministic client-error verdict —
 * retrying the same data item can't change it, so the caller should stop
 * immediately instead of burning its backoff schedule. (Turbo itself already
 * does this internally: its retry loop breaks without re-attempting on
 * 400–499, which is why such a failure reports "after 1 attempts".) The one
 * operators actually hit is 402 `Insufficient balance`, thrown at finalize
 * when the platform's Turbo credits — or the shareCredits approval behind
 * `paidBy` — are depleted.
 */
export function isNonRetryableUploadStatus(status: number | undefined): status is number {
  return status !== undefined && status >= 400 && status < 500
}

/**
 * Human-readable, classified message for an upload failure. Replaces the SDK's
 * opaque "Failed to upload file after 1 attempts" — whose useful second line
 * (`Failed request (Status 402): Insufficient balance`) the toast's
 * first-line extractor (lib/toast.ts `extractMessage`) drops on the floor.
 * Wording is storage-generic so it fits both the media and metadata paths.
 */
export function describeUploadError(status: number | undefined): string {
  switch (status) {
    case 402:
      return 'Storage credits are exhausted — uploads are temporarily unavailable. Please try again later.'
    case 401:
    case 403:
      return 'Storage service rejected the upload (authorization). Please try again later.'
    case 413:
      return 'File is too large to store.'
    default:
      if (status !== undefined && status >= 400 && status < 500) {
        return `Storage service rejected the upload (HTTP ${status}).`
      }
      return 'Upload failed — storage service unavailable. Please try again.'
  }
}
