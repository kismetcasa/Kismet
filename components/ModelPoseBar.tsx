'use client'

import { MODEL_BACKGROUNDS, type ModelBackgroundId } from '@/lib/media/modelMedia'

/**
 * The caption bar under a posed 3D preview — both authored decisions in one
 * place. Without the hint the poster capture is invisible: the artist has no
 * way to know the angle they leave the model at is the thumbnail every feed,
 * share card and embed will show; and the backdrop is baked into that same
 * JPEG. Shared by the mint form and the edit flow so posing a model looks and
 * behaves identically in both, and so the target size and the aria contract
 * are defined once.
 */
export function ModelPoseBar({
  value,
  onChange,
}: {
  value: ModelBackgroundId
  onChange: (id: ModelBackgroundId) => void
}) {
  return (
    <div className="absolute bottom-0 inset-x-0 px-3 py-2 bg-[#0d0d0d]/85 flex items-center justify-between gap-3">
      <p className="text-[10px] font-mono text-muted truncate">
        drag to pose — this view becomes the thumbnail
      </p>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {MODEL_BACKGROUNDS.map((bg) => (
          <button
            key={bg.id}
            type="button"
            onClick={() => onChange(bg.id)}
            aria-pressed={value === bg.id}
            // "Backdrop: white thumbnail, transparent in app" reads correctly;
            // "<label> background" would not, now that a label can be a whole
            // sentence.
            aria-label={`Backdrop: ${bg.label}`}
            title={`Backdrop: ${bg.label}`}
            // 24px hit area around a 16px swatch. The visual dot is what reads
            // in a caption bar, but a 16px target is under WCAG 2.2 SC 2.5.8's
            // 24px floor — and too close to its neighbour to earn the spacing
            // exemption. Same reason the card overlays use min-w-9.
            className="min-w-6 min-h-6 flex items-center justify-center"
          >
            <span
              aria-hidden
              className={`w-4 h-4 rounded-full border transition-colors ${
                value === bg.id ? 'border-ink' : 'border-line'
              }`}
              style={{ background: bg.swatch }}
            />
          </button>
        ))}
      </div>
    </div>
  )
}
