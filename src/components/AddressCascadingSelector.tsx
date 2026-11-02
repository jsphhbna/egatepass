import { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  fetchPsgcRegions,
  fetchPsgcProvinces,
  fetchPsgcCities,
  fetchPsgcBarangays,
  resolvePostalCode,
  type PsgcLocation,
  type PostalResolution,
} from '@/lib/psgc';
import { MapPin, Search, ChevronRight, X, ArrowLeft, Check, AlertCircle } from 'lucide-react';

export interface SelectedPsgcAddress {
  version: string;
  region: { code: string; name: string };
  province: { code: string; name: string } | null;
  city: { code: string; name: string };
  barangay: { code: string; name: string };
  postalCode: string | null;
  postalCodeSource: string | null;
  postalResolution?: PostalResolution;
}

export interface AddressCascadingSelectorProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (address: SelectedPsgcAddress) => void;
  initialAddress?: SelectedPsgcAddress | null;
}

type Step = 'region' | 'province' | 'city' | 'barangay' | 'confirm';

export function AddressCascadingSelector({
  isOpen,
  onClose,
  onSelect,
  initialAddress,
}: AddressCascadingSelectorProps) {
  const [currentStep, setCurrentStep] = useState<Step>('region');
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(false);

  // Selections
  const [selectedRegion, setSelectedRegion] = useState<PsgcLocation | null>(null);
  const [selectedProvince, setSelectedProvince] = useState<PsgcLocation | null>(null);
  const [selectedCity, setSelectedCity] = useState<PsgcLocation | null>(null);
  const [selectedBarangay, setSelectedBarangay] = useState<PsgcLocation | null>(null);
  const [postalResolution, setPostalResolution] = useState<PostalResolution | null>(null);

  // Available options per step
  const [regions, setRegions] = useState<PsgcLocation[]>([]);
  const [provinces, setProvinces] = useState<PsgcLocation[]>([]);
  const [cities, setCities] = useState<PsgcLocation[]>([]);
  const [barangays, setBarangays] = useState<PsgcLocation[]>([]);

  const searchInputRef = useRef<HTMLInputElement>(null);

  // Initialize or reset when modal opens
  useEffect(() => {
    if (isOpen) {
      if (initialAddress) {
        setSelectedRegion({
          code: initialAddress.region.code,
          parentCode: null,
          name: initialAddress.region.name,
          level: 'region',
          hasProvinces: initialAddress.region.code !== '1300000000',
        });
        setSelectedProvince(
          initialAddress.province
            ? {
                code: initialAddress.province.code,
                parentCode: initialAddress.region.code,
                name: initialAddress.province.name,
                level: 'province',
              }
            : null
        );
        setSelectedCity({
          code: initialAddress.city.code,
          parentCode: initialAddress.province?.code || initialAddress.region.code,
          name: initialAddress.city.name,
          level: 'city',
        });
        setSelectedBarangay({
          code: initialAddress.barangay.code,
          parentCode: initialAddress.city.code,
          name: initialAddress.barangay.name,
          level: 'barangay',
        });
        setCurrentStep('confirm');
      } else {
        resetToRegion();
      }
      loadRegions();
    }
  }, [isOpen]);

  // Focus search input when step changes
  useEffect(() => {
    if (isOpen && currentStep !== 'confirm') {
      setSearchTerm('');
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
    }
  }, [currentStep, isOpen]);

  // Handle Escape key
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  async function loadRegions() {
    setLoading(true);
    try {
      const data = await fetchPsgcRegions();
      setRegions(data);
    } finally {
      setLoading(false);
    }
  }

  function resetToRegion() {
    setSelectedRegion(null);
    setSelectedProvince(null);
    setSelectedCity(null);
    setSelectedBarangay(null);
    setPostalResolution(null);
    setProvinces([]);
    setCities([]);
    setBarangays([]);
    setCurrentStep('region');
  }

  async function handleSelectRegion(region: PsgcLocation) {
    setSelectedRegion(region);
    setSelectedProvince(null);
    setSelectedCity(null);
    setSelectedBarangay(null);
    setPostalResolution(null);

    // NCR check: NCR has NO provinces
    if (region.code === '1300000000' || !region.hasProvinces) {
      setLoading(true);
      try {
        const cityList = await fetchPsgcCities(region.code);
        setCities(cityList);
        setCurrentStep('city');
      } finally {
        setLoading(false);
      }
    } else {
      setLoading(true);
      try {
        const provList = await fetchPsgcProvinces(region.code);
        setProvinces(provList);
        setCurrentStep('province');
      } finally {
        setLoading(false);
      }
    }
  }

  async function handleSelectProvince(province: PsgcLocation) {
    setSelectedProvince(province);
    setSelectedCity(null);
    setSelectedBarangay(null);
    setPostalResolution(null);

    setLoading(true);
    try {
      const cityList = await fetchPsgcCities(province.code);
      setCities(cityList);
      setCurrentStep('city');
    } finally {
      setLoading(false);
    }
  }

  async function handleSelectCity(city: PsgcLocation) {
    setSelectedCity(city);
    setSelectedBarangay(null);
    setPostalResolution(null);

    setLoading(true);
    try {
      const bgyList = await fetchPsgcBarangays(city.code);
      setBarangays(bgyList);
      setCurrentStep('barangay');
    } finally {
      setLoading(false);
    }
  }

  async function handleSelectBarangay(bgy: PsgcLocation) {
    setSelectedBarangay(bgy);
    setLoading(true);
    try {
      if (selectedCity) {
        const resolution = await resolvePostalCode(selectedCity.code, bgy.code);
        setPostalResolution(resolution);
      }
      setCurrentStep('confirm');
    } finally {
      setLoading(false);
    }
  }

  function handleBreadcrumbClick(step: Step) {
    if (step === 'region') {
      setCurrentStep('region');
    } else if (step === 'province' && selectedRegion?.hasProvinces) {
      setCurrentStep('province');
    } else if (step === 'city' && selectedRegion) {
      setCurrentStep('city');
    } else if (step === 'barangay' && selectedCity) {
      setCurrentStep('barangay');
    }
  }

  function handleBack() {
    if (currentStep === 'confirm') {
      setCurrentStep('barangay');
    } else if (currentStep === 'barangay') {
      setCurrentStep('city');
    } else if (currentStep === 'city') {
      if (selectedRegion?.hasProvinces && selectedProvince) {
        setCurrentStep('province');
      } else {
        setCurrentStep('region');
      }
    } else if (currentStep === 'province') {
      setCurrentStep('region');
    }
  }

  function handleConfirm() {
    if (!selectedRegion || !selectedCity || !selectedBarangay) return;

    onSelect({
      version: '2026-q3',
      region: { code: selectedRegion.code, name: selectedRegion.name },
      province: selectedProvince ? { code: selectedProvince.code, name: selectedProvince.name } : null,
      city: { code: selectedCity.code, name: selectedCity.name },
      barangay: { code: selectedBarangay.code, name: selectedBarangay.name },
      postalCode: postalResolution?.postalCode || null,
      postalCodeSource: postalResolution?.isAutoFilled ? 'PHLPost' : null,
      postalResolution: postalResolution || undefined,
    });
    onClose();
  }

  // Filter current list by search query
  const filteredItems = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    let sourceList: PsgcLocation[] = [];

    if (currentStep === 'region') sourceList = regions;
    else if (currentStep === 'province') sourceList = provinces;
    else if (currentStep === 'city') sourceList = cities;
    else if (currentStep === 'barangay') sourceList = barangays;

    if (!term) return sourceList;
    return sourceList.filter((item) => item.name.toLowerCase().includes(term));
  }, [currentStep, searchTerm, regions, provinces, cities, barangays]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/60 backdrop-blur-sm transition-opacity"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cascading-address-title"
    >
      <div
        className="w-full sm:max-w-lg bg-[var(--color-surface,#18181b)] border border-[var(--color-border,#27272a)] rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[85vh] sm:max-h-[640px] overflow-hidden text-[var(--color-text-primary,#f4f4f5)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border,#27272a)] bg-[var(--color-surface-subtle,#202024)]">
          <div className="flex items-center space-x-2.5">
            {currentStep !== 'region' && (
              <button
                type="button"
                onClick={handleBack}
                className="p-1 -ml-1 text-[var(--color-text-secondary,#a1a1aa)] hover:text-white rounded-lg transition-colors"
                aria-label="Go back"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
            )}
            <MapPin className="w-5 h-5 text-amber-400" />
            <h3 id="cascading-address-title" className="text-base font-semibold text-white">
              {currentStep === 'region' && 'Select Region'}
              {currentStep === 'province' && 'Select Province'}
              {currentStep === 'city' && 'Select City / Municipality'}
              {currentStep === 'barangay' && 'Select Barangay'}
              {currentStep === 'confirm' && 'Confirm Residential Address'}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-[var(--color-text-secondary,#a1a1aa)] hover:text-white rounded-lg transition-colors"
            aria-label="Close dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Step Breadcrumbs */}
        <div className="flex items-center space-x-1.5 px-5 py-2.5 text-xs bg-[var(--color-surface,#18181b)] border-b border-[var(--color-border,#27272a)] overflow-x-auto whitespace-nowrap scrollbar-none">
          <button
            type="button"
            onClick={() => handleBreadcrumbClick('region')}
            className={`transition-colors ${
              currentStep === 'region'
                ? 'font-bold text-amber-400'
                : selectedRegion
                ? 'text-[var(--color-text-primary,#f4f4f5)] hover:underline'
                : 'text-[var(--color-text-muted,#71717a)]'
            }`}
          >
            {selectedRegion ? selectedRegion.name.replace(/\s*\(.*\)/, '') : 'Region'}
          </button>

          {selectedRegion?.hasProvinces && (
            <>
              <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-muted,#71717a)] flex-shrink-0" />
              <button
                type="button"
                onClick={() => handleBreadcrumbClick('province')}
                disabled={!selectedRegion}
                className={`transition-colors ${
                  currentStep === 'province'
                    ? 'font-bold text-amber-400'
                    : selectedProvince
                    ? 'text-[var(--color-text-primary,#f4f4f5)] hover:underline'
                    : 'text-[var(--color-text-muted,#71717a)]'
                }`}
              >
                {selectedProvince ? selectedProvince.name : 'Province'}
              </button>
            </>
          )}

          {(selectedProvince || (selectedRegion && !selectedRegion.hasProvinces)) && (
            <>
              <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-muted,#71717a)] flex-shrink-0" />
              <button
                type="button"
                onClick={() => handleBreadcrumbClick('city')}
                disabled={!selectedCity && currentStep !== 'city'}
                className={`transition-colors ${
                  currentStep === 'city'
                    ? 'font-bold text-amber-400'
                    : selectedCity
                    ? 'text-[var(--color-text-primary,#f4f4f5)] hover:underline'
                    : 'text-[var(--color-text-muted,#71717a)]'
                }`}
              >
                {selectedCity ? selectedCity.name : 'City'}
              </button>
            </>
          )}

          {selectedCity && (
            <>
              <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-muted,#71717a)] flex-shrink-0" />
              <button
                type="button"
                onClick={() => handleBreadcrumbClick('barangay')}
                disabled={!selectedBarangay && currentStep !== 'barangay'}
                className={`transition-colors ${
                  currentStep === 'barangay'
                    ? 'font-bold text-amber-400'
                    : selectedBarangay
                    ? 'text-[var(--color-text-primary,#f4f4f5)] hover:underline'
                    : 'text-[var(--color-text-muted,#71717a)]'
                }`}
              >
                {selectedBarangay ? selectedBarangay.name.slice(0, 18) : 'Barangay'}
              </button>
            </>
          )}
        </div>

        {/* Content Body */}
        {currentStep !== 'confirm' ? (
          <div className="flex flex-col flex-1 min-h-0">
            {/* Search Input Bar */}
            <div className="p-3.5 border-b border-[var(--color-border,#27272a)]">
              <div className="relative flex items-center">
                <Search className="w-4 h-4 text-[var(--color-text-muted,#71717a)] absolute left-3.5 pointer-events-none" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder={`Search ${currentStep}...`}
                  className="w-full pl-9 pr-9 py-2.5 bg-[var(--color-surface-subtle,#202024)] border border-[var(--color-border,#27272a)] rounded-xl text-sm text-white placeholder-[var(--color-text-muted,#71717a)] focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500 transition-all"
                />
                {searchTerm && (
                  <button
                    type="button"
                    onClick={() => setSearchTerm('')}
                    className="absolute right-3 p-0.5 text-[var(--color-text-muted,#71717a)] hover:text-white"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>

            {/* Scrollable Location List */}
            <div className="flex-1 overflow-y-auto divide-y divide-[var(--color-border,#27272a)]/40 px-2 py-1">
              {loading ? (
                <div className="py-12 flex flex-col items-center justify-center text-center text-[var(--color-text-secondary,#a1a1aa)]">
                  <div className="w-6 h-6 border-2 border-amber-500 border-t-transparent rounded-full animate-spin mb-3" />
                  <p className="text-sm">Loading official geographic records...</p>
                </div>
              ) : filteredItems.length === 0 ? (
                <div className="py-12 flex flex-col items-center justify-center text-center px-4">
                  <AlertCircle className="w-8 h-8 text-[var(--color-text-muted,#71717a)] mb-2.5" />
                  <p className="text-sm font-medium text-white">No locations found</p>
                  <p className="text-xs text-[var(--color-text-secondary,#a1a1aa)] mt-1">
                    No results match &ldquo;{searchTerm}&rdquo;
                  </p>
                </div>
              ) : (
                filteredItems.map((item) => (
                  <button
                    key={item.code}
                    type="button"
                    onClick={() => {
                      if (currentStep === 'region') handleSelectRegion(item);
                      else if (currentStep === 'province') handleSelectProvince(item);
                      else if (currentStep === 'city') handleSelectCity(item);
                      else if (currentStep === 'barangay') handleSelectBarangay(item);
                    }}
                    className="w-full text-left px-3.5 py-3 hover:bg-amber-500/10 active:bg-amber-500/20 rounded-xl flex items-center justify-between group transition-colors"
                  >
                    <span className="text-sm text-[var(--color-text-primary,#f4f4f5)] group-hover:text-amber-400 font-medium">
                      {item.name}
                    </span>
                    <ChevronRight className="w-4 h-4 text-[var(--color-text-muted,#71717a)] group-hover:text-amber-400 transition-colors" />
                  </button>
                ))
              )}
            </div>
          </div>
        ) : (
          /* Confirmation Step View */
          <div className="flex-1 overflow-y-auto p-5 flex flex-col justify-between">
            <div className="space-y-4">
              <div className="p-4 bg-[var(--color-surface-subtle,#202024)] border border-[var(--color-border,#27272a)] rounded-xl space-y-3">
                <div>
                  <span className="text-xs text-[var(--color-text-secondary,#a1a1aa)] uppercase tracking-wider font-semibold">
                    Region
                  </span>
                  <p className="text-sm font-medium text-white mt-0.5">{selectedRegion?.name}</p>
                </div>

                {selectedProvince && (
                  <div>
                    <span className="text-xs text-[var(--color-text-secondary,#a1a1aa)] uppercase tracking-wider font-semibold">
                      Province
                    </span>
                    <p className="text-sm font-medium text-white mt-0.5">{selectedProvince.name}</p>
                  </div>
                )}

                <div>
                  <span className="text-xs text-[var(--color-text-secondary,#a1a1aa)] uppercase tracking-wider font-semibold">
                    City / Municipality
                  </span>
                  <p className="text-sm font-medium text-white mt-0.5">{selectedCity?.name}</p>
                </div>

                <div>
                  <span className="text-xs text-[var(--color-text-secondary,#a1a1aa)] uppercase tracking-wider font-semibold">
                    Barangay
                  </span>
                  <p className="text-sm font-medium text-white mt-0.5">{selectedBarangay?.name}</p>
                </div>

                <div className="pt-2 border-t border-[var(--color-border,#27272a)] flex items-center justify-between">
                  <div>
                    <span className="text-xs text-[var(--color-text-secondary,#a1a1aa)] uppercase tracking-wider font-semibold">
                      Postal Code
                    </span>
                    <p className="text-sm font-bold text-amber-400 mt-0.5">
                      {postalResolution?.postalCode ? postalResolution.postalCode : 'Manual Entry'}
                    </p>
                  </div>
                  {postalResolution?.isAutoFilled && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                      PHLPost Verified
                    </span>
                  )}
                </div>
              </div>

              {postalResolution?.message && (
                <div className="flex items-start space-x-2.5 p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs text-amber-300">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-400" />
                  <p>{postalResolution.message}</p>
                </div>
              )}

              <p className="text-xs text-[var(--color-text-secondary,#a1a1aa)] leading-relaxed">
                Standardized administrative locality selected via PSA PSGC reference data. House/building
                number and street will be entered on the main form.
              </p>
            </div>

            <div className="pt-5 flex items-center space-x-3">
              <button
                type="button"
                onClick={() => setCurrentStep('barangay')}
                className="w-1/3 py-2.5 px-4 bg-[var(--color-surface-subtle,#202024)] hover:bg-[var(--color-border,#27272a)] border border-[var(--color-border,#27272a)] text-sm font-medium text-white rounded-xl transition-colors"
              >
                Change
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                className="w-2/3 py-2.5 px-4 bg-amber-500 hover:bg-amber-400 text-slate-950 text-sm font-bold rounded-xl shadow-lg shadow-amber-500/20 flex items-center justify-center space-x-2 transition-all active:scale-[0.98]"
              >
                <Check className="w-4 h-4" />
                <span>Confirm Address</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
