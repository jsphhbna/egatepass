import { useState, useEffect, useRef } from 'react';
import { MapPin, CheckCircle2, ChevronRight, Loader2, Edit3, X, AlertCircle } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { Input } from './ui/Input';

export interface AddressSelectionValue {
  formattedAddress: string;
  addressDetail?: string;
  placeId: string;
  lat?: number;
  lon?: number;
  confidence?: number | null;
  resultType?: string;
  regionCode?: string;
  regionName?: string;
  provinceCode?: string;
  provinceName?: string;
  cityCode?: string;
  cityName?: string;
  barangayCode?: string;
  barangayName?: string;
  psgcVersion?: string;
}

export interface CompactAddressPickerProps {
  value?: AddressSelectionValue | null;
  onChange: (val: AddressSelectionValue | null) => void;
  error?: string;
  disabled?: boolean;
  required?: boolean;
}

interface PsgcItem {
  code: string;
  name: string;
  designation?: string;
}

interface AddressSuggestion {
  placeId: string;
  formatted: string;
  addressLine1?: string;
  lat: number;
  lon: number;
  resultType: string;
  confidence?: number;
}

export function CompactAddressPicker({
  value,
  onChange,
  error,
  disabled = false,
}: CompactAddressPickerProps) {
  const [isOpen, setIsOpen] = useState(false);

  // PSGC hierarchy state
  const [regions, setRegions] = useState<PsgcItem[]>([]);
  const [provinces, setProvinces] = useState<PsgcItem[]>([]);
  const [cities, setCities] = useState<PsgcItem[]>([]);
  const [barangays, setBarangays] = useState<PsgcItem[]>([]);

  const [selectedRegion, setSelectedRegion] = useState<PsgcItem | null>(null);
  const [selectedProvince, setSelectedProvince] = useState<PsgcItem | null>(null);
  const [selectedCity, setSelectedCity] = useState<PsgcItem | null>(null);
  const [selectedBarangay, setSelectedBarangay] = useState<PsgcItem | null>(null);

  const [loadingRegions, setLoadingRegions] = useState(false);
  const [loadingProvinces, setLoadingProvinces] = useState(false);
  const [loadingCities, setLoadingCities] = useState(false);
  const [loadingBarangays, setLoadingBarangays] = useState(false);

  // Street address autocomplete state
  const [streetQuery, setStreetQuery] = useState('');
  const [isSearchingStreet, setIsSearchingStreet] = useState(false);
  const [streetSuggestions, setStreetSuggestions] = useState<AddressSuggestion[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState<AddressSuggestion | null>(null);
  const [addressDetail, setAddressDetail] = useState('');
  const [searchError, setSearchError] = useState<string | null>(null);

  const autocompleteAbortRef = useRef<AbortController | null>(null);

  // Load regions on first modal open
  useEffect(() => {
    if (isOpen && regions.length === 0) {
      void loadRegions();
    }
  }, [isOpen]);

  async function loadRegions() {
    setLoadingRegions(true);
    try {
      const res = await fetch('/api/passes/address/psgc?level=regions');
      if (res.ok) {
        const data = await res.json();
        setRegions(data.data || []);
      }
    } catch (err) {
      console.warn('Failed to load PSGC regions:', err);
    } finally {
      setLoadingRegions(false);
    }
  }

  // Load provinces when region changes
  async function handleRegionChange(regionCode: string) {
    const reg = regions.find((r) => r.code === regionCode) || null;
    setSelectedRegion(reg);
    setSelectedProvince(null);
    setSelectedCity(null);
    setSelectedBarangay(null);
    setProvinces([]);
    setCities([]);
    setBarangays([]);
    setSelectedSuggestion(null);

    if (!reg) return;

    // NCR (code starting with 13) has no provinces
    if (reg.code.startsWith('13')) {
      void loadCities(reg.code, undefined);
      return;
    }

    setLoadingProvinces(true);
    try {
      const res = await fetch(`/api/passes/address/psgc?level=provinces&regionCode=${reg.code}`);
      if (res.ok) {
        const data = await res.json();
        setProvinces(data.data || []);
      }
    } catch (err) {
      console.warn('Failed to load PSGC provinces:', err);
    } finally {
      setLoadingProvinces(false);
    }
  }

  // Load cities when province changes
  async function handleProvinceChange(provinceCode: string) {
    const prov = provinces.find((p) => p.code === provinceCode) || null;
    setSelectedProvince(prov);
    setSelectedCity(null);
    setSelectedBarangay(null);
    setCities([]);
    setBarangays([]);
    setSelectedSuggestion(null);

    if (!prov || !selectedRegion) return;
    void loadCities(selectedRegion.code, prov.code);
  }

  async function loadCities(regionCode: string, provinceCode?: string) {
    setLoadingCities(true);
    try {
      const url = provinceCode
        ? `/api/passes/address/psgc?level=cities&regionCode=${regionCode}&provinceCode=${provinceCode}`
        : `/api/passes/address/psgc?level=cities&regionCode=${regionCode}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setCities(data.data || []);
      }
    } catch (err) {
      console.warn('Failed to load PSGC cities:', err);
    } finally {
      setLoadingCities(false);
    }
  }

  // Load barangays when city changes
  async function handleCityChange(cityCode: string) {
    const city = cities.find((c) => c.code === cityCode) || null;
    setSelectedCity(city);
    setSelectedBarangay(null);
    setBarangays([]);
    setSelectedSuggestion(null);

    if (!city) return;

    setLoadingBarangays(true);
    try {
      const res = await fetch(`/api/passes/address/psgc?level=barangays&cityCode=${city.code}`);
      if (res.ok) {
        const data = await res.json();
        setBarangays(data.data || []);
      }
    } catch (err) {
      console.warn('Failed to load PSGC barangays:', err);
    } finally {
      setLoadingBarangays(false);
    }
  }

  function handleBarangayChange(barangayCode: string) {
    const bg = barangays.find((b) => b.code === barangayCode) || null;
    setSelectedBarangay(bg);
  }

  // Street address autocomplete debounced search
  useEffect(() => {
    if (!streetQuery || streetQuery.trim().length < 3) {
      setStreetSuggestions([]);
      return;
    }

    if (autocompleteAbortRef.current) {
      autocompleteAbortRef.current.abort();
    }
    const controller = new AbortController();
    autocompleteAbortRef.current = controller;

    const timer = setTimeout(async () => {
      setIsSearchingStreet(true);
      setSearchError(null);
      try {
        const params = new URLSearchParams({
          q: streetQuery.trim(),
        });
        if (selectedCity?.name) params.set('city', selectedCity.name);
        if (selectedProvince?.name) params.set('province', selectedProvince.name);
        if (selectedBarangay?.name) params.set('barangay', selectedBarangay.name);

        const res = await fetch(`/api/passes/address/autocomplete?${params.toString()}`, {
          signal: controller.signal,
        });

        if (res.ok) {
          const data = await res.json();
          setStreetSuggestions(data.suggestions || []);
        } else if (res.status === 429) {
          setSearchError('Address search rate limit reached. Please wait a moment.');
        } else {
          setSearchError('Address suggestions temporarily unavailable.');
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          console.warn('Autocomplete fetch error:', err);
        }
      } finally {
        setIsSearchingStreet(false);
      }
    }, 300);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [streetQuery, selectedCity, selectedProvince, selectedBarangay]);

  function handleOpenModal() {
    if (disabled) return;
    // If value already has data, pre-populate if possible
    if (value) {
      setAddressDetail(value.addressDetail || '');
      setSelectedSuggestion({
        placeId: value.placeId,
        formatted: value.formattedAddress,
        lat: value.lat || 0,
        lon: value.lon || 0,
        resultType: value.resultType || 'unknown',
        confidence: value.confidence || undefined,
      });
      if (value.regionCode && value.regionName) {
        setSelectedRegion({ code: value.regionCode, name: value.regionName });
      }
      if (value.provinceCode && value.provinceName) {
        setSelectedProvince({ code: value.provinceCode, name: value.provinceName });
      }
      if (value.cityCode && value.cityName) {
        setSelectedCity({ code: value.cityCode, name: value.cityName });
      }
      if (value.barangayCode && value.barangayName) {
        setSelectedBarangay({ code: value.barangayCode, name: value.barangayName });
      }
    }
    setIsOpen(true);
  }

  function handleConfirmSelection() {
    if (!selectedSuggestion || !selectedCity || !selectedRegion) return;

    onChange({
      formattedAddress: selectedSuggestion.formatted,
      addressDetail: addressDetail.trim() || undefined,
      placeId: selectedSuggestion.placeId,
      lat: selectedSuggestion.lat,
      lon: selectedSuggestion.lon,
      confidence: selectedSuggestion.confidence,
      resultType: selectedSuggestion.resultType,
      regionCode: selectedRegion.code,
      regionName: selectedRegion.name,
      provinceCode: selectedProvince?.code,
      provinceName: selectedProvince?.name,
      cityCode: selectedCity.code,
      cityName: selectedCity.name,
      barangayCode: selectedBarangay?.code,
      barangayName: selectedBarangay?.name,
      psgcVersion: '2026-Q3',
    });
    setIsOpen(false);
  }

  const isNcr = selectedRegion?.code.startsWith('13') || selectedRegion?.name.includes('National Capital Region');

  return (
    <div className="space-y-2">
      {/* Trigger / Summary Display */}
      {value ? (
        <div
          data-testid="selected-address-summary"
          className="rounded-2xl border-2 border-emerald-600/25 bg-emerald-50/60 p-4 transition-all"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-xl bg-emerald-600 text-white p-2 flex-shrink-0 shadow-xs">
                <CheckCircle2 className="h-5 w-5" />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-1.5 mb-1">
                  <span className="rounded-full bg-emerald-700 text-white text-[10px] font-black uppercase tracking-wider px-2 py-0.5">
                    Verified PH Address
                  </span>
                  {(value.cityName || value.regionName) && (
                    <span className="rounded-full bg-emerald-200/80 text-emerald-900 text-[10px] font-semibold px-2 py-0.5">
                      {[value.barangayName, value.cityName, value.provinceName || value.regionName]
                        .filter(Boolean)
                        .join(', ')}
                    </span>
                  )}
                </div>
                <p className="text-xs font-bold text-slate-900 leading-snug">
                  {value.formattedAddress}
                </p>
                {value.addressDetail && (
                  <p className="text-[11px] font-medium text-slate-600 mt-1">
                    Detail: {value.addressDetail}
                  </p>
                )}
              </div>
            </div>

            {!disabled && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleOpenModal}
                icon={<Edit3 className="h-3.5 w-3.5" />}
                className="flex-shrink-0 text-xs font-bold"
              >
                Change
              </Button>
            )}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={handleOpenModal}
          disabled={disabled}
          data-testid="select-address-trigger"
          className={`w-full rounded-2xl border-2 border-dashed p-4 text-left transition-all flex items-center justify-between cursor-pointer ${
            error
              ? 'border-red-400 bg-red-50/40 hover:bg-red-50/70'
              : 'border-slate-300 bg-slate-50/50 hover:bg-white hover:border-[#7A0A0A] hover:shadow-xs'
          } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-slate-100 text-[#7A0A0A] flex items-center justify-center flex-shrink-0">
              <MapPin className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xs font-bold text-slate-900">
                Select Philippine Address
              </p>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Official PSA PSGC hierarchy & verified street location
              </p>
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-slate-400" />
        </button>
      )}

      {error && !value && (
        <p className="text-xs text-red-600 font-medium flex items-center gap-1 mt-1">
          <AlertCircle className="h-3.5 w-3.5" />
          {error}
        </p>
      )}

      {/* Progressive Selector Modal */}
      <Modal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title="Select Philippine Address"
        description="Choose your official administrative division (PSGC) and verify your street address."
        size="lg"
      >
        <div className="space-y-4 max-h-[75vh] overflow-y-auto px-1 py-1">
          {/* Step 1: PSGC Administrative Hierarchy */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-black uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-[#7A0A0A]" />
                1. Official PSA PSGC Administrative Division
              </span>
              <span className="text-[10px] font-bold text-slate-500">Q3 2026 Edition</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Region */}
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  Region *
                </label>
                <select
                  data-testid="psgc-region-select"
                  value={selectedRegion?.code || ''}
                  onChange={(e) => void handleRegionChange(e.target.value)}
                  disabled={loadingRegions}
                  className="w-full text-xs rounded-xl border border-slate-300 bg-white px-3 py-2 text-slate-900 font-medium focus:outline-none focus:border-[#7A0A0A]"
                >
                  <option value="">-- Select Region --</option>
                  {regions.map((reg) => (
                    <option key={reg.code} value={reg.code}>
                      {reg.name} {reg.designation ? `(${reg.designation})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              {/* Province (Skipped if NCR) */}
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  Province {isNcr ? '(N/A for NCR)' : '*'}
                </label>
                <select
                  data-testid="psgc-province-select"
                  value={selectedProvince?.code || ''}
                  onChange={(e) => void handleProvinceChange(e.target.value)}
                  disabled={!selectedRegion || isNcr || loadingProvinces}
                  className="w-full text-xs rounded-xl border border-slate-300 bg-white px-3 py-2 text-slate-900 font-medium focus:outline-none focus:border-[#7A0A0A] disabled:bg-slate-100 disabled:text-slate-400"
                >
                  <option value="">
                    {isNcr ? 'National Capital Region (No Provinces)' : '-- Select Province --'}
                  </option>
                  {provinces.map((prov) => (
                    <option key={prov.code} value={prov.code}>
                      {prov.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* City / Municipality */}
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  City / Municipality *
                </label>
                <select
                  data-testid="psgc-city-select"
                  value={selectedCity?.code || ''}
                  onChange={(e) => void handleCityChange(e.target.value)}
                  disabled={(!selectedProvince && !isNcr) || loadingCities}
                  className="w-full text-xs rounded-xl border border-slate-300 bg-white px-3 py-2 text-slate-900 font-medium focus:outline-none focus:border-[#7A0A0A] disabled:bg-slate-100 disabled:text-slate-400"
                >
                  <option value="">-- Select City / Municipality --</option>
                  {cities.map((city) => (
                    <option key={city.code} value={city.code}>
                      {city.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Barangay */}
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  Barangay (Optional)
                </label>
                <select
                  data-testid="psgc-barangay-select"
                  value={selectedBarangay?.code || ''}
                  onChange={(e) => handleBarangayChange(e.target.value)}
                  disabled={!selectedCity || loadingBarangays}
                  className="w-full text-xs rounded-xl border border-slate-300 bg-white px-3 py-2 text-slate-900 font-medium focus:outline-none focus:border-[#7A0A0A] disabled:bg-slate-100 disabled:text-slate-400"
                >
                  <option value="">-- Select Barangay --</option>
                  {barangays.map((bg) => (
                    <option key={bg.code} value={bg.code}>
                      {bg.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Step 2: Street Address Autocomplete & Verification */}
          {selectedCity && (
            <div className="rounded-xl border border-slate-200 bg-white p-3.5 space-y-3">
              <span className="text-[11px] font-black uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-[#7A0A0A]" />
                2. Street, Building & Landmark Verification (Geoapify)
              </span>

              {selectedSuggestion ? (
                <div className="rounded-xl border border-emerald-400 bg-emerald-50/70 p-3 flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-700 mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="text-xs font-bold text-slate-900">{selectedSuggestion.formatted}</p>
                      <p className="text-[10px] text-emerald-800 font-semibold mt-0.5">
                        Matched location in {selectedCity.name}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedSuggestion(null);
                      setStreetQuery('');
                    }}
                    className="text-xs text-slate-600 hover:text-red-700 font-bold p-1"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <div className="relative space-y-1.5">
                  <div className="relative">
                    <Input
                      data-testid="street-address-input"
                      placeholder={`Search street, building, or landmark in ${selectedCity.name}...`}
                      value={streetQuery}
                      onChange={(e) => setStreetQuery(e.target.value)}
                      autoComplete="off"
                    />
                    {isSearchingStreet && (
                      <div className="absolute right-3 top-3">
                        <Loader2 className="h-4 w-4 animate-spin text-[#7A0A0A]" />
                      </div>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-500">
                    Scoped to {selectedCity.name}{selectedProvince ? `, ${selectedProvince.name}` : ''}. Type at least 3 letters.
                  </p>

                  {searchError && (
                    <p className="text-xs text-red-600 font-medium">{searchError}</p>
                  )}

                  {streetSuggestions.length > 0 && (
                    <div className="absolute z-30 w-full mt-1 bg-white rounded-xl border border-slate-200 shadow-xl overflow-hidden max-h-56 overflow-y-auto">
                      {streetSuggestions.map((sug) => (
                        <div
                          key={sug.placeId}
                          onClick={() => {
                            setSelectedSuggestion(sug);
                            setStreetSuggestions([]);
                            setStreetQuery('');
                          }}
                          role="button"
                          tabIndex={0}
                          className="p-2.5 hover:bg-slate-50 cursor-pointer border-b border-slate-100 last:border-b-0 text-left transition-colors flex items-start gap-2"
                        >
                          <MapPin className="h-3.5 w-3.5 text-[#7A0A0A] mt-0.5 flex-shrink-0" />
                          <div>
                            <p className="text-xs font-bold text-slate-900">{sug.addressLine1 || sug.formatted}</p>
                            <p className="text-[10px] text-slate-500 mt-0.5">{sug.formatted}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Optional Address Detail */}
              <div className="pt-2 border-t border-slate-100">
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  Unit / Floor / House No. / Building (Optional)
                </label>
                <Input
                  data-testid="address-detail-input"
                  placeholder="e.g. Unit 402, Building 3, Diamond Tower"
                  value={addressDetail}
                  onChange={(e) => setAddressDetail(e.target.value)}
                />
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-2 pt-3 border-t border-slate-200">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setIsOpen(false)}
              className="flex-1 text-xs"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleConfirmSelection}
              disabled={!selectedSuggestion || !selectedCity}
              className="flex-1 text-xs font-bold"
              icon={<CheckCircle2 className="h-4 w-4" />}
            >
              Confirm Address
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}