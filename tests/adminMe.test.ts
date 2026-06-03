// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '@/app/api/admin/me/route'
import { ADMIN_ADDRESS } from '@/lib/config'

// Demonstrates the Route-Handler test pattern: import the exported GET, call
// it with a NextRequest, assert on the Response. This handler reads config
// only (no Redis), so it needs no mocks.
async function call(qs: string) {
  const res = await GET(new NextRequest(`https://kismet.art/api/admin/me${qs}`))
  return res.json() as Promise<{ isAdmin: boolean; isCurator: boolean }>
}

describe('GET /api/admin/me', () => {
  it('reports the configured admin address as admin', async () => {
    const json = await call(`?address=${ADMIN_ADDRESS}`)
    expect(json.isAdmin).toBe(true)
  })
  it('reports a random address as neither admin nor curator', async () => {
    const json = await call(`?address=0x${'9'.repeat(40)}`)
    expect(json.isAdmin).toBe(false)
    expect(json.isCurator).toBe(false)
  })
  it('reports false when no address is supplied', async () => {
    const json = await call('')
    expect(json.isAdmin).toBe(false)
    expect(json.isCurator).toBe(false)
  })
})
