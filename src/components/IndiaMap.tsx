import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { formatCoordsLabel, formatDurationMinutes } from '../constants/mobility';
import type { LatLngPoint } from '../types';

interface IndiaMapProps {
  pickup: LatLngPoint | null;
  dest: LatLngPoint | null;
  routeGeoJson: GeoJSON.GeoJsonObject | null;
  routeDistanceKm: number | null;
  routeDurationMin: number | null;
  routeSource: 'osrm' | 'geodesic' | null;
  onMapClickPoint: (lat: number, lng: number) => void;
  onMarkerDragEnd: (target: 'pickup' | 'dest', lat: number, lng: number) => void;
}

function createPinIcon(kind: 'pickup' | 'dest'): L.DivIcon {
  const color = kind === 'pickup' ? '#10b981' : '#ef4444';
  const label = kind === 'pickup' ? 'P' : 'D';
  return L.divIcon({
    className: 'taxibook-pin',
    html: `<div style="width:30px;height:30px;border-radius:9999px;background:${color};border:3px solid #090d16;color:#090d16;font-weight:800;font-size:12px;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,0.45);">${label}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

export function IndiaMap({
  pickup,
  dest,
  routeGeoJson,
  routeDistanceKm,
  routeDurationMin,
  routeSource,
  onMapClickPoint,
  onMarkerDragEnd,
}: IndiaMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const pickupMarkerRef = useRef<L.Marker | null>(null);
  const destMarkerRef = useRef<L.Marker | null>(null);
  const routeLayerRef = useRef<L.Layer | null>(null);
  const activeBoundsRef = useRef<L.LatLngBounds | null>(null);
  const wasZeroSizedRef = useRef<boolean>(false);
  const onMapClickRef = useRef(onMapClickPoint);
  const onDragRef = useRef(onMarkerDragEnd);

  onMapClickRef.current = onMapClickPoint;
  onDragRef.current = onMarkerDragEnd;

  useEffect(() => {
    const el = containerRef.current;
    if (!el || mapRef.current) return;

    const map = L.map(el, {
      center: [22.5937, 78.9629],
      zoom: 5,
      zoomControl: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);

    map.on('click', (e: L.LeafletMouseEvent) => {
      onMapClickRef.current(e.latlng.lat, e.latlng.lng);
    });

    mapRef.current = map;
    wasZeroSizedRef.current = el.clientWidth === 0 || el.clientHeight === 0;

    const syncMapSize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w === 0 || h === 0) {
        wasZeroSizedRef.current = true;
        return;
      }
      map.invalidateSize();
      if (wasZeroSizedRef.current) {
        wasZeroSizedRef.current = false;
        if (activeBoundsRef.current && activeBoundsRef.current.isValid()) {
          map.fitBounds(activeBoundsRef.current.pad(0.18));
        }
      }
    };

    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncMapSize) : null;
    observer?.observe(el);
    window.addEventListener('resize', syncMapSize);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', syncMapSize);
      map.remove();
      mapRef.current = null;
      pickupMarkerRef.current = null;
      destMarkerRef.current = null;
      routeLayerRef.current = null;
      activeBoundsRef.current = null;
    };
  }, []);

  // Sync pickup marker
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!pickup) {
      if (pickupMarkerRef.current) {
        map.removeLayer(pickupMarkerRef.current);
        pickupMarkerRef.current = null;
      }
      return;
    }

    if (pickupMarkerRef.current) {
      pickupMarkerRef.current.setLatLng([pickup.lat, pickup.lng]);
    } else {
      const marker = L.marker([pickup.lat, pickup.lng], {
        icon: createPinIcon('pickup'),
        draggable: true,
      }).addTo(map);
      marker.on('dragend', () => {
        const pos = marker.getLatLng();
        onDragRef.current('pickup', pos.lat, pos.lng);
      });
      pickupMarkerRef.current = marker;
    }
  }, [pickup]);

  // Sync destination marker
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!dest) {
      if (destMarkerRef.current) {
        map.removeLayer(destMarkerRef.current);
        destMarkerRef.current = null;
      }
      return;
    }

    if (destMarkerRef.current) {
      destMarkerRef.current.setLatLng([dest.lat, dest.lng]);
    } else {
      const marker = L.marker([dest.lat, dest.lng], {
        icon: createPinIcon('dest'),
        draggable: true,
      }).addTo(map);
      marker.on('dragend', () => {
        const pos = marker.getLatLng();
        onDragRef.current('dest', pos.lat, pos.lng);
      });
      destMarkerRef.current = marker;
    }
  }, [dest]);

  // Sync route polyline & fit bounds
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (routeLayerRef.current) {
      map.removeLayer(routeLayerRef.current);
      routeLayerRef.current = null;
    }

    if (pickup && dest) {
      if (routeGeoJson) {
        const group = L.layerGroup([
          L.geoJSON(routeGeoJson, {
            style: { color: '#0f172a', weight: 8, opacity: 0.85 },
          }),
          L.geoJSON(routeGeoJson, {
            style: { color: '#f59e0b', weight: 4.5, opacity: 0.95 },
          }),
        ]).addTo(map);
        routeLayerRef.current = group;

        const bounds = L.geoJSON(routeGeoJson).getBounds();
        if (bounds.isValid()) {
          activeBoundsRef.current = bounds;
          if ((containerRef.current?.clientWidth ?? 0) > 0) {
            map.fitBounds(bounds.pad(0.18));
          }
        }
      } else {
        const line = L.polyline(
          [
            [pickup.lat, pickup.lng],
            [dest.lat, dest.lng],
          ],
          {
            color: '#f59e0b',
            weight: 4,
            dashArray: '8, 8',
            opacity: 0.85,
          }
        ).addTo(map);
        routeLayerRef.current = line;
        const bounds = line.getBounds();
        activeBoundsRef.current = bounds;
        if ((containerRef.current?.clientWidth ?? 0) > 0) {
          map.fitBounds(bounds.pad(0.22));
        }
      }
    } else {
      activeBoundsRef.current = null;
      if (pickup && !dest) {
        map.panTo([pickup.lat, pickup.lng]);
      }
    }
  }, [pickup, dest, routeGeoJson]);

  return (
    <div
      role="region"
      aria-label="Interactive India dispatch map"
      className="relative w-full h-full min-h-[420px] bg-[#0b1120]"
    >
      <div ref={containerRef} className="w-full h-full z-0" />

      {/* Top Route Summary Overlay (kept clear of top-left zoom controls on mobile) */}
      {pickup && dest && routeDistanceKm !== null && (
        <div className="absolute top-3 left-14 right-3 sm:top-4 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 sm:w-auto z-[900] bg-[#0f172a]/95 border border-slate-700/80 rounded-lg px-3 sm:px-4 py-2 flex flex-wrap items-center justify-center gap-x-2.5 sm:gap-x-4 gap-y-1 text-xs shadow-lg">
          <span className="font-mono-tabular font-semibold text-slate-100 whitespace-nowrap">
            {routeDistanceKm.toFixed(2)} km
          </span>
          <span aria-hidden="true" className="text-slate-600">·</span>
          <span className="font-mono-tabular font-semibold text-slate-100 whitespace-nowrap">
            {routeDurationMin !== null ? formatDurationMinutes(routeDurationMin) : '—'}
          </span>
          <span aria-hidden="true" className="text-slate-600 hidden sm:inline">·</span>
          <span className="text-amber-400 font-medium whitespace-nowrap">
            {routeSource === 'osrm' ? 'OSRM Road Route' : 'Geodesic Estimate'}
          </span>
        </div>
      )}

      {/* Corner Route Coordinates Overlay */}
      {(pickup || dest) && (
        <div className="absolute bottom-7 left-3 right-3 sm:bottom-4 sm:left-auto sm:right-4 sm:w-72 z-[900] bg-[#0f172a]/95 border border-slate-800 rounded-lg p-3 sm:p-3.5 space-y-2 shadow-xl">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-300">Route Coordinates</span>
            <span className="text-emerald-400 font-medium">Draggable Pins</span>
          </div>
          <div className="space-y-1.5 text-xs">
            <div className="flex items-start gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500 mt-1 shrink-0" />
              <div className="min-w-0">
                <div className="text-slate-200 truncate font-medium">
                  {pickup ? pickup.label : 'Waiting for pickup'}
                </div>
                {pickup && (
                  <div className="font-mono-tabular text-[11px] text-slate-400">
                    {formatCoordsLabel(pickup.lat, pickup.lng)}
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-start gap-2">
              <span className="w-2 h-2 rounded-full bg-red-500 mt-1 shrink-0" />
              <div className="min-w-0">
                <div className="text-slate-200 truncate font-medium">
                  {dest ? dest.label : 'Tap map to set destination'}
                </div>
                {dest && (
                  <div className="font-mono-tabular text-[11px] text-slate-400">
                    {formatCoordsLabel(dest.lat, dest.lng)}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Subtle Map Instruction Prompt */}
      {(!pickup || !dest) && (
        <div
          className={`absolute ${
            pickup ? 'bottom-32 sm:bottom-5' : 'bottom-7 sm:bottom-5'
          } left-1/2 -translate-x-1/2 z-[900] max-w-[calc(100%-2rem)] w-max bg-[#0f172a]/95 border border-slate-700/80 rounded-lg px-3.5 sm:px-4 py-2 text-xs text-slate-200 text-center shadow-lg pointer-events-none`}
        >
          {!pickup
            ? 'Tap anywhere on the India map to place your Pickup pin'
            : 'Tap the map to place your Destination pin'}
        </div>
      )}
    </div>
  );
}
