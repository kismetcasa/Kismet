'use client'

import { Rows3, LayoutGrid } from 'lucide-react'
import type { ViewMode } from '@/hooks/useViewMode'

interface ViewModeToggleProps {
  mode: ViewMode
  onChange: (next: ViewMode) => void
}

// Two-state icon button: Rows3 reads as the current spacious vertical
// feed, LayoutGrid as the denser horizontal swiper. Click flips between
// them. Sits inline with the filter pills (mints/collections, list
// selectors, etc.) so it appears on the same line as the feed's other
// controls.
export function ViewModeToggle({ mode, onChange }: ViewModeToggleProps) {
  const next: ViewMode = mode === 'feed' ? 'grid' : 'feed'
  const Icon = mode === 'feed' ? Rows3 : LayoutGrid
  return (
    <button
      type="button"
      onClick={() => onChange(next)}
      className="flex items-center justify-center w-7 h-7 border border-line text-muted hover:border-muted hover:text-dim transition-colors"
      title={mode === 'feed' ? 'switch to grid view' : 'switch to feed view'}
      aria-label={mode === 'feed' ? 'switch to grid view' : 'switch to feed view'}
    >
      <Icon size={13} strokeWidth={1.5} />
    </button>
  )
}
