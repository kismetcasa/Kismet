'use client'

import { useLayoutEffect, useRef, useState, type RefObject, type PointerEvent } from 'react'

// Long-press window before a touch becomes a drag. 250ms matches the
// iOS Home-Screen / common reorder-UI feel — long enough that a
// deliberate hold registers as "I'm reorganizing", short enough that
// it doesn't feel laggy.
const LONG_PRESS_MS = 250
// Pre-commit movement in either axis that abandons the long-press —
// the user is panning, not reordering. Hands the gesture back to the
// browser when the surface's touch-action allows native scroll.
const SCROLL_INTENT_PX = 8
// Mouse skips the long-press entirely and picks up after this much
// pointer movement. Matches the immediacy of HTML5 native drag.
const MOUSE_DRAG_THRESHOLD_PX = 5

type Axis = 'x' | 'y'

interface DragState<TId> {
  pointerId: number
  startId: TId
  startX: number
  startY: number
  // Last coord on the active axis; re-set after each swap so the
  // visual offset stays small relative to the dragged item's new slot.
  anchor: number
  longPressTimer: number | null
  phase: 'pending' | 'dragging'
}

export interface UseLongPressDragOptions<TId> {
  /** 'x' for horizontal reorder (tab/filter rows), 'y' for vertical (sections). */
  axis: Axis
  /** Current order of REORDERABLE items only — pinned items (e.g. `curate`
   *  or the 'all' filter) must be excluded by the caller. */
  order: readonly TId[]
  onReorder: (next: TId[]) => void
  /** Fired when the pointer down/up resolves as a tap (no drag committed). */
  onTap: (id: TId) => void
  /** Container holding the draggable items. The hook reads its
   *  children's bounding rects via querySelectorAll to find drop targets. */
  containerRef: RefObject<HTMLElement | null>
  /** CSS selector matching the draggable items inside `containerRef`.
   *  Must exclude pinned items so they don't appear as swap targets,
   *  e.g. `[data-section]:not([data-section="curate"])`. */
  itemSelector: string
}

export interface UseLongPressDragResult<TId> {
  /** The currently-lifted item, or null. */
  draggingId: TId | null
  /** Translate offset on the active axis; 0 when not dragging. */
  dragOffset: number
  /** Returns the pointer handlers to spread on each draggable element. */
  bindItem: (id: TId) => {
    onPointerDown: (e: PointerEvent) => void
    onPointerMove: (e: PointerEvent) => void
    onPointerUp: (e: PointerEvent) => void
    onPointerCancel: (e: PointerEvent) => void
  }
}

/**
 * Shared touch-and-mouse drag-to-reorder behavior, used by the discover
 * tab bar, profile section headers, and notification filter chips.
 * Long-press on touch (250ms) or small pointer-movement on mouse (5px)
 * commits to a drag; midpoint crossings on sibling items trigger an
 * in-place reorder via `onReorder`.
 *
 * The HTML5 `draggable` API was avoided because it hijacks tap-and-hold
 * on touch and breaks tap handlers — every surface that used it lost
 * its mobile click path.
 */
export function useLongPressDrag<TId>({
  axis,
  order,
  onReorder,
  onTap,
  containerRef,
  itemSelector,
}: UseLongPressDragOptions<TId>): UseLongPressDragResult<TId> {
  // High-frequency pointer data lives in a ref so move handlers don't
  // thrash React renders; visible state is just the lifted id + offset.
  const dragRef = useRef<DragState<TId> | null>(null)
  const orderRef = useRef(order)
  orderRef.current = order
  const [draggingId, setDraggingId] = useState<TId | null>(null)
  const [dragOffset, setDragOffset] = useState(0)
  // FLIP buffer: rects captured immediately before a swap so the
  // post-render useLayoutEffect can animate neighbors from their old
  // positions to their new ones instead of snapping. Only the FIRST
  // pre-swap capture per render is kept (if pointermove fires multiple
  // swaps before React re-renders, intermediate states aren't visually
  // shown anyway — we want the animation from what the user actually
  // saw last to what they see now).
  const flipRectsRef = useRef<Map<TId, DOMRect> | null>(null)

  const coordOf = (e: { clientX: number; clientY: number }) =>
    axis === 'x' ? e.clientX : e.clientY
  const centerOf = (rect: DOMRect) =>
    axis === 'x' ? rect.left + rect.width / 2 : rect.top + rect.height / 2

  function commitDrag() {
    const state = dragRef.current
    if (!state) return
    state.phase = 'dragging'
    setDraggingId(state.startId)
    // Best-effort haptic — Android Chrome/Firefox vibrate; iOS Safari
    // (and the Farcaster Mini App webview) is a no-op.
    if ('vibrate' in navigator) {
      try { navigator.vibrate(10) } catch {}
    }
  }

  function teardown(tapped: boolean) {
    const state = dragRef.current
    if (!state) return
    if (state.longPressTimer) clearTimeout(state.longPressTimer)
    if (tapped && state.phase === 'pending') onTap(state.startId)
    setDraggingId(null)
    setDragOffset(0)
    dragRef.current = null
  }

  function onPointerDown(e: PointerEvent, id: TId) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    // Capture so move/up keep firing on the originating element even
    // if the pointer drifts off its bounding box mid-drag.
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    dragRef.current = {
      pointerId: e.pointerId,
      startId: id,
      startX: e.clientX,
      startY: e.clientY,
      anchor: coordOf(e),
      longPressTimer: e.pointerType === 'touch'
        ? window.setTimeout(commitDrag, LONG_PRESS_MS)
        : null,
      phase: 'pending',
    }
  }

  function onPointerMove(e: PointerEvent) {
    const state = dragRef.current
    if (!state || e.pointerId !== state.pointerId) return

    if (state.phase === 'pending') {
      const dx = e.clientX - state.startX
      const dy = e.clientY - state.startY
      if (e.pointerType === 'touch') {
        if (Math.abs(dx) > SCROLL_INTENT_PX || Math.abs(dy) > SCROLL_INTENT_PX) {
          if (state.longPressTimer) clearTimeout(state.longPressTimer)
          dragRef.current = null
        }
        return
      }
      if (Math.abs(dx) < MOUSE_DRAG_THRESHOLD_PX && Math.abs(dy) < MOUSE_DRAG_THRESHOLD_PX) return
      commitDrag()
    }

    if (state.phase !== 'dragging') return
    e.preventDefault()
    const coord = coordOf(e)
    setDragOffset(coord - state.anchor)

    // Midpoint crossing on a sibling = swap. Pinned items must be
    // excluded by `itemSelector` so we can't push a draggable past one.
    const container = containerRef.current
    if (!container) return
    const els = Array.from(container.querySelectorAll<HTMLElement>(itemSelector))
    const currentOrder = orderRef.current
    const currentIdx = currentOrder.indexOf(state.startId)
    if (currentIdx < 0) return
    let targetIdx = currentIdx
    for (let i = 0; i < els.length; i++) {
      if (coord < centerOf(els[i].getBoundingClientRect())) { targetIdx = i; break }
      targetIdx = i
    }
    if (targetIdx !== currentIdx) {
      // Capture pre-swap rects so the post-render FLIP knows where
      // each item used to be. First-write-wins: if multiple swaps
      // batch into one render, we keep the rects from the FIRST
      // (= last user-visible state), not the most recent in-memory
      // one. Map keys are item ids resolved via the DOM order, which
      // matches `currentOrder` because callers render via order.map.
      if (!flipRectsRef.current) {
        const pre = new Map<TId, DOMRect>()
        els.forEach((el, i) => {
          const id = currentOrder[i]
          if (id !== undefined) pre.set(id, el.getBoundingClientRect())
        })
        flipRectsRef.current = pre
      }
      const next = [...currentOrder]
      const [moved] = next.splice(currentIdx, 1)
      next.splice(targetIdx, 0, moved)
      onReorder(next)
      // Re-anchor so subsequent translate stays small relative to the
      // new slot — without this the lifted element races ahead of the
      // finger after one swap.
      state.anchor = coord
      setDragOffset(0)
    }
  }

  function onPointerUp(e: PointerEvent) {
    if (!dragRef.current || e.pointerId !== dragRef.current.pointerId) return
    teardown(/* tapped */ true)
  }

  function onPointerCancel(e: PointerEvent) {
    if (!dragRef.current || e.pointerId !== dragRef.current.pointerId) return
    teardown(/* tapped */ false)
  }

  function bindItem(id: TId) {
    return {
      onPointerDown: (e: PointerEvent) => onPointerDown(e, id),
      onPointerMove,
      onPointerUp,
      onPointerCancel,
    }
  }

  // FLIP — when `order` changes mid-drag, neighbors snap to their new
  // slot positions. Without this hook, that snap is visually jarring;
  // with it, each displaced item appears (briefly) at its old position
  // and animates to the new one. The dragged item itself is excluded
  // because its translate is managed by the move handler above.
  useLayoutEffect(() => {
    const oldRects = flipRectsRef.current
    if (!oldRects) return
    flipRectsRef.current = null
    const container = containerRef.current
    if (!container) return
    const els = Array.from(container.querySelectorAll<HTMLElement>(itemSelector))
    const newOrder = orderRef.current
    const liftedId = dragRef.current?.startId ?? null
    els.forEach((el, i) => {
      const id = newOrder[i]
      if (id === undefined) return
      // Skip the lifted item — its style.transform is owned by the
      // drag handler. Letting FLIP touch it fights the React render
      // and produces a one-frame glitch as the finger keeps moving.
      if (id === liftedId) return
      const oldRect = oldRects.get(id)
      if (!oldRect) return
      const newRect = el.getBoundingClientRect()
      const dx = oldRect.left - newRect.left
      const dy = oldRect.top - newRect.top
      // Sub-pixel deltas aren't worth a transition — they tend to come
      // from font-rendering jitter, not actual position changes.
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
      // Apply the inverse offset first (item appears in old position),
      // commit that to layout, then transition transform back to 0.
      el.style.transition = 'none'
      el.style.transform = `translate(${dx}px, ${dy}px)`
      requestAnimationFrame(() => {
        el.style.transition = 'transform 200ms cubic-bezier(0.2, 0, 0, 1)'
        el.style.transform = ''
      })
    })
  }, [order, containerRef, itemSelector])

  return { draggingId, dragOffset, bindItem }
}
