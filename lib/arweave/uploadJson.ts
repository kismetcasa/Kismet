export async function uploadJson(json: object, sessionToken: string): Promise<string> {
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ json, sessionToken }),
  })
  const data = await res.json() as { uri?: string; error?: string }
  if (!res.ok) throw new Error(data.error ?? 'Metadata upload failed')
  return data.uri!
}
