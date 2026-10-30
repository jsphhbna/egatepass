import { Check } from 'lucide-react';
import styles from './Stepper.module.css';

interface Step {
  id: string;
  title: string;
}

interface StepperProps {
  steps: Step[];
  currentStepIndex: number;
  className?: string;
  orientation?: 'horizontal' | 'vertical';
}

export function Stepper({ steps, currentStepIndex, className = '', orientation = 'horizontal' }: StepperProps) {
  const isVertical = orientation === 'vertical';

  if (isVertical) {
    return (
      <nav aria-label="Progress" className={className}>
        <ol role="list" className="flex flex-col gap-4">
          {steps.map((step, index) => {
            const isCompleted = index < currentStepIndex;
            const isCurrent = index === currentStepIndex;
            const isUpcoming = index > currentStepIndex;

            return (
              <li key={step.id} className="relative flex flex-row items-center gap-4">
                {index !== steps.length - 1 && (
                  <div
                    className={`absolute z-0 transition-colors duration-200 motion-reduce:transition-none ${
                      isCompleted ? 'bg-[var(--color-success)]' : 'bg-[var(--color-border)]'
                    } left-4 top-8 h-[calc(100%+1rem)] w-0.5 sm:left-5 sm:top-10`}
                    aria-hidden="true"
                  />
                )}

                <div
                  className={`relative z-10 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border-2 transition-colors duration-200 motion-reduce:transition-none sm:h-10 sm:w-10
                    ${isCompleted ? `border-[var(--color-success)] bg-[var(--color-success)] ${styles.completedStep}` : ''}
                    ${isCurrent ? 'border-[var(--color-earist-red)] bg-[var(--color-earist-red)] ring-4 ring-[var(--color-brand-light)]' : ''}
                    ${isUpcoming ? 'border-[var(--color-border-strong)] bg-white' : ''}
                  `}
                  aria-current={isCurrent ? 'step' : undefined}
                >
                  {isCompleted ? (
                    <>
                      <span className="sr-only">completed</span>
                      <Check className="h-4 w-4 sm:h-5 sm:w-5 text-white" strokeWidth={3} aria-hidden="true" />
                    </>
                  ) : (
                    <span
                      className={`text-sm sm:text-base font-semibold 
                        ${isCurrent ? 'text-white' : 'text-[var(--color-text-muted)]'}`}
                    >
                      {index + 1}
                    </span>
                  )}
                </div>

                <span
                  className={`relative z-10 text-xs text-left
                    ${isCompleted ? 'font-semibold text-[var(--color-success)]' : ''}
                    ${isCurrent ? 'text-[var(--color-earist-red)] font-bold text-sm sm:text-base' : ''}
                    ${isUpcoming ? 'font-medium text-[var(--color-text-secondary)]' : ''}
                  `}
                >
                  {step.title}
                </span>
              </li>
            );
          })}
        </ol>
      </nav>
    );
  }

  // Horizontal orientation:
  // 2-row CSS Grid track (repeat(stepCount, minmax(0, 1fr))) decoupling marker geometry from label width/wrapping
  return (
    <nav aria-label="Progress" className={className}>
      <ol
        role="list"
        className="grid w-full"
        style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
      >
        {steps.map((step, index) => {
          const isCompleted = index < currentStepIndex;
          const isCurrent = index === currentStepIndex;
          const isUpcoming = index > currentStepIndex;

          return (
            <li
              key={step.id}
              className="relative flex flex-col items-center min-w-0"
              style={{ gridColumn: index + 1 }}
            >
              {/* Row 1: Marker and connector container (fixed height ensures exact centerY across all columns) */}
              <div className="relative flex items-center justify-center w-full h-8 sm:h-10">
                {/* Connector line running between adjacent markers */}
                {index !== steps.length - 1 && (
                  <div
                    className={`absolute left-1/2 top-1/2 -translate-y-1/2 w-full h-0.5 z-0 transition-colors duration-200 motion-reduce:transition-none ${
                      isCompleted ? 'bg-[var(--color-success)]' : 'bg-[var(--color-border)]'
                    }`}
                    aria-hidden="true"
                  />
                )}

                {/* Marker Circle */}
                <div
                  className={`relative z-10 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border-2 transition-colors duration-200 motion-reduce:transition-none sm:h-10 sm:w-10
                    ${isCompleted ? `border-[var(--color-success)] bg-[var(--color-success)] ${styles.completedStep}` : ''}
                    ${isCurrent ? 'border-[var(--color-earist-red)] bg-[var(--color-earist-red)] ring-4 ring-[var(--color-brand-light)]' : ''}
                    ${isUpcoming ? 'border-[var(--color-border-strong)] bg-white' : ''}
                  `}
                  aria-current={isCurrent ? 'step' : undefined}
                >
                  {isCompleted ? (
                    <>
                      <span className="sr-only">completed</span>
                      <Check className="h-4 w-4 sm:h-5 sm:w-5 text-white" strokeWidth={3} aria-hidden="true" />
                    </>
                  ) : (
                    <span
                      className={`text-sm sm:text-base font-semibold 
                        ${isCurrent ? 'text-white' : 'text-[var(--color-text-muted)]'}`}
                    >
                      {index + 1}
                    </span>
                  )}
                </div>
              </div>

              {/* Row 2: Label (wraps naturally without affecting marker Row 1 height or centerY alignment) */}
              <div className="w-full mt-2 sm:mt-3 px-0.5 text-center">
                <span
                  className={`block text-xs sm:text-sm leading-tight break-words
                    ${isCompleted ? 'font-semibold text-[var(--color-success)]' : ''}
                    ${isCurrent ? 'text-[var(--color-earist-red)] font-bold' : ''}
                    ${isUpcoming ? 'font-medium text-[var(--color-text-secondary)]' : ''}
                  `}
                >
                  {step.title}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
