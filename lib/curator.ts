import { verifyMessage } from 'viem'
import { CURATOR_ADDRESSES } from './config'

const ADMIN_ADDRESS = (process.env.ADMIN_ADDRESS ?? '').toLowerCase()
const SESSION_TTL = 4 * 60 * 60 * 1000 // 4 hours

/**
 * Verify a session signature from either the admin or any allowlisted
 * curator. Shared by /api/featured and /api/creator-lists so both routes
 * accept the same client-side AdminContext session without forking the
 * verification logic.
 *
 * The signed message embeds the signer's own address (matching what
 * AdminContext signs), and we accept the request only if (a) the
 * signature recovers to that address and (b) the address is one of the
 * privileged ones. signerAddress is required so a forged curator address
 * can't piggyback on someone else's signature.
 */
export async function verifyPrivilegedSession(body: {
  signature?: string
  timestamp?: number
  signerAddress?: string
}): Promise<{ error: string; status: number } | null> {
  if (!body.signature || body.timestamp == null || !body.signerAddress) {
    return { error: 'signature, timestamp, and signerAddress required', status: 400 }
  }
  if (Date.now() - body.timestamp > SESSION_TTL) {
    return { error: 'Session expired — please sign in again', status: 401 }
  }
  const signer = body.signerAddress.toLowerCase()
  const allowed =
    (!!ADMIN_ADDRESS && signer === ADMIN_ADDRESS) || CURATOR_ADDRESSES.includes(signer)
  if (!allowed) return { error: 'Not authorized', status: 403 }

  const message = `Kismet Art admin session\nAddress: ${signer}\nTimestamp: ${body.timestamp}`
  const verified = await verifyMessage({
    address: signer as `0x${string}`,
    message,
    signature: body.signature as `0x${string}`,
  })
  if (!verified) return { error: 'Signature verification failed', status: 401 }
  return null
}
