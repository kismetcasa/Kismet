// Default render for the @modal parallel slot. Returns null because
// the slot only has content when an intercepting route is active
// (a moment URL navigated to from inside the app). Without this
// default, Next.js would 404 the modal slot on any route that
// doesn't match an intercepted path.
export default function Default() {
  return null
}
