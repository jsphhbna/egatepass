import React from 'react';
import { Button } from './ui/Button';
import { SwitchCamera, FlipHorizontal } from 'lucide-react';

export interface CameraControlsProps {
  activeFacingMode: 'user' | 'environment';
  mirrorPreview: boolean;
  canSwitchCamera: boolean;
  onSwitchCamera: () => void;
  onToggleMirror: () => void;
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
      className={`flex flex-wrap items-center justify-between gap-2 p-2 bg-slate-900/80 backdrop-blur-sm rounded-lg text-white text-xs ${className}`.trim()}
      role="region"
      aria-label="Camera controls"
    >
      <div className="flex items-center gap-1.5 px-1 font-medium text-slate-300">
        <span
          className="inline-block h-2 w-2 rounded-full bg-emerald-400"
          aria-hidden="true"
        />
        <span>
          {activeFacingMode === 'user' ? 'Front camera' : 'Rear camera'}
          {mirrorPreview ? ' • Mirrored' : ''}
        </span>
      </div>

      <div className="flex items-center gap-2">
        {canSwitchCamera && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onSwitchCamera}
            disabled={disabled}
            aria-label={switchTargetLabel}
            className="!min-h-[44px] !min-w-[44px] text-xs font-medium"
            icon={<SwitchCamera className="h-4 w-4" aria-hidden="true" />}
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
          className="!min-h-[44px] !min-w-[44px] text-xs font-medium"
          icon={<FlipHorizontal className="h-4 w-4" aria-hidden="true" />}
        >
          <span>{mirrorLabel || (mirrorPreview ? 'Unmirror' : 'Mirror')}</span>
        </Button>
      </div>
    </div>
  );
};
