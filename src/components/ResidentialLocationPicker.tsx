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
} from 'lucide-react';
import { Button } from './ui';
import {
  type HomeLocation,
  DEFAULT_OSM_TILE_URL,
  DEFAULT_OSM_ATTRIBUTION,
  DEFAULT_CAMPUS_COORDINATES,
  normalizeCoordinates,
} from '../lib/homeLocation';

export interface ResidentialLocationPickerProps {
  value?: HomeLocation | null;
  onChange: (location: HomeLocation) => void;
  error?: string;
  disabled?: boolean;
  tileUrl?: string;
}

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
  const [draftLocation, setDraftLocation] = useState<HomeLocation | null>(value || null);
  const [geoLoading, setGeoLoading] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [tileError, setTileError] = useState(false);

  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);

  // Synchronize draftLocation with value whenever modal opens (or default campus coordinates)
  useEffect(() => {
    if (isOpen) {
      setDraftLocation(value || DEFAULT_CAMPUS_COORDINATES);
      setGeoError(null);
      setTileError(false);
    }
  }, [isOpen, value]);

  // Leaflet map lifecycle inside modal
  useEffect(() => {
    if (!isOpen || !mapContainerRef.current) return;

    // Center coordinates: saved location or EARIST campus default
    const initialLoc = draftLocation || value || DEFAULT_CAMPUS_COORDINATES;
    const initialCenter: [number, number] = [initialLoc.lat, initialLoc.lon];
    const initialZoom = value ? 14 : 13;

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

    // Place initial marker centered on location
    setOrUpdateMarker(initialLoc.lat, initialLoc.lon);

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

    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(timer);
      if (markerRef.current) {
        markerRef.current.remove();
        markerRef.current = null;
      }
      map.remove();
      mapInstanceRef.current = null;
    };
  }, [isOpen, tileUrl]);

  // Request browser geolocation on user click
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
                    Tap the map or move the pin to indicate your general residential area.
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
                <strong>Privacy Notice:</strong> Your location is stored as an approximate coordinate rounded to ~100m. You do not need to pinpoint your exact house. Street addresses are never recorded.
              </span>
            </div>

            {/* Map canvas */}
            <div className="relative flex-1 min-h-[300px] sm:min-h-[360px] bg-slate-100">
              <div
                ref={mapContainerRef}
                className="w-full h-full min-h-[300px] sm:min-h-[360px] z-0"
              />

              {/* Geolocation Button Overlay */}
              <div className="absolute top-3 right-3 z-[1000]">
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

              {/* Tile Load Error Notification */}
              {tileError && (
                <div className="absolute bottom-6 left-3 right-3 z-[1000] p-2.5 rounded-lg bg-amber-50 border border-amber-300 text-amber-900 text-xs flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <AlertCircle className="h-3.5 w-3.5 text-amber-600 flex-shrink-0" />
                    <span>Some map tiles could not be loaded. You can still place or move the marker.</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setTileError(false)}
                    className="text-[11px] font-semibold text-amber-800 hover:underline ml-2"
                  >
                    Dismiss
                  </button>
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
                  Confirm Location
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
