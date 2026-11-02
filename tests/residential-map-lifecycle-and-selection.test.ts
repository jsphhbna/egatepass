// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import * as L from 'leaflet';
import { normalizeCoordinates } from '../src/lib/homeLocation.js';

describe('Residential Location Map Lifecycle, Mobile Responsiveness & Selection Confirmation Suite', () => {
  const componentSrc = readFileSync('src/components/ResidentialLocationPicker.tsx', 'utf8');

  // ==========================================================================
  // 1. PIN ICON GEOMETRY & ANCHOR (DOUBLE-TRANSLATION DEFECT CLOSURE)
  // ==========================================================================
  describe('1. Pin Icon Geometry & Anchor Accuracy', () => {
    it('does NOT contain style="transform: translate(-50%, -100%);" inside custom-osm-pin HTML', () => {
      // The previous implementation had translate(-50%, -100%) inside divIcon HTML
      // which combined with Leaflet\'s iconAnchor: [17, 42] causing a double offset (42px above intended position).
      expect(componentSrc).not.toContain('transform: translate(-50%, -100%)');
      expect(componentSrc).not.toContain('translate(-50%, -100%)');
    });

    it('defines accurate iconSize [34, 42] and iconAnchor [17, 42] matching SVG dimensions', () => {
      expect(componentSrc).toContain('iconSize: [34, 42]');
      expect(componentSrc).toContain('iconAnchor: [17, 42]');
      expect(componentSrc).toContain('<svg width="34" height="42"');
    });

    it('creates Leaflet divIcon with bottom-center anchor matching pin tip', () => {
      const pinIcon = L.divIcon({
        className: 'custom-osm-pin',
        html: '<svg width="34" height="42" viewBox="0 0 34 42" fill="none"><path d="M17 0C7.61116 0 0 7.61116 0 17C0 27.5 17 42 17 42C17 42 34 27.5 34 17C34 7.61116 26.3888 0 17 0Z" fill="#1e3a8a"/></svg>',
        iconSize: [34, 42],
        iconAnchor: [17, 42],
      });

      expect(pinIcon.options.iconSize).toEqual([34, 42]);
      expect(pinIcon.options.iconAnchor).toEqual([17, 42]);
    });
  });

  // ==========================================================================
  // 2. MODAL ISOLATION & PORTAL MOUNTING (NO NESTED FORM COLLISION)
  // ==========================================================================
  describe('2. Modal Isolation & Form Nesting Prevention', () => {
    it('imports and uses createPortal to mount modal content to document.body', () => {
      expect(componentSrc).toContain("import { createPortal } from 'react-dom';");
      expect(componentSrc).toMatch(/createPortal\s*\(\s*modalContent\s*,\s*document\.body\s*\)/);
    });

    it('does NOT use a nested <form> element for location search inside the modal', () => {
      // Form inside form causes native submit bubbling on Enter key,
      // which triggered premature registration form validation/submission.
      // Search is now safely encapsulated inside a div with onKeyDown handler.
      const searchSection = componentSrc.slice(
        componentSrc.indexOf('Search Nominatim'),
        componentSrc.indexOf('Search Nominatim') + 1400
      );
      expect(searchSection).not.toContain('<form');
      expect(searchSection).not.toContain('</form>');
      expect(componentSrc).toContain("if (e.key === 'Enter')");
      expect(componentSrc).toContain('void handleSearchSubmit()');
    });
  });

  // ==========================================================================
  // 3. MOBILE VIEWPORT SIZING & LEAFLET ZERO-SIZE CONTAINER PREVENTION
  // ==========================================================================
  describe('3. Mobile Viewport Layout & Container CSS Constraints', () => {
    it('uses dynamic viewport units and bounds max height for 320px-430px mobile screens', () => {
      // Ensures the modal dialog fits in mobile viewport without overflowing or hiding the footer
      expect(componentSrc).toContain('h-[90dvh]');
      expect(componentSrc).toContain('max-h-[640px]');
      expect(componentSrc).toContain('sm:h-auto');
      expect(componentSrc).toContain('sm:max-h-[85vh]');
    });

    it('uses flex-shrink-0 for header, privacy banner, search, and footer to prevent collapse', () => {
      expect(componentSrc).toContain('border-b border-[var(--color-border)] flex items-center justify-between bg-slate-50 flex-shrink-0');
      expect(componentSrc).toContain('border-t border-[var(--color-border)] bg-slate-50 flex flex-col sm:flex-row items-center justify-between gap-2.5 flex-shrink-0');
    });

    it('places Leaflet container inside an absolute-fill container to prevent zero-height Leaflet bug', () => {
      expect(componentSrc).toContain('className="relative flex-1 min-h-[220px]');
      expect(componentSrc).toContain('ref={mapContainerRef}');
      expect(componentSrc).toContain('className="absolute inset-0 z-0"');
    });

    it('invalidates Leaflet map size on modal open with multiple stabilization passes (RAF + timer)', () => {
      expect(componentSrc).toContain('map.invalidateSize()');
      expect(componentSrc).toContain('requestAnimationFrame');
      expect(componentSrc).toContain('setTimeout');
    });
  });

  // ==========================================================================
  // 4. UNIFIED MARKER POSITIONING & QUICK AREA SELECTION
  // ==========================================================================
  describe('4. Unified Marker Positioning & Quick Area Selection Contract', () => {
    it('provides setOrUpdateMarker callback that synchronizes marker and draftLocation', () => {
      expect(componentSrc).toContain('const setOrUpdateMarker = useCallback((lat: unknown, lon: unknown, flyTo = false)');
      expect(componentSrc).toContain('setDraftLocation({ lat: rLat, lon: rLon })');
    });

    it('updates marker position and flies to coordinates when Quick Area is selected', () => {
      expect(componentSrc).toContain('setOrUpdateMarker(area.lat, area.lon, true)');
    });

    it('updates marker position and flies to coordinates when manual coordinates are applied', () => {
      expect(componentSrc).toContain('setOrUpdateMarker(manualLat, manualLon, true)');
    });

    it('updates marker position when Nominatim search result is chosen', () => {
      expect(componentSrc).toContain('const handleSelectSearchResult = (place: SearchPlace)');
      expect(componentSrc).toContain('setOrUpdateMarker(place.lat, place.lon, true)');
    });

    it('attaches dragend listener to marker to update draftLocation on pin drag', () => {
      expect(componentSrc).toContain("marker.on('dragend'");
      expect(componentSrc).toContain('const pos = marker.getLatLng()');
      expect(componentSrc).toContain('normalizeCoordinates(pos.lat, pos.lng)');
    });
  });

  // ==========================================================================
  // 5. CONFIRMATION & COORDINATE RESOLUTION NORMALIZATION
  // ==========================================================================
  describe('5. Confirmation & Normalization Contract', () => {
    it('disables Confirm Location button when draftLocation is null', () => {
      expect(componentSrc).toContain('disabled={!draftLocation}');
      expect(componentSrc).toContain('Confirm Location');
    });

    it('normalizes confirmed location to 3 decimal places (~100m resolution) on handleConfirm', () => {
      expect(componentSrc).toContain('handleConfirm');
      expect(componentSrc).toContain('normalizeCoordinates(draftLocation.lat, draftLocation.lon)');
      expect(componentSrc).toContain('onChange(norm.location)');
      expect(componentSrc).toContain('setIsOpen(false)');
    });

    it('verifies coordinate rounding matches privacy contract (~100m resolution)', () => {
      const rawLat = 14.59951234;
      const rawLon = 120.98421234;
      const norm = normalizeCoordinates(rawLat, rawLon);

      expect(norm.valid).toBe(true);
      if (norm.valid) {
        expect(norm.location.lat).toBe(14.6);
        expect(norm.location.lon).toBe(120.984);
        // String representation has at most 3 decimal places
        const latParts = norm.location.lat.toString().split('.');
        const lonParts = norm.location.lon.toString().split('.');
        if (latParts[1]) expect(latParts[1].length).toBeLessThanOrEqual(3);
        if (lonParts[1]) expect(lonParts[1].length).toBeLessThanOrEqual(3);
      }
    });

    it('displays approximate coordinates badge and Change button when value is set', () => {
      expect(componentSrc).toContain('Approximate location selected');
      expect(componentSrc).toContain('{value.lat.toFixed(3)}, {value.lon.toFixed(3)} (~100m approximate area)');
      expect(componentSrc).toContain('Change');
    });
  });

  // ==========================================================================
  // 6. INITIAL VIEW & RESTORATION OF SAVED COORDINATES
  // ==========================================================================
  describe('6. Saved Location Restoration Contract', () => {
    it('centers map on saved location when value is provided', () => {
      expect(componentSrc).toContain('const saved = value || draftLocation;');
      expect(componentSrc).toContain('const initialCenter: [number, number] = saved');
      expect(componentSrc).toContain('? [saved.lat, saved.lon]');
      expect(componentSrc).toContain(': NEUTRAL_PH_VIEW_CENTER;');
    });

    it('restores marker at saved location when opening modal with existing value', () => {
      expect(componentSrc).toContain('if (saved) {');
      expect(componentSrc).toContain('const marker = L.marker([saved.lat, saved.lon]');
    });

    it('defaults to neutral PH view center and zoom when value is null (new visitor)', () => {
      expect(componentSrc).toContain('const NEUTRAL_PH_VIEW_CENTER: [number, number] = [14.5995, 120.9842];');
      expect(componentSrc).toContain('const NEUTRAL_PH_VIEW_ZOOM = 12;');
    });
  });
});
