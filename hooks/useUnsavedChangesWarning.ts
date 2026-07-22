'use client'

import { useEffect, useRef } from 'react'

// Native leave-site prompt on real page unloads (reload / tab close) while a
// form holds unsaved input. In-app tab switches never fire this — those are
// covered by keeping the /mint panels mounted (see MintTabs). Callers MUST
// pass dirty=false while an operation is in flight: mid-mint / mid-deploy
// reloads are a SUPPORTED recovery path (lib/arweave/uploadPersistence, the
// pending-deploy resume) and the stuck-tx toast literally instructs a refresh
// — a prompt there would fight that. Multiple instances compose natively: any
// one preventing default shows the prompt. Reads through a ref so the
// listener registers once per mount instead of on every keystroke.
export function useUnsavedChangesWarning(dirty: boolean) {
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty

  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!dirtyRef.current) return
      e.preventDefault()
      // Legacy Chrome requires returnValue to be set for the prompt to show.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])
}
