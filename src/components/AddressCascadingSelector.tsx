import { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  fetchPsgcRegions,
  fetchPsgcProvinces,
  fetchPsgcCities,
  fetchPsgcBarangays,
  type PsgcLocation,
} from '@/lib/psgc';
import { MapPin, Search, ChevronRight, X, ArrowLeft, Check, AlertCircle } from 'lucide-react';

export interface PostalResolution {
  postalCode: string;
  isAutoFilled: boolean;
  requiresConfirmation: boolean;
  mappingType: string;
  message?: string;
}

export interface SelectedPsgcAddress {
  version: string;
  region: { code: string; name: string };
  province: { code: string; name: string } | null;
  city: { code: string; name: string };
  barangay: { code: string; name: string };
  postalCode?: string | null;
  postalCodeSource?: string | null;
  postalResolution?: PostalResolution | null;
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

        // Preload hierarchy for the initial address so navigating back has proper options available
        if (initialAddress.city?.code) {
          fetchPsgcBarangays(initialAddress.city.code).then(setBarangays).catch(() => {});
        }
        if (initialAddress.province?.code) {
          fetchPsgcCities(initialAddress.province.code).then(setCities).catch(() => {});
        } else if (initialAddress.region?.code) {
          fetchPsgcCities(initialAddress.region.code).then(setCities).catch(() => {});
        }
        if (initialAddress.region?.code && initialAddress.region.code !== '1300000000') {
          fetchPsgcProvinces(initialAddress.region.code).then(setProvinces).catch(() => {});
        }
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

    setLoading(true);
    try {
      const bgyList = await fetchPsgcBarangays(city.code);
      setBarangays(bgyList);
      setCurrentStep('barangay');
    } finally {
      setLoading(false);
    }
  }

  function handleSelectBarangay(bgy: PsgcLocation) {
    setSelectedBarangay(bgy);
    setCurrentStep('confirm');
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
    });
    onClose();
  }

  // Filter current list by search query
  const filteredItems = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    let sourceList: Array<{ code: string; name: string }> = [];

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
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-xs transition-opacity"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cascading-address-title"
    >
      <div
        className="w-full sm:max-w-lg bg-[var(--color-surface,#FFFFFF)] border border-[var(--color-border,#E2E8F0)] rounded-2xl shadow-2xl flex flex-col max-h-[min(90vh,680px)] overflow-hidden text-[var(--color-text-primary,#172033)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border,#E2E8F0)] bg-[var(--color-surface-subtle,#F8FAFC)]">
          <div className="flex items-center space-x-2.5">
            {currentStep !== 'region' && (
              <button
                type="button"
                onClick={handleBack}
                className="p-1.5 -ml-1 text-[var(--color-text-secondary,#5F6B7F)] hover:text-[var(--color-text-primary,#172033)] hover:bg-slate-200/60 rounded-lg transition-colors"
                aria-label="Go back"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
            )}
            <MapPin className="w-5 h-5 text-[#7A0A0A]" />
            <h3 id="cascading-address-title" className="text-base font-bold text-[var(--color-text-primary,#172033)]">
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
            className="p-1.5 text-[var(--color-text-secondary,#5F6B7F)] hover:text-[var(--color-text-primary,#172033)] hover:bg-slate-200/60 rounded-lg transition-colors"
            aria-label="Close dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Step Breadcrumbs */}
        <div className="flex items-center space-x-1.5 px-5 py-2.5 text-xs bg-[var(--color-surface,#FFFFFF)] border-b border-[var(--color-border,#E2E8F0)] overflow-x-auto whitespace-nowrap scrollbar-none">
          <button
            type="button"
            onClick={() => handleBreadcrumbClick('region')}
            className={`transition-colors ${
              currentStep === 'region'
                ? 'font-bold text-[#7A0A0A]'
                : selectedRegion
                ? 'text-[var(--color-text-primary,#172033)] hover:text-[#7A0A0A] hover:underline font-medium'
                : 'text-[var(--color-text-muted,#687386)]'
            }`}
          >
            {selectedRegion ? selectedRegion.name.replace(/\s*\(.*\)/, '') : 'Region'}
          </button>

          {selectedRegion?.hasProvinces && (
            <>
              <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-muted,#687386)] flex-shrink-0" />
              <button
                type="button"
                onClick={() => handleBreadcrumbClick('province')}
                disabled={!selectedRegion}
                className={`transition-colors ${
                  currentStep === 'province'
                    ? 'font-bold text-[#7A0A0A]'
                    : selectedProvince
                    ? 'text-[var(--color-text-primary,#172033)] hover:text-[#7A0A0A] hover:underline font-medium'
                    : 'text-[var(--color-text-muted,#687386)]'
                }`}
              >
                {selectedProvince ? selectedProvince.name : 'Province'}
              </button>
            </>
          )}

          {/* City / Municipality */}
          {(selectedProvince || (selectedRegion && !selectedRegion.hasProvinces)) && (
            <>
              <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-muted,#687386)] flex-shrink-0" />
              <button
                type="button"
                onClick={() => handleBreadcrumbClick('city')}
                disabled={!selectedCity && currentStep !== 'city'}
                className={`transition-colors ${
                  currentStep === 'city'
                    ? 'font-bold text-[#7A0A0A]'
                    : selectedCity
                    ? 'text-[var(--color-text-primary,#172033)] hover:text-[#7A0A0A] hover:underline font-medium'
                    : 'text-[var(--color-text-muted,#687386)]'
                }`}
              >
                {selectedCity ? selectedCity.name : 'City'}
              </button>
            </>
          )}

          {/* Barangay */}
          {selectedCity && (
            <>
              <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-muted,#687386)] flex-shrink-0" />
              <button
                type="button"
                onClick={() => handleBreadcrumbClick('barangay')}
                disabled={!selectedBarangay && currentStep !== 'barangay'}
                className={`transition-colors ${
                  currentStep === 'barangay'
                    ? 'font-bold text-[#7A0A0A]'
                    : selectedBarangay
                    ? 'text-[var(--color-text-primary,#172033)] hover:text-[#7A0A0A] hover:underline font-medium'
                    : 'text-[var(--color-text-muted,#687386)]'
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
            <div className="p-3.5 border-b border-[var(--color-border,#E2E8F0)] bg-[var(--color-surface,#FFFFFF)]">
              <div className="relative flex items-center">
                <Search className="w-4 h-4 text-[var(--color-text-muted,#687386)] absolute left-3.5 pointer-events-none" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder={`Search ${currentStep}...`}
                  className="w-full pl-9 pr-9 py-2.5 bg-[var(--color-surface-subtle,#F8FAFC)] border border-[var(--color-border,#E2E8F0)] rounded-xl text-sm text-[var(--color-text-primary,#172033)] placeholder-[var(--color-text-muted,#687386)] focus:outline-none focus:ring-2 focus:ring-[#7A0A0A]/20 focus:border-[#7A0A0A] transition-all"
                />
                {searchTerm && (
                  <button
                    type="button"
                    onClick={() => setSearchTerm('')}
                    className="absolute right-3 p-0.5 text-[var(--color-text-muted,#687386)] hover:text-[var(--color-text-primary,#172033)]"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>

            {/* Scrollable Location List */}
            <div className="flex-1 overflow-y-auto divide-y divide-[var(--color-border,#E2E8F0)] px-2 py-1">
              {loading ? (
                <div className="py-12 flex flex-col items-center justify-center text-center text-[var(--color-text-secondary,#5F6B7F)]">
                  <div className="w-6 h-6 border-2 border-[#7A0A0A] border-t-transparent rounded-full animate-spin mb-3" />
                  <p className="text-sm font-medium">Loading official geographic records...</p>
                </div>
              ) : filteredItems.length === 0 ? (
                <div className="py-12 flex flex-col items-center justify-center text-center px-4">
                  <AlertCircle className="w-8 h-8 text-[var(--color-text-muted,#687386)] mb-2.5" />
                  <p className="text-sm font-semibold text-[var(--color-text-primary,#172033)]">No locations found</p>
                  <p className="text-xs text-[var(--color-text-secondary,#5F6B7F)] mt-1">
                    No results match &ldquo;{searchTerm}&rdquo;
                  </p>
                </div>
              ) : (
                filteredItems.map((item) => (
                  <button
                    key={item.code}
                    type="button"
                    onClick={() => {
                      if (currentStep === 'region') handleSelectRegion(item as PsgcLocation);
                      else if (currentStep === 'province') handleSelectProvince(item as PsgcLocation);
                      else if (currentStep === 'city') handleSelectCity(item as PsgcLocation);
                      else if (currentStep === 'barangay') handleSelectBarangay(item as PsgcLocation);
                    }}
                    className="w-full text-left px-3.5 py-3 hover:bg-slate-100/80 active:bg-slate-200/70 rounded-xl flex items-center justify-between group transition-colors"
                  >
                    <span className="text-sm text-[var(--color-text-primary,#172033)] group-hover:text-[#7A0A0A] font-medium">
                      {item.name}
                    </span>
                    <ChevronRight className="w-4 h-4 text-[var(--color-text-muted,#687386)] group-hover:text-[#7A0A0A] transition-colors" />
                  </button>
                ))
              )}
            </div>
          </div>
        ) : (
          /* Confirmation Step View */
          <div className="flex-1 overflow-y-auto p-5 flex flex-col justify-between">
            <div className="space-y-4">
              <div className="p-4 bg-[var(--color-surface-subtle,#F8FAFC)] border border-[var(--color-border,#E2E8F0)] rounded-xl space-y-3">
                <div>
                  <span className="text-xs text-[var(--color-text-secondary,#5F6B7F)] uppercase tracking-wider font-semibold">
                    Region
                  </span>
                  <p className="text-sm font-bold text-[var(--color-text-primary,#172033)] mt-0.5">{selectedRegion?.name}</p>
                </div>

                {selectedProvince && (
                  <div>
                    <span className="text-xs text-[var(--color-text-secondary,#5F6B7F)] uppercase tracking-wider font-semibold">
                      Province
                    </span>
                    <p className="text-sm font-bold text-[var(--color-text-primary,#172033)] mt-0.5">{selectedProvince.name}</p>
                  </div>
                )}

                <div>
                  <span className="text-xs text-[var(--color-text-secondary,#5F6B7F)] uppercase tracking-wider font-semibold">
                    City / Municipality
                  </span>
                  <p className="text-sm font-bold text-[var(--color-text-primary,#172033)] mt-0.5">{selectedCity?.name}</p>
                </div>

                <div>
                  <span className="text-xs text-[var(--color-text-secondary,#5F6B7F)] uppercase tracking-wider font-semibold">
                    Barangay
                  </span>
                  <p className="text-sm font-bold text-[var(--color-text-primary,#172033)] mt-0.5">{selectedBarangay?.name}</p>
                </div>
              </div>

              <p className="text-xs text-[var(--color-text-secondary,#5F6B7F)] leading-relaxed">
                Standardized administrative locality selected via PSA PSGC reference data. House/building
                number and street will be entered on the main form.
              </p>
            </div>

            <div className="pt-5 flex items-center space-x-3">
              <button
                type="button"
                onClick={() => setCurrentStep('barangay')}
                className="w-1/3 py-2.5 px-4 bg-white hover:bg-slate-100 border border-[var(--color-border,#E2E8F0)] text-sm font-semibold text-[var(--color-text-primary,#172033)] rounded-xl transition-colors shadow-xs"
              >
                Change
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                className="w-2/3 py-2.5 px-4 bg-[#7A0A0A] hover:bg-[#600808] text-white text-sm font-bold rounded-xl shadow-md shadow-[#7A0A0A]/20 flex items-center justify-center space-x-2 transition-all active:scale-[0.98]"
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
