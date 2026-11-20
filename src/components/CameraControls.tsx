import React from 'react';
import { Button } from './ui/Button';
import { SwitchCamera, FlipHorizontal, Focus } from 'lucide-react';

export interface CameraControlsProps {
  activeFacingMode: 'user' | 'environment';
  mirrorPreview: boolean;
  canSwitchCamera: boolean;
  onSwitchCamera: () => void;
  onToggleMirror: () => void;
  onRefocus?: () => void;
  disabled?: boolean;
  className?: string;
  mirrorLabel?: string;
}

export const CameraControls: React.FC<CameraControlsProps> = ({
  activeFacingMode,
  mirrorPreview,
  canSwitchCamera,
  onSwitchCamera,
  onToggleMirror,
  onRefocus,
  disabled = false,
  className = '',
  mirrorLabel,
}) => {
  const switchTargetLabel =
    activeFacingMode === 'user' ? 'Switch to rear camera' : 'Switch to front camera';
  const mirrorActionLabel = mirrorPreview
    ? 'Disable mirrored preview'
    : 'Mirror preview';

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] text-xs shadow-xs transition-colors ${className}`.trim()}
      role="region"
      aria-label="Camera controls"
    >
      <div className="flex items-center gap-1.5 font-medium text-[var(--color-text-secondary)]">
        <span
          className="inline-block h-1.5 w-1.5 rounded-full bg-slate-400"
          aria-hidden="true"
        />
        <span>
          {activeFacingMode === 'user' ? 'Front camera' : 'Rear camera'}
          {mirrorPreview ? ' • Mirrored' : ''}
        </span>
      </div>

      <div className="flex items-center gap-1.5">
        {onRefocus && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onRefocus}
            disabled={disabled}
            aria-label="Refocus camera"
            className="!min-h-[36px] text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-canvas)] border border-[var(--color-border)] shadow-none"
            icon={<Focus className="h-3.5 w-3.5" aria-hidden="true" />}
          >
            <span>Focus</span>
          </Button>
        )}

        {canSwitchCamera && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onSwitchCamera}
            disabled={disabled}
            aria-label={switchTargetLabel}
            className="!min-h-[36px] text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-canvas)] border border-[var(--color-border)] shadow-none"
            icon={<SwitchCamera className="h-3.5 w-3.5" aria-hidden="true" />}
          >
            <span>{activeFacingMode === 'user' ? 'Rear' : 'Front'}</span>
          </Button>
        )}

        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onToggleMirror}
          disabled={disabled}
          aria-label={mirrorActionLabel}
          className="!min-h-[36px] text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-canvas)] border border-[var(--color-border)] shadow-none"
          icon={<FlipHorizontal className="h-3.5 w-3.5" aria-hidden="true" />}
        >
          <span>{mirrorLabel || (mirrorPreview ? 'Unmirror' : 'Mirror')}</span>
        </Button>
      </div>
    </div>
  );
};
