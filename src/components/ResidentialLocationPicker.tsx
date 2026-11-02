import { useState, useEffect, useRef, useCallback } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  MapPin,
  Crosshair,
  AlertCircle,
  X,
  Check,
  Loader2,
  Info,
  Search,
} from 'lucide-react';
import { Button } from './ui';
import {
  type HomeLocation,
  DEFAULT_OSM_TILE_URL,
  DEFAULT_OSM_ATTRIBUTION,
  normalizeCoordinates,
} from '../lib/homeLocation';

export interface ResidentialLocationPickerProps {
  value?: HomeLocation | null;
  onChange: (location: HomeLocation) => void;
  error?: string;
  disabled?: boolean;
  tileUrl?: string;
}

interface SearchPlace {
  displayName: string;
  lat: number;
  lon: number;
}

// Neutral central viewing coordinates for the Philippines when no location is selected
const NEUTRAL_PH_VIEW_CENTER: [number, number] = [14.5995, 120.9842];
const NEUTRAL_PH_VIEW_ZOOM = 12;

// Approximate reference centers for major Greater Manila / Philippine areas (~100m approximate area)
const POPULAR_AREAS: Array<{ name: string; lat: number; lon: number }> = [
  { name: 'Manila (City Center)', lat: 14.599, lon: 120.984 },
  { name: 'Sampaloc / Nagtahan (near EARIST)', lat: 14.604, lon: 120.995 },
  { name: 'Quezon City', lat: 14.676, lon: 121.044 },
  { name: 'Caloocan', lat: 14.650, lon: 120.983 },
  { name: 'Pasig', lat: 14.576, lon: 121.085 },
  { name: 'Makati', lat: 14.555, lon: 121.024 },
  { name: 'Taguig / BGC', lat: 14.518, lon: 121.051 },
  { name: 'Mandaluyong', lat: 14.579, lon: 121.036 },
  { name: 'Marikina', lat: 14.650, lon: 121.100 },
  { name: 'Pasay', lat: 14.538, lon: 121.001 },
  { name: 'Parañaque', lat: 14.480, lon: 121.017 },
  { name: 'Las Piñas', lat: 14.445, lon: 120.983 },
  { name: 'Muntinlupa', lat: 14.408, lon: 121.042 },
  { name: 'Valenzuela', lat: 14.701, lon: 120.983 },
  { name: 'Malabon / Navotas', lat: 14.663, lon: 120.957 },
  { name: 'Rizal (Antipolo / Cainta)', lat: 14.587, lon: 121.176 },
  { name: 'Cavite (Bacoor / Imus)', lat: 14.416, lon: 120.940 },
  { name: 'Bulacan (Meycauayan)', lat: 14.735, lon: 120.961 },
  { name: 'Laguna (San Pedro / Biñan)', lat: 14.360, lon: 121.050 },
];

// Custom crisp SVG pin divIcon to avoid broken Vite image bundle paths
function createPinIcon() {
  return L.divIcon({
    className: 'custom-osm-pin',
    html: `
      <div style="transform: translate(-50%, -100%);">
        <svg width="34" height="42" viewBox="0 0 34 42" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M17 0C7.61116 0 0 7.61116 0 17C0 27.5 17 42 17 42C17 42 34 27.5 34 17C34 7.61116 26.3888 0 17 0Z" fill="#1e3a8a"/>
          <circle cx="17" cy="16" r="7" fill="white"/>
          <circle cx="17" cy="16" r="4" fill="#3b82f6"/>
        </svg>
      </div>
    `,
    iconSize: [34, 42],
    iconAnchor: [17, 42],
  });
}

export function ResidentialLocationPicker({
  value,
  onChange,
  error,
  disabled = false,
  tileUrl = DEFAULT_OSM_TILE_URL,
}: ResidentialLocationPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  // P0 Fix: For new visitors (value is null), draftLocation starts as null.
  // Never default new visitors to EARIST campus coordinates.
  const [draftLocation, setDraftLocation] = useState<HomeLocation | null>(value || null);
  const [geoLoading, setGeoLoading] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [tileError, setTileError] = useState(false);
  const [showFallback, setShowFallback] = useState(false);
  const [manualLat, setManualLat] = useState('');
  const [manualLon, setManualLon] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);

  // In-map search state
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchPlace[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);

  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);

  // Synchronize draftLocation with value whenever modal opens (restoring saved location for returning visitors)
  useEffect(() => {
    if (isOpen) {
      setDraftLocation(value || null);
      setGeoError(null);
      setTileError(false);
      setSearchQuery('');
      setSearchResults([]);
      setSearchError(null);
    }
  }, [isOpen, value]);

  // Leaflet map lifecycle inside modal
  useEffect(() => {
    if (!isOpen || !mapContainerRef.current) return;

    // Center coordinates: saved location if returning visitor, else neutral viewing position
    const initialCenter: [number, number] = value
      ? [value.lat, value.lon]
      : NEUTRAL_PH_VIEW_CENTER;
    const initialZoom = value ? 14 : NEUTRAL_PH_VIEW_ZOOM;

    // Clean up any stale map instance
    if (mapInstanceRef.current) {
      mapInstanceRef.current.remove();
      mapInstanceRef.current = null;
    }

    const map = L.map(mapContainerRef.current, {
      center: initialCenter,
      zoom: initialZoom,
      zoomControl: true,
    });
    mapInstanceRef.current = map;

    // Add OpenStreetMap tile layer
    const tiles = L.tileLayer(tileUrl, {
      maxZoom: 19,
      attribution: DEFAULT_OSM_ATTRIBUTION,
    }).addTo(map);

    tiles.on('tileerror', () => {
      setTileError(true);
    });

    // Helper to position/update marker
    function setOrUpdateMarker(lat: number, lon: number) {
      const norm = normalizeCoordinates(lat, lon);
      if (!norm.valid) return;
      const { lat: rLat, lon: rLon } = norm.location;

      setDraftLocation({ lat: rLat, lon: rLon });

      if (markerRef.current) {
        markerRef.current.setLatLng([rLat, rLon]);
      } else {
        const marker = L.marker([rLat, rLon], {
          draggable: true,
          icon: createPinIcon(),
        }).addTo(map);

        marker.on('dragend', () => {
          const pos = marker.getLatLng();
          const dNorm = normalizeCoordinates(pos.lat, pos.lng);
          if (dNorm.valid) {
            setDraftLocation(dNorm.location);
          }
        });

        markerRef.current = marker;
      }
    }

    // Only restore/place marker if a saved location already exists (returning visitor)
    if (value) {
      setOrUpdateMarker(value.lat, value.lon);
    }

    // Tap/Click on map places or moves marker
    map.on('click', (e: L.LeafletMouseEvent) => {
      setOrUpdateMarker(e.latlng.lat, e.latlng.lng);
    });

    // Force size calculation after modal transition renders
    const rafId = requestAnimationFrame(() => {
      map.invalidateSize();
    });
    const timer = setTimeout(() => {
      map.invalidateSize();
    }, 200);

    // ResizeObserver guarantees map renders properly regardless of animation timing
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && mapContainerRef.current) {
      resizeObserver = new ResizeObserver(() => {
        if (mapInstanceRef.current) {
          mapInstanceRef.current.invalidateSize();
        }
      });
      resizeObserver.observe(mapContainerRef.current);
    }

    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(timer);
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      if (markerRef.current) {
        markerRef.current.remove();
        markerRef.current = null;
      }
      map.remove();
      mapInstanceRef.current = null;
    };
  }, [isOpen, tileUrl, value]);

  // Method A: Request browser geolocation on user click
  const handleUseMyLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setGeoError('Geolocation is not supported by your browser.');
      return;
    }

    setGeoLoading(true);
    setGeoError(null);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeoLoading(false);
        const norm = normalizeCoordinates(pos.coords.latitude, pos.coords.longitude);
        if (!norm.valid) {
          setGeoError('Received invalid coordinates from device.');
          return;
        }

        const { lat, lon } = norm.location;
        setDraftLocation({ lat, lon });

        if (mapInstanceRef.current) {
          mapInstanceRef.current.flyTo([lat, lon], 14, { duration: 1 });

          if (markerRef.current) {
            markerRef.current.setLatLng([lat, lon]);
          } else {
            const marker = L.marker([lat, lon], {
              draggable: true,
              icon: createPinIcon(),
            }).addTo(mapInstanceRef.current);

            marker.on('dragend', () => {
              const p = marker.getLatLng();
              const dNorm = normalizeCoordinates(p.lat, p.lng);
              if (dNorm.valid) {
                setDraftLocation(dNorm.location);
              }
            });

            markerRef.current = marker;
          }
        }
      },
      (err) => {
        setGeoLoading(false);
        switch (err.code) {
          case err.PERMISSION_DENIED:
            setGeoError('Location permission denied. Please tap the map to place your pin manually.');
            break;
          case err.POSITION_UNAVAILABLE:
            setGeoError('Location unavailable. Please tap the map to choose your approximate area.');
            break;
          case err.TIMEOUT:
            setGeoError('Location request timed out. Please tap the map manually.');
            break;
          default:
            setGeoError('Could not obtain location. Please tap the map manually.');
            break;
        }
      },
      {
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 60000,
      }
    );
  }, []);

  // Method B: Search within map (explicit submission only, compliant with Nominatim policy)
  const handleSearchSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const query = searchQuery.trim();
    if (query.length < 2) {
      setSearchError('Please enter at least 2 characters to search.');
      return;
    }

    setIsSearching(true);
    setSearchError(null);
    setSearchResults([]);

    try {
      const res = await fetch(`/api/location/search?q=${encodeURIComponent(query)}`);
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setSearchError(data?.message || 'Search service temporarily busy. Please tap the map directly.');
        return;
      }

      if (!data?.results || data.results.length === 0) {
        setSearchError('No matching places found. Try a broader area or tap the map directly.');
      } else {
        setSearchResults(data.results);
      }
    } catch {
      setSearchError('Could not connect to search service. Please tap the map directly.');
    } finally {
      setIsSearching(false);
    }
  };

  // When a search result is selected, reposition map and marker but do NOT auto-confirm
  const handleSelectSearchResult = (place: SearchPlace) => {
    const norm = normalizeCoordinates(place.lat, place.lon);
    if (!norm.valid) return;
    const { lat, lon } = norm.location;

    setDraftLocation({ lat, lon });
    setSearchResults([]);

    if (mapInstanceRef.current) {
      mapInstanceRef.current.flyTo([lat, lon], 14, { duration: 1 });

      if (markerRef.current) {
        markerRef.current.setLatLng([lat, lon]);
      } else {
        const marker = L.marker([lat, lon], {
          draggable: true,
          icon: createPinIcon(),
        }).addTo(mapInstanceRef.current);

        marker.on('dragend', () => {
          const p = marker.getLatLng();
          const dNorm = normalizeCoordinates(p.lat, p.lng);
          if (dNorm.valid) {
            setDraftLocation(dNorm.location);
          }
        });

        markerRef.current = marker;
      }
    }
  };

  const handleConfirm = () => {
    if (!draftLocation) return;
    const norm = normalizeCoordinates(draftLocation.lat, draftLocation.lon);
    if (!norm.valid) return;
    onChange(norm.location);
    setIsOpen(false);
  };

  const handleCancel = () => {
    setDraftLocation(value || null);
    setIsOpen(false);
  };

  const isSelected = Boolean(value);

  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-semibold text-[var(--color-text-primary)]">
        Approximate Home Location
      </label>
      <p className="text-xs text-[var(--color-text-secondary)]">
        Select the general area where you live. You do not need to pinpoint your exact house.
      </p>

      {/* Main compact trigger */}
      {!isSelected ? (
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          disabled={disabled}
          className="w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-canvas)] transition-colors text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <div className="flex items-center gap-2.5">
            <MapPin className="h-4 w-4 text-[var(--color-brand)]" />
            <span>Select approximate location</span>
          </div>
          <span className="text-xs font-semibold text-[var(--color-brand)]">Open Map</span>
        </button>
      ) : (
        <div className="flex items-center justify-between p-3 rounded-xl border border-emerald-200 bg-emerald-50/60 text-emerald-950 text-xs">
          <div className="flex items-center gap-2">
            <Check className="h-4 w-4 text-emerald-600 flex-shrink-0" />
            <div>
              <span className="font-semibold block">Approximate location selected</span>
              <span className="text-[11px] text-emerald-700">
                General area recorded (~100m approximate area)
              </span>
            </div>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setIsOpen(true)}
            disabled={disabled}
            className="text-xs font-medium bg-white hover:bg-slate-50 border-emerald-300"
          >
            Change
          </Button>
        </div>
      )}

      {error && (
        <p className="text-xs text-[var(--color-danger)] flex items-center gap-1 mt-1">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
          <span>{error}</span>
        </p>
      )}

      {/* Interactive Map Modal */}
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-4">
          <div
            className="w-full max-w-lg rounded-2xl bg-white shadow-2xl flex flex-col overflow-hidden max-h-[92vh] animate-in fade-in zoom-in-95 duration-150"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            {/* Header */}
            <div className="px-5 py-3.5 border-b border-[var(--color-border)] flex items-center justify-between bg-slate-50">
              <div className="flex items-center gap-2">
                <MapPin className="h-5 w-5 text-[var(--color-brand)]" />
                <div>
                  <h3 id="modal-title" className="font-bold text-sm text-[var(--color-text-primary)]">
                    Select Approximate Home Location
                  </h3>
                  <p className="text-[11px] text-[var(--color-text-secondary)]">
                    Choose via GPS, map search, or tap directly on the map.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleCancel}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 transition-colors"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Privacy notice banner */}
            <div className="px-4 py-2 bg-blue-50/80 border-b border-blue-100 flex items-start gap-2 text-[11px] text-blue-900 leading-snug">
              <Info className="h-3.5 w-3.5 text-blue-600 flex-shrink-0 mt-0.5" />
              <span>
                <strong>Privacy Notice:</strong> Coordinates are saved with ~100m approximate precision. GPS access is optional, manual pin placement is always available, and exact residence is never verified. OpenStreetMap servers receive map tile and search requests.
              </span>
            </div>

            {/* Compact Search Control (Explicit submission only) */}
            <div className="p-3 bg-slate-50 border-b border-slate-200">
              <form onSubmit={handleSearchSubmit} className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search neighborhood, barangay, city in PH..."
                    className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)]"
                  />
                  <Search className="h-3.5 w-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                </div>
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  disabled={isSearching || searchQuery.trim().length < 2}
                  className="text-xs h-8 px-3"
                >
                  {isSearching ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Search'}
                </Button>
              </form>

              {/* Search dropdown results */}
              {searchResults.length > 0 && (
                <div className="mt-2 bg-white rounded-lg border border-slate-200 shadow-lg max-h-36 overflow-y-auto divide-y divide-slate-100 z-10">
                  {searchResults.map((place, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => handleSelectSearchResult(place)}
                      className="w-full text-left px-3 py-2 text-xs hover:bg-blue-50 transition-colors flex items-center justify-between"
                    >
                      <span className="truncate pr-2 text-slate-800">{place.displayName}</span>
                      <span className="text-[10px] text-blue-600 font-medium flex-shrink-0">Place Pin</span>
                    </button>
                  ))}
                </div>
              )}

              {searchError && (
                <p className="text-[11px] text-amber-700 mt-1 flex items-center gap-1">
                  <AlertCircle className="h-3 w-3 flex-shrink-0" />
                  <span>{searchError}</span>
                </p>
              )}
            </div>

            {/* Map canvas */}
            <div className="relative flex-1 min-h-[300px] sm:min-h-[360px] bg-slate-100">
              <div
                ref={mapContainerRef}
                className="w-full h-full min-h-[300px] sm:min-h-[360px] z-0"
              />

              {/* Geolocation & Fallback Area Selector Overlays */}
              <div className="absolute top-3 right-3 z-[1000] flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowFallback(!showFallback)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/95 shadow-md border border-slate-200 text-xs font-semibold text-slate-800 hover:bg-white active:bg-slate-50 transition-colors"
                  title="Select approximate area or enter coordinates"
                >
                  <MapPin className="h-3.5 w-3.5 text-slate-600" />
                  <span>{showFallback ? 'Show Map' : 'Select Area'}</span>
                </button>
                <button
                  type="button"
                  onClick={handleUseMyLocation}
                  disabled={geoLoading}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/95 shadow-md border border-slate-200 text-xs font-semibold text-slate-800 hover:bg-white active:bg-slate-50 transition-colors disabled:opacity-50"
                  title="Use current device location"
                >
                  {geoLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-brand)]" />
                  ) : (
                    <Crosshair className="h-3.5 w-3.5 text-[var(--color-brand)]" />
                  )}
                  <span>Use My Location</span>
                </button>
              </div>

              {/* Accessible Manual Area / Coordinate Fallback View */}
              {showFallback && (
                <div className="absolute inset-0 z-[1001] bg-white p-4 overflow-y-auto">
                  <div className="flex items-center justify-between mb-3 border-b pb-2">
                    <h4 className="font-semibold text-xs text-slate-900">Choose Approximate Area or Enter Coordinates</h4>
                    <button
                      type="button"
                      onClick={() => setShowFallback(false)}
                      className="text-xs text-slate-500 hover:text-slate-900 font-medium"
                    >
                      Back to Map
                    </button>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <p className="text-[11px] text-slate-600 mb-2">Select a general city or municipality in Metro Manila / Greater Manila:</p>
                      <div className="grid grid-cols-2 gap-1.5 max-h-48 overflow-y-auto pr-1">
                        {POPULAR_AREAS.map((area) => (
                          <button
                            key={area.name}
                            type="button"
                            onClick={() => {
                              const norm = normalizeCoordinates(area.lat, area.lon);
                              if (norm.valid) {
                                setDraftLocation(norm.location);
                                setShowFallback(false);
                                if (mapInstanceRef.current) {
                                  mapInstanceRef.current.flyTo([norm.location.lat, norm.location.lon], 14);
                                }
                              }
                            }}
                            className="text-left px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 hover:border-blue-400 hover:bg-blue-50/50 transition-colors truncate"
                          >
                            {area.name}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="pt-2 border-t border-slate-100">
                      <p className="text-[11px] text-slate-600 mb-1.5">Or enter approximate coordinates directly (~100m rounded):</p>
                      <div className="flex gap-2">
                        <input
                          type="number"
                          step="0.001"
                          placeholder="Latitude (e.g. 14.599)"
                          value={manualLat}
                          onChange={(e) => setManualLat(e.target.value)}
                          className="flex-1 px-2.5 py-1.5 text-xs rounded-lg border border-slate-300"
                        />
                        <input
                          type="number"
                          step="0.001"
                          placeholder="Longitude (e.g. 120.984)"
                          value={manualLon}
                          onChange={(e) => setManualLon(e.target.value)}
                          className="flex-1 px-2.5 py-1.5 text-xs rounded-lg border border-slate-300"
                        />
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => {
                            const norm = normalizeCoordinates(manualLat, manualLon);
                            if (norm.valid) {
                              setDraftLocation(norm.location);
                              setManualError(null);
                              setShowFallback(false);
                              if (mapInstanceRef.current) {
                                mapInstanceRef.current.flyTo([norm.location.lat, norm.location.lon], 14);
                              }
                            } else {
                              setManualError(norm.message);
                            }
                          }}
                          className="text-xs h-8 px-3"
                        >
                          Apply
                        </Button>
                      </div>
                      {manualError && (
                        <p className="text-[11px] text-red-600 mt-1">{manualError}</p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Tile Load Error Notification */}
              {tileError && (
                <div className="absolute bottom-6 left-3 right-3 z-[1000] p-3 rounded-xl bg-amber-50 border border-amber-300 text-amber-950 text-xs shadow-lg flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5">
                    <AlertCircle className="h-4 w-4 text-amber-600 flex-shrink-0" />
                    <span>Map tiles could not load. You can tap the map or use the quick area selector.</span>
                  </span>
                  <div className="flex items-center gap-2 self-end sm:self-auto">
                    <button
                      type="button"
                      onClick={() => setShowFallback(true)}
                      className="px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-700 text-white font-medium text-[11px] transition-colors"
                    >
                      Quick Area Selector
                    </button>
                    <button
                      type="button"
                      onClick={() => setTileError(false)}
                      className="text-[11px] font-semibold text-amber-800 hover:underline"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Geolocation Error Alert */}
            {geoError && (
              <div className="px-4 py-2 bg-amber-50 border-t border-amber-200 text-[11px] text-amber-900 flex items-center gap-1.5">
                <AlertCircle className="h-3.5 w-3.5 text-amber-600 flex-shrink-0" />
                <span>{geoError}</span>
              </div>
            )}

            {/* Footer with Actions */}
            <div className="p-4 border-t border-[var(--color-border)] bg-slate-50 flex flex-col sm:flex-row items-center justify-between gap-3">
              <div className="text-[11px] text-[var(--color-text-secondary)] order-2 sm:order-1 text-center sm:text-left">
                {draftLocation ? (
                  <span className="text-emerald-700 font-medium">
                    Marker placed in approximate area (~100m resolution)
                  </span>
                ) : (
                  <span>Click or tap anywhere on the map to place your pin.</span>
                )}
              </div>

              <div className="flex items-center gap-2 w-full sm:w-auto order-1 sm:order-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleCancel}
                  className="flex-1 sm:flex-none"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleConfirm}
                  disabled={!draftLocation}
                  className="flex-1 sm:flex-none"
                >
                  {draftLocation ? 'Confirm Location' : 'Select approximate location'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
