export async function uploadJson(json: object): Promise<string> {
  const res = await fetch('/api/upload', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ json }),
  })
  const data = await res.json() as { uri?: string; error?: string }
  if (!res.ok) throw new Error(data.error ?? 'Metadata upload failed')
  if (!data.uri) throw new Error('Upload returned no URI')
  return data.uri
}
