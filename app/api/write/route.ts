import { type NextRequest } from 'next/server'
import { proxyMintRequest } from '@/lib/mint-proxy'

export async function POST(req: NextRequest) {
  return proxyMintRequest(req, 'write', 'moment/create/writing')
}
