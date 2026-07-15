import 'server-only'
import { TurboFactory } from '@ardrive/turbo-sdk'
import { getPaidBy } from './paidBy'
import { describeUploadError, isNonRetryableUploadStatus, uploadErrorStatus } from './uploadError'

/**
 * Server-side Arweave upload via Turbo (paid by the platform ARWEAVE_JWK) — the
 * single source of truth for "bytes → ar://<id>" on the server. The app's media
 * path normally streams client → Turbo (server only signs the deep-hash, see
 * app/api/sign), so this exists for the ONE flow that can't stream: an AI
 * assistant minting via MCP, where the server ingests the media and metadata
 * itself. Mirrors the retry/short-circuit logic in app/api/upload's JSON path.
 *
 * Callers MUST bound abuse before calling (Pass gate + upload-bytes quota),
 * exactly like app/api/upload does — this helper only moves bytes.
 */

function getTurbo() {
  const key = process.env.ARWEAVE_JWK
  if (!key) throw new Error('ARWEAVE_JWK not configured')
  const jwk = JSON.parse(Buffer.from(key, 'base64').toString())
  return TurboFactory.authenticated({ privateKey: jwk })
}

/** Upload bytes (or a UTF-8 string) tagged with `contentType`. Returns `ar://<id>`. */
export async function uploadBytesToArweave(data: Buffer | string, contentType: string): Promise<string> {
  const turbo = getTurbo()
  const paidBy = getPaidBy()
  const MAX_ATTEMPTS = 3
  let lastErr: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt - 1)))
    try {
      const { id } = await turbo.upload({
        data,
        dataItemOpts: {
          tags: [{ name: 'Content-Type', value: contentType }],
          ...(paidBy && { paidBy }),
        },
      })
      return `ar://${id}`
    } catch (err) {
      lastErr = err
      // 4xx (e.g. 402 exhausted credit) won't change on retry — surface it.
      const status = uploadErrorStatus(err)
      if (isNonRetryableUploadStatus(status)) {
        throw new Error(describeUploadError(status))
      }
    }
  }
  throw new Error(lastErr instanceof Error ? lastErr.message : describeUploadError(undefined))
}

/** Convenience: upload a JSON object as `application/json`. */
export function uploadJsonToArweave(json: object): Promise<string> {
  return uploadBytesToArweave(JSON.stringify(json), 'application/json')
}
