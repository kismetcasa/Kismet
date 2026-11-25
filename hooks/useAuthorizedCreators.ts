'use client'

import { useCallback, useEffect, useState } from 'react'
import type { Address } from 'viem'
import { useUploadSession } from '@/hooks/useUploadSession'

export interface AuthorizedCreatorEntry {
  /** The creator's EOA. Undefined on an unmapped row whose one ADMIN address
   *  couldn't be paired with an EOA — that address is in `smartWallet`. */
  eoa: string | undefined
  /** The on-chain ADMIN grantee: the creator's inprocess smart wallet, or on
   *  an unpaired unmapped row, the address that holds ADMIN. */
  smartWallet: string
  label?: string
  grantedBy: string
  grantedAt: number
  /** The smart wallet still holds ADMIN (read server-side). False greys out a
   *  recorded row whose grant was revoked outside the panel. */
  liveOnChain: boolean
  /** Holds ADMIN with no Kismet record — granted outside the panel, or its
   *  save never landed. Revocable; savable when both addresses are known. */
  unmapped: boolean
}

export interface CreatorGrant {
  eoa: string
  smartWallet: string
  label?: string
}

export type SaveOutcome = { ok: true } | { ok: false; status?: number; error: string }

const ENDPOINT = '/api/collection/authorized-creators'
/** A save runs after the grant is on chain, so it gets retries; a refusal
 *  (4xx other than 429) stops them — it won't change on a retry. */
const SAVE_ATTEMPTS = 3
const SAVE_BACKOFF_MS = 800
const EMPTY: AuthorizedCreatorEntry[] = []

async function errorText(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: unknown } | null
  return typeof data?.error === 'string' && data.error ? data.error : `HTTP ${res.status}`
}

function parseRows(raw: unknown): AuthorizedCreatorEntry[] {
  if (!Array.isArray(raw)) return []
  const rows: AuthorizedCreatorEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    if (typeof r.smartWallet !== 'string') continue
    rows.push({
      eoa: typeof r.eoa === 'string' ? r.eoa : undefined,
      smartWallet: r.smartWallet,
      label: typeof r.label === 'string' ? r.label : undefined,
      grantedBy: typeof r.grantedBy === 'string' ? r.grantedBy : '',
      grantedAt: typeof r.grantedAt === 'number' ? r.grantedAt : 0,
      liveOnChain: r.liveOnChain !== false,
      unmapped: r.unmapped === true,
    })
  }
  return rows
}

/**
 * The collection's authorized creators, as GET /api/collection/authorized-
 * creators merges them: the grants the panel recorded (stale when the smart
 * wallet lost ADMIN), plus every other token-0 ADMIN holder as an unmapped
 * row. Also carries the panel's writes:
 *
 *   - startGrant: record the grant BEFORE its transaction (throws with the
 *     server's reason — nothing is on chain yet, so the admin just retries);
 *   - saveGrant: record it after the receipt, with retries. If it still
 *     fails, the next GET finishes the started grant once the chain shows
 *     the smart wallet holding ADMIN;
 *   - dropGrant: forget the record after a revoke.
 *
 * Every write re-proves the session once on a 401 — the cookie can lapse
 * between the pre-flight ensureSession() and a post-receipt write, and the
 * admin is there to sign.
 */
export function useAuthorizedCreators(collection: Address | undefined) {
  const { ensureSession } = useUploadSession()
  // Rows stay tagged with the collection they were read for: another
  // collection's list never shows, and a failed refetch (429, 503) keeps the
  // last good list instead of blanking the panel.
  const [state, setState] = useState<{ collection?: string; rows: AuthorizedCreatorEntry[] }>({ rows: EMPTY })
  const [loading, setLoading] = useState(false)

  /** Resolves to the fresh rows, or null when the read failed. */
  const refetch = useCallback(async (): Promise<AuthorizedCreatorEntry[] | null> => {
    if (!collection) return null
    setLoading(true)
    try {
      const res = await fetch(`${ENDPOINT}?collection=${collection}`, { cache: 'no-store' })
      if (!res.ok) return null
      const data = (await res.json()) as { creators?: unknown }
      const rows = parseRows(data.creators)
      setState({ collection, rows })
      return rows
    } catch {
      return null
    } finally {
      setLoading(false)
    }
  }, [collection])

  useEffect(() => {
    void refetch()
  }, [refetch])

  const send = useCallback(
    async (url: string, init: RequestInit): Promise<Response> => {
      const res = await fetch(url, { credentials: 'same-origin', ...init })
      if (res.status !== 401) return res
      try {
        await ensureSession({ revalidate: true })
      } catch {
        return res
      }
      return fetch(url, { credentials: 'same-origin', ...init })
    },
    [ensureSession],
  )

  const post = useCallback(
    (body: Record<string, unknown>) =>
      send(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection, ...body }),
      }),
    [collection, send],
  )

  const startGrant = useCallback(
    async (grant: CreatorGrant): Promise<void> => {
      const res = await post({ ...grant, stage: 'pending' })
      if (!res.ok) throw new Error(await errorText(res))
    },
    [post],
  )

  const saveGrant = useCallback(
    async (grant: CreatorGrant): Promise<SaveOutcome> => {
      let last: SaveOutcome = { ok: false, error: 'not attempted' }
      for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, SAVE_BACKOFF_MS * attempt))
        try {
          const res = await post({ ...grant })
          if (res.ok) return { ok: true }
          last = { ok: false, status: res.status, error: await errorText(res) }
          if (res.status < 500 && res.status !== 429) break
        } catch (err) {
          last = { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
      console.error('[authorize-creator] save failed', last)
      return last
    },
    [post],
  )

  const dropGrant = useCallback(
    async (eoa: string): Promise<boolean> => {
      try {
        const res = await send(`${ENDPOINT}?collection=${collection}&eoa=${eoa}`, { method: 'DELETE' })
        if (!res.ok) {
          console.error('[authorize-creator] record delete rejected', {
            status: res.status,
            detail: await errorText(res),
          })
        }
        return res.ok
      } catch (err) {
        console.error('[authorize-creator] record delete failed', err)
        return false
      }
    },
    [collection, send],
  )

  const creators = state.collection === collection ? state.rows : EMPTY
  return { creators, loading, refetch, startGrant, saveGrant, dropGrant }
}
