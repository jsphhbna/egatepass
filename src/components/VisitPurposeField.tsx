import { useState } from 'react';
import { FormField, Select, Textarea } from '@/components/ui';
import type { VisitPurposeOption } from '@/types';

const OTHER_PURPOSE = '__other__';

interface VisitPurposeFieldProps {
  purposes: VisitPurposeOption[];
  value: string;
  error?: string;
  onChange: (value: string) => void;
}

export function VisitPurposeField({ purposes, value, error, onChange }: VisitPurposeFieldProps) {
  const initialPurpose = purposes.find((purpose) => value === purpose.label || value.startsWith(`${purpose.label} — `));
  const [choice, setChoice] = useState(() => initialPurpose?.label || (value ? OTHER_PURPOSE : ''));
  const [details, setDetails] = useState(() => initialPurpose && value.startsWith(`${initialPurpose.label} — `)
    ? value.slice(initialPurpose.label.length + 3)
    : '');
  const selectedPurpose = purposes.find((purpose) => purpose.label === choice);
  const requiresDetails = selectedPurpose?.requiresDetails === true;
  const isCustom = choice === OTHER_PURPOSE;
  const detailsRequiredError = requiresDetails && details.trim().length < 2
    ? 'Please provide the requested details.'
    : undefined;

  function updateDetails(nextDetails: string) {
    setDetails(nextDetails);
    if (isCustom) {
      onChange(nextDetails);
      return;
    }
    if (!selectedPurpose) return;
    const cleanedDetails = nextDetails.trim();
    onChange(cleanedDetails.length >= 2 ? `${selectedPurpose.label} — ${cleanedDetails}` : '');
  }

  function handleChoiceChange(nextChoice: string) {
    setChoice(nextChoice);
    setDetails('');
    if (nextChoice === OTHER_PURPOSE || nextChoice === '') {
      onChange('');
      return;
    }
    const nextPurpose = purposes.find((purpose) => purpose.label === nextChoice);
    onChange(nextPurpose?.requiresDetails ? '' : nextChoice);
  }

  const detailsLabel = isCustom
    ? 'Please specify your purpose'
    : selectedPurpose?.detailPrompt || 'Please provide more details';
  const detailsMaxLength = selectedPurpose
    ? Math.max(2, 300 - selectedPurpose.label.length - 3)
    : 300;

  return (
    <FormField
      id="visit-purpose-choice"
      label="Purpose of Visit"
      hint={!isCustom && !requiresDetails ? 'Choose the closest reason, or select Other.' : undefined}
      error={detailsRequiredError || error}
    >
      <div className="space-y-3">
        <Select
          id="visit-purpose-choice"
          value={choice}
          onChange={(event) => handleChoiceChange(event.target.value)}
          error={Boolean(detailsRequiredError || error)}
        >
          <option value="">Select a purpose</option>
          {purposes.map((purpose) => (
            <option key={purpose.label} value={purpose.label}>{purpose.label}</option>
          ))}
          <option value={OTHER_PURPOSE}>Other — please specify</option>
        </Select>

        {(isCustom || requiresDetails) && (
          <div className="space-y-1">
            <label htmlFor="visit-purpose-details" className="block text-sm font-medium text-[var(--color-text-primary)]">
              {detailsLabel}
            </label>
            <Textarea
              id="visit-purpose-details"
              value={isCustom ? value : details}
              onChange={(event) => updateDetails(event.target.value)}
              rows={3}
              maxLength={detailsMaxLength}
              placeholder={isCustom ? 'Briefly describe your purpose of visit' : 'Enter the requested details'}
              error={Boolean(detailsRequiredError || error)}
              autoFocus
            />
          </div>
        )}
      </div>
    </FormField>
  );
}
