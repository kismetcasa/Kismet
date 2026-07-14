import { serializeJsonLd } from '@/lib/structuredData'

// Renders a schema.org JSON-LD block server-side. Kept as a plain (non-'use
// client') component so the markup lands in the SSR HTML — Google and every
// AI crawler require structured data to be present in the server response, not
// injected after hydration.
//
// serializeJsonLd escapes `<` to < so a `</script>` sequence in any
// string field can't break out of the script element (the standard JSON-LD
// XSS guard). All our inputs are our own data, but the escape is free and
// keeps this safe if a user-controlled name/description ever flows through.
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  )
}
