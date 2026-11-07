// lib/arweave/uploadServer.ts for scripts/e2e/drops-flow.ts: content-addressed
// in memory, so the harness can assert what settling would make permanent.
import { createHash } from 'node:crypto'

export const arweaveUploads: { id: string; contentType: string; bytes: Buffer }[] = []

export async function uploadBytesToArweave(data: Buffer | string, contentType: string): Promise<string> {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  const id = createHash('sha256').update(bytes).digest('base64url')
  arweaveUploads.push({ id, contentType, bytes })
  return `ar://${id}`
}

export function uploadJsonToArweave(json: object): Promise<string> {
  return uploadBytesToArweave(JSON.stringify(json), 'application/json')
}
