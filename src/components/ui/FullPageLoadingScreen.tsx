import type { HTMLAttributes } from 'react';
import { ProgressBar } from './ProgressBar';
import { SyncDots } from './SyncDots';

export interface BootChecklistItem {
  label: string;
  status: 'pending' | 'loading' | 'ready' | 'error';
}

export interface FullPageLoadingScreenProps extends HTMLAttributes<HTMLElement> {
  id?: string;
  title?: string;
  subtitle?: string;
  terminalName?: string;
  statusText?: string;
  version?: string;
  checklist?: BootChecklistItem[];
  className?: string;
}

export function FullPageLoadingScreen({
  id,
  title = 'EARIST E-GatePass',
  subtitle = 'Smart QR Code-Based Visitor Management System',
  terminalName,
  statusText = 'Initializing secure environment…',
  version = 'Institutional Build',
  checklist,
  className = '',
  ...props
}: FullPageLoadingScreenProps) {
  return (
    <main
      id={id}
      role="status"
      aria-live="polite"
      aria-label={`${title} - ${terminalName ? `${terminalName} - ` : ''}${statusText}`}
      className={`flex min-h-dvh flex-col items-center justify-center bg-[var(--color-canvas)] px-4 py-12 select-none ${className}`.trim()}
      {...props}
    >
      <div className="w-full max-w-md flex flex-col items-center text-center">
        {/* Institutional Branding */}
        <div className="relative mb-4 flex items-center justify-center">
          <div
            className="absolute -inset-2 rounded-full bg-[var(--color-brand)]/10 animate-pulse"
            aria-hidden="true"
          />
          <img
            src="/earist-logo.png"
            alt="EARIST seal"
            className="relative h-20 w-20 object-contain drop-shadow-sm"
          />
        </div>

        <h1 className="text-2xl font-black tracking-tight text-[var(--color-brand)]">
          {title}
        </h1>
        <p className="mt-1 text-xs font-medium text-[var(--color-text-secondary)] tracking-wide">
          {subtitle}
        </p>

        {terminalName && (
          <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-white px-3 py-1 shadow-xs">
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" aria-hidden="true" />
            <span className="text-xs font-semibold text-[var(--color-text-primary)]">
              {terminalName}
            </span>
          </div>
        )}

        {/* Progress Indication */}
        <div className="mt-8 w-full max-w-xs space-y-3">
          <ProgressBar indeterminate variant="brand" size="sm" />
          <div className="flex items-center justify-center gap-2 text-xs font-medium text-[var(--color-text-muted)]">
            <SyncDots size="xs" color="brand" />
            <span>{statusText}</span>
          </div>
        </div>

        {/* Hardware / Service Readiness Checklist (if terminal boot) */}
        {checklist && checklist.length > 0 && (
          <div className="mt-8 w-full rounded-xl border border-[var(--color-border)] bg-white p-4 text-left shadow-xs">
            <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
              System Diagnostics
            </p>
            <ul className="mt-2.5 divide-y divide-[var(--color-border)]/50 text-xs">
              {checklist.map((item, idx) => (
                <li key={idx} className="flex items-center justify-between py-2">
                  <span className="text-[var(--color-text-secondary)] font-medium">
                    {item.label}
                  </span>
                  <span className="inline-flex items-center gap-1.5 font-semibold">
                    {item.status === 'ready' && (
                      <span className="text-emerald-700">✓ Ready</span>
                    )}
                    {item.status === 'loading' && (
                      <span className="inline-flex items-center gap-1 text-[var(--color-brand)]">
                        <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-brand)] animate-ping" />
                        Checking
                      </span>
                    )}
                    {item.status === 'pending' && (
                      <span className="text-slate-400">Waiting</span>
                    )}
                    {item.status === 'error' && (
                      <span className="text-[var(--color-danger)] font-bold">Failed</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Footer Build / Institutional Seal */}
        <div className="mt-10 text-[11px] font-medium text-[var(--color-text-muted)]">
          Eulogio "Amang" Rodriguez Institute of Science and Technology • {version}
        </div>
      </div>
    </main>
  );
}

export function TerminalBootLoader({
  terminalName,
  statusText,
  checklist,
}: {
  terminalName: string;
  statusText?: string;
  checklist?: BootChecklistItem[];
}) {
  return (
    <FullPageLoadingScreen
      terminalName={terminalName}
      statusText={statusText || `Connecting ${terminalName}…`}
      checklist={checklist}
    />
  );
}
