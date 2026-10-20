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

  return (
    <nav aria-label="Progress" className={className}>
      <ol role="list" className={`flex ${isVertical ? 'flex-col gap-4' : 'items-center justify-between w-full'}`}>
        {steps.map((step, index) => {
          const isCompleted = index < currentStepIndex;
          const isCurrent = index === currentStepIndex;
          const isUpcoming = index > currentStepIndex;

          return (
            <li key={step.id} className={`relative flex ${isVertical ? 'flex-row items-center gap-4' : 'flex-1 flex-col items-center'}`}>
              {/* Connecting Line */}
              {index !== steps.length - 1 && (
                <div
                  className={`absolute z-0 transition-colors duration-200 motion-reduce:transition-none ${
                    isCompleted ? 'bg-[var(--color-success)]' : 'bg-[var(--color-border)]'
                  } ${
                    isVertical 
                      ? 'left-4 top-8 h-[calc(100%+1rem)] w-0.5 sm:left-5 sm:top-10'
                      : 'left-1/2 top-4 h-0.5 w-full sm:top-5'
                  }`}
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
                className={`relative z-10 text-xs ${isVertical ? 'text-left' : 'mt-2 px-1 text-center sm:mt-3 sm:px-0 sm:whitespace-nowrap'}
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
