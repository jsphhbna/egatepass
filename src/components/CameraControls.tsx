import React from 'react';
import { Camera, FlipHorizontal, Focus } from 'lucide-react';

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
    activeFacingMode === 'user' ? 'Switch to back camera' : 'Switch to front camera';
  const mirrorActionLabel = mirrorPreview
    ? 'Disable preview mirror'
    : 'Enable preview mirror';

  return (
    <div
      className={`absolute top-3 right-3 z-30 flex items-center gap-1.5 bg-black/60 backdrop-blur-xs p-1.5 rounded-xl border border-white/10 text-white shadow-md ${className}`.trim()}
      role="region"
      aria-label="Camera controls"
    >
      {onRefocus && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRefocus();
          }}
          disabled={disabled}
          title="Refocus camera"
          aria-label="Refocus camera"
          className="p-1.5 rounded-lg text-white/70 hover:bg-white/20 hover:text-white transition-colors cursor-pointer"
        >
          <Focus className="h-4 w-4" aria-hidden="true" />
        </button>
      )}

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleMirror();
        }}
        disabled={disabled}
        title={mirrorLabel || (mirrorPreview ? 'Disable preview mirror' : 'Enable preview mirror')}
        aria-label={mirrorActionLabel}
        className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
          mirrorPreview ? 'bg-white/20 text-white' : 'text-white/70 hover:bg-white/20 hover:text-white'
        }`}
      >
        <FlipHorizontal className="h-4 w-4" aria-hidden="true" />
      </button>

      {canSwitchCamera && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSwitchCamera();
          }}
          disabled={disabled}
          title={switchTargetLabel}
          aria-label={switchTargetLabel}
          className="p-1.5 rounded-lg text-white/80 hover:bg-white/20 hover:text-white transition-colors flex items-center gap-1 text-[11px] font-semibold cursor-pointer"
        >
          <Camera className="h-4 w-4" aria-hidden="true" />
          <span>{activeFacingMode === 'user' ? 'Front' : 'Back'}</span>
        </button>
      )}
    </div>
  );
};
