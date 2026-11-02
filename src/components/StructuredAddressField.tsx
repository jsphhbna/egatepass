import { useState, type ChangeEvent } from 'react';
import {
  AddressCascadingSelector,
  type SelectedPsgcAddress,
} from './AddressCascadingSelector';
import { MapPin, ChevronRight, CheckCircle2, AlertCircle } from 'lucide-react';
import { FormField, Input } from '@/components/ui';

export interface StructuredAddressFieldProps {
  value: SelectedPsgcAddress | null;
  onChange: (addr: SelectedPsgcAddress | null) => void;
  houseBuilding: string;
  onHouseBuildingChange: (val: string) => void;
  street: string;
  onStreetChange: (val: string) => void;
  postalCode: string;
  onPostalCodeChange: (val: string) => void;
  error?: string;
  disabled?: boolean;
}

export function StructuredAddressField({
  value,
  onChange,
  houseBuilding,
  onHouseBuildingChange,
  street,
  onStreetChange,
  postalCode,
  onPostalCodeChange,
  error,
  disabled = false,
}: StructuredAddressFieldProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);

  function handleAddressSelected(selected: SelectedPsgcAddress) {
    onChange(selected);
    if (selected.postalCode && (!postalCode || selected.postalResolution?.isAutoFilled)) {
      onPostalCodeChange(selected.postalCode);
    }
  }

  return (
    <div className="space-y-4">
      {/* 1. Compact Locality Selector */}
      <div>
        <label className="block text-sm font-semibold text-[var(--color-text-primary,#f4f4f5)] mb-1.5">
          Residential Locality <span className="text-red-400">*</span>
        </label>

        {value ? (
          <div className="p-3.5 bg-[var(--color-surface,#18181b)] border border-amber-500/40 rounded-xl flex items-center justify-between shadow-sm">
            <div className="flex items-start space-x-3 min-w-0 pr-2">
              <MapPin className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-sm font-bold text-white truncate">
                  {value.barangay.name}, {value.city.name}
                </p>
                <p className="text-xs text-[var(--color-text-secondary,#a1a1aa)] truncate mt-0.5">
                  {value.province ? `${value.province.name}, ` : ''}{value.region.name}
                </p>
              </div>
            </div>
            <button
              type="button"
              disabled={disabled}
              onClick={() => setIsModalOpen(true)}
              className="px-3 py-1.5 text-xs font-bold bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded-lg transition-colors flex-shrink-0"
            >
              Change
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setIsModalOpen(true)}
            className={`w-full p-3.5 bg-[var(--color-surface-subtle,#202024)] hover:bg-[var(--color-surface,#18181b)] border ${
              error ? 'border-red-500' : 'border-[var(--color-border,#27272a)]'
            } border-dashed rounded-xl flex items-center justify-between text-left text-sm text-[var(--color-text-secondary,#a1a1aa)] hover:text-white transition-all group`}
          >
            <div className="flex items-center space-x-2.5">
              <MapPin className="w-4 h-4 text-amber-400 group-hover:scale-110 transition-transform" />
              <span className="font-medium">Select your barangay and city</span>
            </div>
            <ChevronRight className="w-4 h-4 text-[var(--color-text-muted,#71717a)] group-hover:text-amber-400 transition-colors" />
          </button>
        )}

        {error && <p className="text-xs text-red-400 mt-1.5">{error}</p>}
      </div>

      {/* 2. House / Building & Street Details (Compact 2-col or stacked) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
        <FormField label="House / Unit / Building No." requirement="optional">
          <Input
            type="text"
            value={houseBuilding}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onHouseBuildingChange(e.target.value)}
            placeholder="e.g. Unit 4B, Bldg 2"
            disabled={disabled}
            maxLength={100}
          />
        </FormField>

        <FormField label="Street / Subdivision / Purok" requirement="optional">
          <Input
            type="text"
            value={street}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onStreetChange(e.target.value)}
            placeholder="e.g. Nagtahan St."
            disabled={disabled}
            maxLength={150}
          />
        </FormField>
      </div>

      {/* 3. Postal Code with Auto-fill Indicator */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-sm font-semibold text-[var(--color-text-primary,#f4f4f5)]">
            Postal Code
          </label>
          {value?.postalResolution?.isAutoFilled && (
            <span className="inline-flex items-center space-x-1 text-[11px] text-emerald-400 font-medium">
              <CheckCircle2 className="w-3 h-3" />
              <span>PHLPost Auto-filled</span>
            </span>
          )}
          {value?.postalResolution?.requiresConfirmation && (
            <span className="inline-flex items-center space-x-1 text-[11px] text-amber-400 font-medium">
              <AlertCircle className="w-3 h-3" />
              <span>Please confirm</span>
            </span>
          )}
        </div>
        <Input
          type="text"
          value={postalCode}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onPostalCodeChange(e.target.value.replace(/\D/g, '').slice(0, 4))}
          placeholder="4-digit postal code (e.g. 1008)"
          disabled={disabled}
          maxLength={4}
        />
        {value?.postalResolution?.message && (
          <p className="text-[11px] text-[var(--color-text-secondary,#a1a1aa)] mt-1">
            {value.postalResolution.message}
          </p>
        )}
      </div>

      {/* Cascading Address Selector Modal */}
      <AddressCascadingSelector
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSelect={handleAddressSelected}
        initialAddress={value}
      />
    </div>
  );
}
