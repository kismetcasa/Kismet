function b64urlToBuffer(b64url: string): Buffer {
  return Buffer.from(b64url.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

// Duck-typed Arweave signer: publicKey + sign() is all the Turbo web SDK needs.
// The JWK never leaves the server — only the deepHash (48 bytes, SHA-384) is
// sent to /api/sign. Auth is the httpOnly session cookie (set by /api/session),
// which fetch() includes automatically on same-origin requests.
export function makeProxySigner() {
  const n = process.env.NEXT_PUBLIC_ARWEAVE_N
  if (!n) throw new Error('NEXT_PUBLIC_ARWEAVE_N not configured')

  return {
    signatureType: 1 as const,
    signatureLength: 512,
    ownerLength: 512,
    publicKey: b64urlToBuffer(n),

    async sign(hash: Uint8Array): Promise<Uint8Array> {
      const res = await fetch('/api/sign', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash: Buffer.from(hash).toString('base64') }),
      })
      const data = (await res.json()) as { signature?: string; error?: string }
      if (!res.ok) throw Object.assign(new Error(data.error ?? 'Signing failed'), { status: res.status, signing: true })
      return Buffer.from(data.signature!, 'base64')
    },
  }
}
