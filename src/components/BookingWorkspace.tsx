import { useCallback, useEffect, useState } from 'react';
import {
  ArrowUpDown,
  Bike,
  Car,
  CheckCircle2,
  Loader2,
  MapPin,
  Navigation,
  Phone,
  RotateCcw,
  Trash2,
  User as UserIcon,
  XCircle,
} from 'lucide-react';
import {
  BLUEPRINT_LIMITS,
  CITY_PRESETS,
  VEHICLE_TIERS,
  formatCoordsLabel,
  formatDurationMinutes,
  haversineKm,
} from '../constants/mobility';
import { createBookingRecord, updateBookingStatus } from '../api';
import type {
  BookingRecord,
  CityPreset,
  FareCalculationResponse,
  LatLngPoint,
  TierQuote,
  UserProfile,
  VehicleTier,
} from '../types';
import { IndiaMap } from './IndiaMap';

interface BookingWorkspaceProps {
  user: UserProfile;
  bookings: BookingRecord[];
  rebookRoute: { pickup: LatLngPoint; dest: LatLngPoint; vehicle: VehicleTier } | null;
  onConsumeRebook: () => void;
  onBookingsChanged: () => Promise<void>;
  onOpenHistory: () => void;
  onToast: (message: string, tone?: 'success' | 'error') => void;
}

export function BookingWorkspace({
  user,
  bookings,
  rebookRoute,
  onConsumeRebook,
  onBookingsChanged,
  onOpenHistory,
  onToast,
}: BookingWorkspaceProps) {
  const [pickup, setPickup] = useState<LatLngPoint | null>(null);
  const [dest, setDest] = useState<LatLngPoint | null>(null);
  const [clickStep, setClickStep] = useState<'pickup' | 'dest'>('pickup');

  const [selectedVehicle, setSelectedVehicle] = useState<VehicleTier>('auto');
  const [passengerName, setPassengerName] = useState(user.displayName || '');
  const [passengerPhone, setPassengerPhone] = useState(user.defaultPhone || '');

  const [routeGeoJson, setRouteGeoJson] = useState<GeoJSON.GeoJsonObject | null>(null);
  const [routeDistanceKm, setRouteDistanceKm] = useState<number | null>(null);
  const [routeDurationMin, setRouteDurationMin] = useState<number | null>(null);
  const [routeSource, setRouteSource] = useState<'osrm' | 'geodesic' | null>(null);
  const [isRouting, setIsRouting] = useState(false);

  const [tierQuotes, setTierQuotes] = useState<Record<VehicleTier, TierQuote> | null>(null);
  const [activeDispatchId, setActiveDispatchId] = useState<string | null>(null);
  const [isBooking, setIsBooking] = useState(false);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<'form' | 'map'>('form');

  useEffect(() => {
    setPassengerName((prev) => (prev.trim() ? prev : user.displayName || ''));
    setPassengerPhone((prev) => (prev.trim() ? prev : user.defaultPhone || ''));
  }, [user.displayName, user.defaultPhone]);

  const activeBooking = activeDispatchId
    ? bookings.find((b) => b.id === activeDispatchId) || null
    : bookings.find((b) => b.status === 'dispatched') || null;

  const calculateQuotes = useCallback(
    async (p: LatLngPoint, d: LatLngPoint, distKm: number, vehicle: VehicleTier) => {
      const params = new URLSearchParams({
        start_lat: String(p.lat),
        start_lng: String(p.lng),
        end_lat: String(d.lat),
        end_lng: String(d.lng),
        vehicle,
        distance_km: String(distKm),
      });
      try {
        const res = await fetch(`/api/calculate-fare?${params.toString()}`);
        if (!res.ok) throw new Error('Fare calculation failed');
        const data = (await res.json()) as FareCalculationResponse;
        setTierQuotes(data.tier_quotes);
        return data;
      } catch {
        const fallbackQuotes: Record<VehicleTier, TierQuote> = {
          bike: {
            vehicle: 'bike',
            baseFare: 20,
            perKmRate: 8,
            fareInr: Math.round((20 + 8 * distKm) * 100) / 100,
          },
          auto: {
            vehicle: 'auto',
            baseFare: 30,
            perKmRate: 12,
            fareInr: Math.round((30 + 12 * distKm) * 100) / 100,
          },
          car: {
            vehicle: 'car',
            baseFare: 50,
            perKmRate: 18,
            fareInr: Math.round((50 + 18 * distKm) * 100) / 100,
          },
        };
        setTierQuotes(fallbackQuotes);
        return null;
      }
    },
    []
  );

  const resolveRoute = useCallback(
    async (p: LatLngPoint, d: LatLngPoint, vehicle: VehicleTier) => {
      setIsRouting(true);
      try {
        const url = `https://router.project-osrm.org/route/v1/driving/${p.lng},${p.lat};${d.lng},${d.lat}?overview=full&geometries=geojson`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.code === 'Ok' && Array.isArray(data.routes) && data.routes.length > 0) {
          const route = data.routes[0];
          const distKm = Math.max(0.1, Math.round((route.distance / 1000) * 100) / 100);
          const durMin = Math.max(1, Math.round(route.duration / 60));
          setRouteGeoJson(route.geometry);
          setRouteDistanceKm(distKm);
          setRouteDurationMin(durMin);
          setRouteSource('osrm');
          await calculateQuotes(p, d, distKm, vehicle);
          return;
        }
      } catch {
        // Fallback to geodesic distance below
      } finally {
        setIsRouting(false);
      }

      const geodesicKm = Math.max(
        0.1,
        Math.round(haversineKm(p.lat, p.lng, d.lat, d.lng) * 100) / 100
      );
      const estMin = Math.max(2, Math.round((geodesicKm / 28) * 60));
      setRouteGeoJson(null);
      setRouteDistanceKm(geodesicKm);
      setRouteDurationMin(estMin);
      setRouteSource('geodesic');
      await calculateQuotes(p, d, geodesicKm, vehicle);
    },
    [calculateQuotes]
  );

  // Consume rebook request from Trip History
  useEffect(() => {
    if (!rebookRoute) return;
    setActiveDispatchId(null);
    setPickup(rebookRoute.pickup);
    setDest(rebookRoute.dest);
    setSelectedVehicle(rebookRoute.vehicle);
    setClickStep('pickup');
    void resolveRoute(rebookRoute.pickup, rebookRoute.dest, rebookRoute.vehicle);
    onConsumeRebook();
  }, [rebookRoute, onConsumeRebook, resolveRoute]);

  const handleMapClickPoint = useCallback(
    (lat: number, lng: number) => {
      setActiveDispatchId(null);
      const point: LatLngPoint = {
        lat,
        lng,
        label: `Pin (${formatCoordsLabel(lat, lng)})`,
      };
      if (clickStep === 'pickup') {
        setPickup(point);
        setClickStep('dest');
        if (dest) {
          void resolveRoute(point, dest, selectedVehicle);
        }
      } else {
        setDest(point);
        setClickStep('pickup');
        if (pickup) {
          void resolveRoute(pickup, point, selectedVehicle);
        }
      }
    },
    [clickStep, dest, pickup, resolveRoute, selectedVehicle]
  );

  const handleMarkerDragEnd = useCallback(
    (target: 'pickup' | 'dest', lat: number, lng: number) => {
      setActiveDispatchId(null);
      const updated: LatLngPoint = {
        lat,
        lng,
        label: `Adjusted (${formatCoordsLabel(lat, lng)})`,
      };
      if (target === 'pickup') {
        setPickup(updated);
        if (dest) void resolveRoute(updated, dest, selectedVehicle);
      } else {
        setDest(updated);
        if (pickup) void resolveRoute(pickup, updated, selectedVehicle);
      }
    },
    [dest, pickup, resolveRoute, selectedVehicle]
  );

  const handleApplyPreset = (preset: CityPreset) => {
    setActiveDispatchId(null);
    setPickup(preset.pickup);
    setDest(preset.dest);
    setClickStep('pickup');
    void resolveRoute(preset.pickup, preset.dest, selectedVehicle);
    onToast(`Loaded ${preset.name} corridor`);
  };

  const handleSwapRoute = () => {
    if (!pickup || !dest) {
      onToast('Set both pickup and destination before swapping.', 'error');
      return;
    }
    setActiveDispatchId(null);
    setPickup(dest);
    setDest(pickup);
    void resolveRoute(dest, pickup, selectedVehicle);
  };

  const handleResetRoute = () => {
    setActiveDispatchId(null);
    setPickup(null);
    setDest(null);
    setRouteGeoJson(null);
    setRouteDistanceKm(null);
    setRouteDurationMin(null);
    setRouteSource(null);
    setTierQuotes(null);
    setClickStep('pickup');
  };

  const trimmedName = passengerName.trim();
  const trimmedPhone = passengerPhone.trim();
  const isNameValid = trimmedName.length >= 1 && trimmedName.length <= BLUEPRINT_LIMITS.DISPLAY_NAME_MAX;
  const isPhoneValid =
    trimmedPhone.length >= BLUEPRINT_LIMITS.PHONE_MIN &&
    trimmedPhone.length <= BLUEPRINT_LIMITS.PHONE_MAX;
  const canConfirm = Boolean(
    pickup && dest && routeDistanceKm && tierQuotes && isNameValid && isPhoneValid && !isBooking
  );

  const selectedQuote = tierQuotes ? tierQuotes[selectedVehicle] : null;

  const handleConfirmBooking = async () => {
    if (!pickup || !dest || !routeDistanceKm || !selectedQuote) return;
    if (!isNameValid) {
      onToast('Please enter a passenger name (1–80 characters).', 'error');
      return;
    }
    if (!isPhoneValid) {
      onToast('Please enter a valid contact phone number (at least 6 digits).', 'error');
      return;
    }

    setIsBooking(true);
    try {
      const params = new URLSearchParams({
        start_lat: String(pickup.lat),
        start_lng: String(pickup.lng),
        end_lat: String(dest.lat),
        end_lng: String(dest.lng),
        vehicle: selectedVehicle,
        distance_km: String(routeDistanceKm),
      });

      const res = await fetch(`/api/calculate-fare?${params.toString()}`);
      if (!res.ok) {
        throw new Error('Could not assign driver from dispatch server.');
      }
      const dispatch = (await res.json()) as FareCalculationResponse;

      const docId = await createBookingRecord({
        bookingCode: dispatch.booking_code,
        passengerName: trimmedName,
        passengerPhone: trimmedPhone,
        vehicle: selectedVehicle,
        pickupLat: pickup.lat,
        pickupLng: pickup.lng,
        pickupLabel: pickup.label,
        destLat: dest.lat,
        destLng: dest.lng,
        destLabel: dest.label,
        distanceKm: dispatch.distance_km,
        durationMin: routeDurationMin ?? Math.max(2, Math.round((dispatch.distance_km / 28) * 60)),
        baseFare: dispatch.base_fare,
        perKmRate: dispatch.per_km_rate,
        fareInr: dispatch.fare_inr,
        driverName: dispatch.driver_name,
        driverPhone: dispatch.driver_phone,
        plateNumber: dispatch.plate_number,
      });

      await onBookingsChanged();
      setActiveDispatchId(docId);
      onToast(`Ride ${dispatch.booking_code} confirmed & saved to SQLite database.`);
    } catch (err) {
      onToast(
        err instanceof Error ? err.message : 'Unable to save booking right now.',
        'error'
      );
    } finally {
      setIsBooking(false);
    }
  };

  const handleActiveStatusChange = async (nextStatus: 'completed' | 'cancelled') => {
    if (!activeBooking) return;
    setIsUpdatingStatus(true);
    try {
      await updateBookingStatus(activeBooking.id, nextStatus);
      await onBookingsChanged();
      onToast(
        nextStatus === 'completed'
          ? `Trip ${activeBooking.bookingCode} marked completed.`
          : `Booked taxi ${activeBooking.bookingCode} cancelled.`
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Status update failed.', 'error');
    } finally {
      setIsUpdatingStatus(false);
    }
  };

  const handleCancelBookingById = async (booking: BookingRecord) => {
    setCancellingId(booking.id);
    try {
      await updateBookingStatus(booking.id, 'cancelled');
      await onBookingsChanged();
      onToast(`Booked taxi ${booking.bookingCode} cancelled.`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Unable to cancel booking.', 'error');
    } finally {
      setCancellingId(null);
    }
  };

  const renderTierIcon = (tier: VehicleTier) => {
    if (tier === 'bike') return <Bike className="w-4 h-4" />;
    if (tier === 'car') return <Car className="w-4 h-4" />;
    return <Navigation className="w-4 h-4" />;
  };

  return (
    <div className="flex flex-col lg:grid lg:grid-cols-[430px_1fr] lg:h-[calc(100dvh-64px)] bg-[#090d16]">
      {/* Mobile & Tablet View Switcher */}
      <div
        role="tablist"
        aria-label="Workspace view"
        className="lg:hidden sticky top-[109px] md:top-16 z-[1040] flex items-center gap-1 p-1.5 bg-[#0f172a]/95 backdrop-blur border-b border-slate-800"
      >
        <button
          type="button"
          role="tab"
          aria-selected={mobilePane === 'form'}
          onClick={() => setMobilePane('form')}
          className={`flex-1 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${
            mobilePane === 'form' ? 'bg-amber-500 text-slate-950' : 'text-slate-300 hover:text-white'
          }`}
        >
          Ride Dispatch Form
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mobilePane === 'map'}
          onClick={() => setMobilePane('map')}
          className={`flex-1 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${
            mobilePane === 'map' ? 'bg-amber-500 text-slate-950' : 'text-slate-300 hover:text-white'
          }`}
        >
          Interactive Map{pickup && dest ? ' ✓' : ''}
        </button>
      </div>

      {/* Left Sidebar: Route Builder & Dispatch */}
      <aside
        className={`${
          mobilePane === 'form' ? 'flex' : 'hidden lg:flex'
        } flex-col gap-5 bg-[#0f172a]/90 lg:border-r border-slate-800/80 p-4 sm:p-5 lg:overflow-y-auto dispatch-scroll`}
      >
        {/* City Corridors */}
        <section className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-slate-300 tracking-wide">
              Quick City Corridors
            </h2>
            {(pickup || dest) && (
              <button
                type="button"
                onClick={handleResetRoute}
                className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {CITY_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => handleApplyPreset(preset)}
                className="text-left px-3 py-2 rounded-lg bg-[#090d16] border border-slate-800 hover:border-amber-500/60 transition-colors cursor-pointer"
              >
                <div className="text-xs font-semibold text-slate-100 truncate">{preset.name}</div>
                <div className="text-[11px] text-slate-400 truncate">{preset.corridor}</div>
              </button>
            ))}
          </div>
        </section>

        {/* Pickup & Destination Card */}
        <section className="bg-[#090d16] border border-slate-800 rounded-xl p-4 space-y-3 relative">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-300">Route Endpoints</span>
            <button
              type="button"
              onClick={handleSwapRoute}
              disabled={!pickup || !dest}
              title="Swap pickup and destination"
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-800 bg-slate-900 text-xs font-medium text-slate-300 hover:text-amber-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              <ArrowUpDown className="w-3.5 h-3.5" />
              Swap
            </button>
          </div>

          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <span className="w-6 h-6 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                P
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-slate-400">Pickup Location</div>
                <div className="text-sm font-medium text-slate-100 truncate">
                  {pickup ? pickup.label : 'Tap map to set pickup'}
                </div>
                {pickup && (
                  <div className="text-[11px] font-mono-tabular text-slate-500">
                    {formatCoordsLabel(pickup.lat, pickup.lng)}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  setClickStep('pickup');
                  setMobilePane('map');
                }}
                className="lg:hidden shrink-0 px-2.5 py-1 rounded-md border border-slate-800 bg-slate-900 text-[11px] font-medium text-amber-400 cursor-pointer"
              >
                {pickup ? 'Edit' : 'Pin'}
              </button>
            </div>

            <div className="border-t border-slate-800/80" />

            <div className="flex items-start gap-3">
              <span className="w-6 h-6 rounded-md bg-red-500/15 border border-red-500/30 text-red-400 text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                D
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-slate-400">Destination Location</div>
                <div className="text-sm font-medium text-slate-100 truncate">
                  {dest ? dest.label : 'Tap map to set destination'}
                </div>
                {dest && (
                  <div className="text-[11px] font-mono-tabular text-slate-500">
                    {formatCoordsLabel(dest.lat, dest.lng)}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  setClickStep('dest');
                  setMobilePane('map');
                }}
                className="lg:hidden shrink-0 px-2.5 py-1 rounded-md border border-slate-800 bg-slate-900 text-[11px] font-medium text-amber-400 cursor-pointer"
              >
                {dest ? 'Edit' : 'Pin'}
              </button>
            </div>
          </div>
        </section>

        {/* Passenger Details */}
        <section className="space-y-3">
          <h2 className="text-xs font-semibold text-slate-300 tracking-wide">
            Passenger Contact
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label htmlFor="passenger-name" className="block text-xs text-slate-400">
                Full Name
              </label>
              <div className="relative">
                <UserIcon className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="passenger-name"
                  type="text"
                  maxLength={BLUEPRINT_LIMITS.DISPLAY_NAME_MAX}
                  value={passengerName}
                  onChange={(e) => setPassengerName(e.target.value)}
                  placeholder="Rohan Sharma"
                  className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#090d16] border border-slate-800 focus:border-amber-500 focus:outline-none text-base sm:text-sm text-slate-100 placeholder:text-slate-600"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label htmlFor="passenger-phone" className="block text-xs text-slate-400">
                Phone Number
              </label>
              <div className="relative">
                <Phone className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="passenger-phone"
                  type="tel"
                  maxLength={BLUEPRINT_LIMITS.PHONE_MAX}
                  value={passengerPhone}
                  onChange={(e) => setPassengerPhone(e.target.value)}
                  placeholder="+91 98765 43210"
                  className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#090d16] border border-slate-800 focus:border-amber-500 focus:outline-none text-base sm:text-sm text-slate-100 font-mono-tabular placeholder:text-slate-600"
                />
              </div>
            </div>
          </div>
          {(!isNameValid || !isPhoneValid) && (
            <p className="text-xs text-slate-400">
              Enter both full name and a phone number (min 6 chars) to dispatch a ride.
            </p>
          )}
        </section>

        {/* Vehicle Tier Selector */}
        <section className="space-y-2.5">
          <h2 className="text-xs font-semibold text-slate-300 tracking-wide">
            Select Vehicle Tier
          </h2>
          <div className="grid grid-cols-3 gap-1.5 sm:gap-2">
            {VEHICLE_TIERS.map((tier) => {
              const isSelected = selectedVehicle === tier.id;
              const quote = tierQuotes ? tierQuotes[tier.id] : null;
              return (
                <button
                  key={tier.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => setSelectedVehicle(tier.id)}
                  className={`p-2.5 sm:p-3 rounded-xl border text-left transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
                    isSelected
                      ? 'bg-amber-500/12 border-amber-500 text-slate-50'
                      : 'bg-[#090d16] border-slate-800 text-slate-300 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className={isSelected ? 'text-amber-400' : 'text-slate-400'}>
                      {renderTierIcon(tier.id)}
                    </span>
                    <span className="text-[10px] sm:text-[11px] text-slate-400">{tier.seats}</span>
                  </div>
                  <div className="text-xs font-bold text-slate-100 truncate">{tier.name}</div>
                  <div className="text-[10px] sm:text-[11px] font-mono-tabular text-slate-400 mt-0.5 truncate">
                    ₹{tier.baseFare} + ₹{tier.perKmRate}/km
                  </div>
                  <div className="text-sm font-mono-tabular font-bold text-amber-400 mt-2">
                    {quote ? `₹${quote.fareInr.toFixed(0)}` : '—'}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* Live Fare Breakdown */}
        <section className="bg-[#090d16] border border-slate-800 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-slate-300">Fare Breakdown</h2>
            {isRouting && (
              <span className="inline-flex items-center gap-1.5 text-xs text-amber-400">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Routing…
              </span>
            )}
          </div>

          {!pickup || !dest || !selectedQuote ? (
            <div className="py-4 text-center space-y-1.5">
              <MapPin className="w-5 h-5 text-slate-500 mx-auto" />
              <p className="text-xs text-slate-400">
                Select a corridor preset or place both pins on the map to view live road distance and fare.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 pb-3 border-b border-slate-800/80">
                <div>
                  <div className="text-[11px] text-slate-400">Road Distance</div>
                  <div className="text-base font-mono-tabular font-bold text-slate-100">
                    {routeDistanceKm?.toFixed(2)} km
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-slate-400">Est. Duration</div>
                  <div className="text-base font-mono-tabular font-bold text-slate-100">
                    {routeDurationMin !== null ? formatDurationMinutes(routeDurationMin) : '—'}
                  </div>
                </div>
              </div>

              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between text-slate-400">
                  <span>Base Booking Fee</span>
                  <span className="font-mono-tabular text-slate-200">
                    ₹{selectedQuote.baseFare.toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Distance Charge (₹{selectedQuote.perKmRate}/km)</span>
                  <span className="font-mono-tabular text-slate-200">
                    ₹{(selectedQuote.fareInr - selectedQuote.baseFare).toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between items-baseline pt-2 border-t border-slate-800/80">
                  <span className="text-sm font-semibold text-slate-100">Total Payable</span>
                  <span className="text-xl font-mono-tabular font-bold text-amber-400">
                    ₹{selectedQuote.fareInr.toFixed(2)}
                  </span>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Active Dispatched Driver Card */}
        {activeBooking && (
          <section
            className={`bg-[#090d16] rounded-xl p-4 space-y-3 border ${
              activeBooking.status === 'cancelled'
                ? 'border-red-500/40'
                : activeBooking.status === 'completed'
                  ? 'border-emerald-500/40'
                  : 'border-amber-500/40'
            }`}
          >
            <div className="flex items-center justify-between text-xs">
              <span
                className={`font-mono-tabular font-bold ${
                  activeBooking.status === 'cancelled'
                    ? 'text-red-400'
                    : activeBooking.status === 'completed'
                      ? 'text-emerald-400'
                      : 'text-amber-400'
                }`}
              >
                {activeBooking.bookingCode} · {activeBooking.status.toUpperCase()}
              </span>
              <span className="font-mono-tabular text-slate-300">
                ₹{activeBooking.fareInr.toFixed(0)}
              </span>
            </div>

            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-bold text-slate-100">{activeBooking.driverName}</div>
                <div className="text-xs text-slate-400">
                  Captain Contact · <span className="font-mono-tabular">{activeBooking.driverPhone}</span>
                </div>
              </div>
              <div className="px-2.5 py-1 rounded bg-slate-900 border border-slate-700 text-xs font-mono-tabular font-bold text-amber-400 whitespace-nowrap">
                {activeBooking.plateNumber}
              </div>
            </div>

            {activeBooking.status === 'dispatched' && (
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  disabled={isUpdatingStatus}
                  onClick={() => handleActiveStatusChange('completed')}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white transition-colors cursor-pointer disabled:opacity-50"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Complete Ride
                </button>
                <button
                  type="button"
                  disabled={isUpdatingStatus}
                  onClick={() => handleActiveStatusChange('cancelled')}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-red-500/50 bg-red-950/50 hover:bg-red-900/60 text-xs font-semibold text-red-200 transition-colors cursor-pointer disabled:opacity-50"
                >
                  <XCircle className="w-3.5 h-3.5" />
                  {isUpdatingStatus ? 'Cancelling…' : 'Cancel Taxi'}
                </button>
              </div>
            )}
          </section>
        )}

        {/* Primary Action Button */}
        <div className="space-y-2">
          <button
            type="button"
            disabled={!canConfirm}
            onClick={handleConfirmBooking}
            className="w-full flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed text-slate-950 font-bold text-sm transition-colors cursor-pointer"
          >
            {isBooking ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Dispatching Captain…
              </>
            ) : !pickup || !dest ? (
              'Select Pickup & Destination'
            ) : !isNameValid || !isPhoneValid ? (
              'Enter Passenger Name & Phone'
            ) : (
              `Confirm & Book ${selectedVehicle.toUpperCase()} · ₹${selectedQuote?.fareInr.toFixed(0)}`
            )}
          </button>

          {activeBooking?.status === 'dispatched' && (
            <button
              type="button"
              disabled={isUpdatingStatus}
              onClick={() => handleActiveStatusChange('cancelled')}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-red-500/40 bg-red-950/40 hover:bg-red-900/55 text-xs font-semibold text-red-200 transition-colors cursor-pointer disabled:opacity-50"
            >
              <XCircle className="w-3.5 h-3.5" />
              {isUpdatingStatus
                ? 'Cancelling Booked Taxi…'
                : `Cancel Booked Taxi (${activeBooking.bookingCode})`}
            </button>
          )}

          {activeBooking && (
            <button
              type="button"
              onClick={handleResetRoute}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-slate-700 hover:bg-slate-800 text-xs font-semibold text-slate-200 transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Book Another Ride
            </button>
          )}
        </div>

        {/* Recent Saved Trips Preview */}
        <section className="pt-3 border-t border-slate-800/80 space-y-2.5">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-slate-300">
              Recent Saved Trips ({bookings.length})
            </h2>
            <button
              type="button"
              onClick={onOpenHistory}
              className="text-xs font-medium text-amber-400 hover:text-amber-300 cursor-pointer"
            >
              View All
            </button>
          </div>

          {bookings.length === 0 ? (
            <p className="text-xs text-slate-500">
              No saved bookings yet. Your confirmed rides will sync here from the SQLite database.
            </p>
          ) : (
            <div className="space-y-2">
              {bookings.slice(0, 3).map((item) => (
                <div
                  key={item.id}
                  className="p-3 rounded-lg bg-[#090d16] border border-slate-800/90 space-y-1.5"
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono-tabular font-semibold text-slate-200">
                      {item.bookingCode} · {item.vehicle.toUpperCase()}
                    </span>
                    <span className="font-mono-tabular font-bold text-amber-400">
                      ₹{item.fareInr.toFixed(0)}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400 truncate">
                    {item.pickupLabel} → {item.destLabel}
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                    <span className="truncate">{item.driverName} · {item.plateNumber}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      <span
                        className={
                          item.status === 'completed'
                            ? 'text-emerald-400'
                            : item.status === 'cancelled'
                              ? 'text-red-400'
                              : 'text-amber-400'
                        }
                      >
                        {item.status}
                      </span>
                      {item.status === 'dispatched' && (
                        <button
                          type="button"
                          disabled={cancellingId === item.id}
                          onClick={() => handleCancelBookingById(item)}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-red-500/40 bg-red-950/40 hover:bg-red-900/60 text-red-300 text-[11px] font-medium transition-colors cursor-pointer disabled:opacity-50"
                        >
                          <XCircle className="w-3 h-3" />
                          {cancellingId === item.id ? 'Cancelling…' : 'Cancel Taxi'}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </aside>

      {/* Right Viewport: Interactive India Map */}
      <section
        className={`${
          mobilePane === 'map' ? 'flex' : 'hidden lg:flex'
        } flex-1 min-h-[calc(100dvh-165px)] lg:min-h-0 relative`}
      >
        <IndiaMap
          pickup={pickup}
          dest={dest}
          routeGeoJson={routeGeoJson}
          routeDistanceKm={routeDistanceKm}
          routeDurationMin={routeDurationMin}
          routeSource={routeSource}
          onMapClickPoint={handleMapClickPoint}
          onMarkerDragEnd={handleMarkerDragEnd}
        />

        {pickup && dest && (
          <button
            type="button"
            onClick={() => setMobilePane('form')}
            className="lg:hidden absolute top-16 left-1/2 -translate-x-1/2 z-[950] px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold shadow-xl whitespace-nowrap cursor-pointer"
          >
            {selectedQuote
              ? `Done · Book ${selectedVehicle.toUpperCase()} (₹${selectedQuote.fareInr.toFixed(0)})`
              : 'Back to Ride Form'}
          </button>
        )}
      </section>
    </div>
  );
}
