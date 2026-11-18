import { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  MapPin,
  RotateCcw,
  Search,
  Trash2,
  XCircle,
} from 'lucide-react';
import { formatDurationMinutes } from '../constants/mobility';
import { removeBookingRecord, updateBookingStatus } from '../api';
import type { BookingRecord, BookingStatus, LatLngPoint, VehicleTier } from '../types';

interface TripHistoryViewProps {
  bookings: BookingRecord[];
  isLoading: boolean;
  onBookingsChanged: () => Promise<void>;
  onRebook: (pickup: LatLngPoint, dest: LatLngPoint, vehicle: VehicleTier) => void;
  onStartBooking: () => void;
  onToast: (message: string, tone?: 'success' | 'error') => void;
}

export function TripHistoryView({
  bookings,
  isLoading,
  onBookingsChanged,
  onRebook,
  onStartBooking,
  onToast,
}: TripHistoryViewProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | BookingStatus>('all');
  const [vehicleFilter, setVehicleFilter] = useState<'all' | VehicleTier>('all');
  const [busyId, setBusyId] = useState<string | null>(null);

  const metrics = useMemo(() => {
    const totalTrips = bookings.length;
    const activeTrips = bookings.filter((b) => b.status === 'dispatched').length;
    const totalDistance = bookings.reduce((sum, b) => sum + (b.distanceKm || 0), 0);
    const totalSpend = bookings
      .filter((b) => b.status !== 'cancelled')
      .reduce((sum, b) => sum + (b.fareInr || 0), 0);
    return { totalTrips, activeTrips, totalDistance, totalSpend };
  }, [bookings]);

  const filteredBookings = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return bookings.filter((b) => {
      if (statusFilter !== 'all' && b.status !== statusFilter) return false;
      if (vehicleFilter !== 'all' && b.vehicle !== vehicleFilter) return false;
      if (!q) return true;
      return (
        b.bookingCode.toLowerCase().includes(q) ||
        b.pickupLabel.toLowerCase().includes(q) ||
        b.destLabel.toLowerCase().includes(q) ||
        b.driverName.toLowerCase().includes(q) ||
        b.plateNumber.toLowerCase().includes(q) ||
        b.passengerName.toLowerCase().includes(q)
      );
    });
  }, [bookings, searchTerm, statusFilter, vehicleFilter]);

  const handleStatusUpdate = async (
    id: string,
    code: string,
    nextStatus: 'completed' | 'cancelled'
  ) => {
    setBusyId(id);
    try {
      await updateBookingStatus(id, nextStatus);
      await onBookingsChanged();
      onToast(`${code} updated to ${nextStatus}.`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Unable to update trip status.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (id: string, code: string) => {
    setBusyId(id);
    try {
      await removeBookingRecord(id);
      await onBookingsChanged();
      onToast(`Removed ${code} from trip history.`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Unable to delete record.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const renderStatus = (status: BookingStatus) => {
    if (status === 'completed') {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Completed
        </span>
      );
    }
    if (status === 'cancelled') {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-400">
          <XCircle className="w-3.5 h-3.5" />
          Cancelled
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-400">
        <Clock className="w-3.5 h-3.5" />
        Dispatched
      </span>
    );
  };

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-8 py-8 space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-50">
            Trip History &amp; Dispatch Ledger
          </h1>
          <p className="text-sm text-slate-400">
            Persistent bookings stored in SQLite database for your signed-in account.
          </p>
        </div>
        <button
          type="button"
          onClick={onStartBooking}
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-sm font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <MapPin className="w-4 h-4" />
          New Ride Booking
        </button>
      </div>

      {/* Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-slate-800 border border-slate-800 rounded-xl overflow-hidden">
        <div className="bg-[#0f172a] p-4 sm:p-5">
          <div className="text-xs text-slate-400">Total Saved Rides</div>
          <div className="text-xl sm:text-2xl font-mono-tabular font-bold text-slate-50 mt-1">
            {metrics.totalTrips}
          </div>
        </div>
        <div className="bg-[#0f172a] p-4 sm:p-5">
          <div className="text-xs text-slate-400">Active Dispatches</div>
          <div className="text-xl sm:text-2xl font-mono-tabular font-bold text-amber-400 mt-1">
            {metrics.activeTrips}
          </div>
        </div>
        <div className="bg-[#0f172a] p-4 sm:p-5">
          <div className="text-xs text-slate-400">Total Distance</div>
          <div className="text-xl sm:text-2xl font-mono-tabular font-bold text-slate-50 mt-1">
            {metrics.totalDistance.toFixed(1)} km
          </div>
        </div>
        <div className="bg-[#0f172a] p-4 sm:p-5">
          <div className="text-xs text-slate-400">Cumulative Fare</div>
          <div className="text-xl sm:text-2xl font-mono-tabular font-bold text-emerald-400 mt-1">
            ₹{metrics.totalSpend.toFixed(0)}
          </div>
        </div>
      </div>

      {/* Filters & Search Toolbar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 sm:gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            aria-label="Search booking code, route, captain, or plate"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search booking code, route, captain, or plate…"
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#0f172a] border border-slate-800 focus:border-amber-500 focus:outline-none text-base sm:text-sm text-slate-100 placeholder:text-slate-500"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <div
            role="group"
            aria-label="Filter by booking status"
            className="flex items-center gap-1 p-1 bg-[#0f172a] border border-slate-800 rounded-lg overflow-x-auto max-w-full"
          >
            {(['all', 'dispatched', 'completed', 'cancelled'] as const).map((status) => (
              <button
                key={status}
                type="button"
                aria-pressed={statusFilter === status}
                onClick={() => setStatusFilter(status)}
                className={`px-2.5 sm:px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-colors whitespace-nowrap cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
                  statusFilter === status
                    ? 'bg-amber-500 text-slate-950 font-semibold'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {status}
              </button>
            ))}
          </div>

          <div
            role="group"
            aria-label="Filter by vehicle tier"
            className="flex items-center gap-1 p-1 bg-[#0f172a] border border-slate-800 rounded-lg overflow-x-auto max-w-full"
          >
            {(['all', 'bike', 'auto', 'car'] as const).map((tier) => (
              <button
                key={tier}
                type="button"
                aria-pressed={vehicleFilter === tier}
                onClick={() => setVehicleFilter(tier)}
                className={`px-2.5 sm:px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-colors whitespace-nowrap cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
                  vehicleFilter === tier
                    ? 'bg-slate-800 text-slate-50'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {tier === 'all' ? 'All Tiers' : tier}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Data Table / States */}
      {isLoading ? (
        <div className="border border-slate-800 rounded-xl bg-[#0f172a] divide-y divide-slate-800">
          {[1, 2, 3].map((row) => (
            <div key={row} className="p-5 flex items-center justify-between gap-4 animate-pulse">
              <div className="space-y-2 flex-1">
                <div className="h-4 w-48 bg-slate-800 rounded" />
                <div className="h-3 w-80 bg-slate-800/70 rounded" />
              </div>
              <div className="h-6 w-24 bg-slate-800 rounded" />
            </div>
          ))}
        </div>
      ) : bookings.length === 0 ? (
        <div className="border border-slate-800 rounded-xl bg-[#0f172a] p-12 text-center space-y-3">
          <MapPin className="w-8 h-8 text-slate-500 mx-auto" />
          <h2 className="text-lg font-semibold text-slate-100">No bookings in your database yet</h2>
          <p className="text-sm text-slate-400 max-w-md mx-auto">
            Plot a pickup and destination on the India map to calculate live OSRM road fares and dispatch your first captain.
          </p>
          <button
            type="button"
            onClick={onStartBooking}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-sm font-semibold transition-colors cursor-pointer"
          >
            Book First Ride
          </button>
        </div>
      ) : filteredBookings.length === 0 ? (
        <div className="border border-slate-800 rounded-xl bg-[#0f172a] p-10 text-center space-y-2">
          <p className="text-sm font-medium text-slate-200">No rides match your current filters.</p>
          <button
            type="button"
            onClick={() => {
              setSearchTerm('');
              setStatusFilter('all');
              setVehicleFilter('all');
            }}
            className="text-xs font-semibold text-amber-400 hover:text-amber-300 cursor-pointer"
          >
            Reset search &amp; filters
          </button>
        </div>
      ) : (
        <>
          {/* Mobile Card Ledger */}
          <div className="md:hidden space-y-3">
            {filteredBookings.map((b) => {
              const parsedDate = b.createdAt ? new Date(b.createdAt) : null;
              const timestampLabel =
                parsedDate && !Number.isNaN(parsedDate.getTime())
                  ? parsedDate.toLocaleString([], {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : 'Just now';

              return (
                <article
                  key={b.id}
                  className="bg-[#0f172a] border border-slate-800 rounded-xl p-4 space-y-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-mono-tabular font-bold text-sm text-slate-100">
                        {b.bookingCode}
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5">
                        {b.vehicle.toUpperCase()} · {timestampLabel}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono-tabular font-bold text-base text-amber-400">
                        ₹{b.fareInr.toFixed(2)}
                      </div>
                      <div className="mt-0.5 flex justify-end">{renderStatus(b.status)}</div>
                    </div>
                  </div>

                  <div className="bg-[#090d16] border border-slate-800/80 rounded-lg p-3 space-y-1 text-xs">
                    <div className="text-slate-200 font-medium truncate">{b.pickupLabel}</div>
                    <div className="text-slate-400 truncate">→ {b.destLabel}</div>
                  </div>

                  <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
                    <div className="truncate">
                      <span className="text-slate-200 font-medium">{b.driverName}</span>
                      {' · '}
                      <span className="font-mono-tabular text-amber-400">{b.plateNumber}</span>
                    </div>
                    <div className="font-mono-tabular shrink-0">
                      {b.distanceKm.toFixed(1)} km · {formatDurationMinutes(b.durationMin)}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-800/80">
                    {b.status === 'dispatched' && (
                      <>
                        <button
                          type="button"
                          disabled={busyId === b.id}
                          onClick={() => handleStatusUpdate(b.id, b.bookingCode, 'completed')}
                          className="flex-1 min-w-[100px] py-2 px-3 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/35 text-emerald-300 text-xs font-semibold transition-colors cursor-pointer disabled:opacity-40"
                        >
                          Complete
                        </button>
                        <button
                          type="button"
                          disabled={busyId === b.id}
                          onClick={() => handleStatusUpdate(b.id, b.bookingCode, 'cancelled')}
                          className="flex-1 min-w-[115px] inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg border border-red-500/40 bg-red-950/40 hover:bg-red-900/60 text-red-300 text-xs font-semibold transition-colors cursor-pointer disabled:opacity-40"
                        >
                          <XCircle className="w-3.5 h-3.5" />
                          {busyId === b.id ? 'Cancelling…' : 'Cancel Taxi'}
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        onRebook(
                          { lat: b.pickupLat, lng: b.pickupLng, label: b.pickupLabel },
                          { lat: b.destLat, lng: b.destLng, label: b.destLabel },
                          b.vehicle
                        )
                      }
                      className="inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg border border-slate-700 hover:border-amber-500/60 text-xs font-medium text-slate-300 hover:text-amber-300 transition-colors cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Rebook
                    </button>
                    <button
                      type="button"
                      disabled={busyId === b.id}
                      onClick={() => handleDelete(b.id, b.bookingCode)}
                      aria-label={`Delete ${b.bookingCode}`}
                      className="p-2 rounded-lg border border-slate-800 text-slate-400 hover:text-red-400 transition-colors cursor-pointer disabled:opacity-40 ml-auto"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>

          {/* Desktop & Tablet Data Table */}
          <div className="hidden md:block border border-slate-800 rounded-xl bg-[#0f172a] overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <th className="py-3.5 px-4">Booking</th>
                  <th className="py-3.5 px-4">Corridor</th>
                  <th className="py-3.5 px-4">Captain &amp; Plate</th>
                  <th className="py-3.5 px-4 text-right">Distance</th>
                  <th className="py-3.5 px-4 text-right">Fare</th>
                  <th className="py-3.5 px-4">Status</th>
                  <th className="py-3.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80 text-sm">
                {filteredBookings.map((b) => {
                  const parsedDate = b.createdAt ? new Date(b.createdAt) : null;
                  const timestampLabel =
                    parsedDate && !Number.isNaN(parsedDate.getTime())
                      ? parsedDate.toLocaleString([], {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      : 'Just now';

                  return (
                    <tr key={b.id} className="hover:bg-slate-900/60 transition-colors">
                      <td className="py-3.5 px-4 align-top whitespace-nowrap">
                        <div className="font-mono-tabular font-bold text-slate-100">
                          {b.bookingCode}
                        </div>
                        <div className="text-xs text-slate-400 mt-0.5">
                          {b.vehicle.toUpperCase()} · {timestampLabel}
                        </div>
                      </td>

                      <td className="py-3.5 px-4 align-top max-w-[280px]">
                        <div className="text-xs font-medium text-slate-200 truncate">
                          {b.pickupLabel}
                        </div>
                        <div className="text-xs text-slate-400 truncate mt-0.5">
                          → {b.destLabel}
                        </div>
                      </td>

                      <td className="py-3.5 px-4 align-top whitespace-nowrap">
                        <div className="text-xs font-medium text-slate-200">{b.driverName}</div>
                        <div className="text-xs font-mono-tabular text-amber-400 mt-0.5">
                          {b.plateNumber}
                        </div>
                      </td>

                      <td className="py-3.5 px-4 align-top text-right whitespace-nowrap font-mono-tabular">
                        <div className="text-xs font-semibold text-slate-200">
                          {b.distanceKm.toFixed(1)} km
                        </div>
                        <div className="text-xs text-slate-400 mt-0.5">
                          {formatDurationMinutes(b.durationMin)}
                        </div>
                      </td>

                      <td className="py-3.5 px-4 align-top text-right whitespace-nowrap font-mono-tabular font-bold text-amber-400">
                        ₹{b.fareInr.toFixed(2)}
                      </td>

                      <td className="py-3.5 px-4 align-top whitespace-nowrap">
                        {renderStatus(b.status)}
                      </td>

                      <td className="py-3.5 px-4 align-top text-right whitespace-nowrap">
                        <div className="inline-flex items-center justify-end gap-2">
                          {b.status === 'dispatched' && (
                            <>
                              <button
                                type="button"
                                disabled={busyId === b.id}
                                onClick={() => handleStatusUpdate(b.id, b.bookingCode, 'completed')}
                                className="px-2.5 py-1 rounded bg-emerald-600/20 hover:bg-emerald-600/35 text-emerald-300 text-xs font-medium transition-colors cursor-pointer disabled:opacity-40"
                              >
                                Complete
                              </button>
                              <button
                                type="button"
                                disabled={busyId === b.id}
                                onClick={() => handleStatusUpdate(b.id, b.bookingCode, 'cancelled')}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-red-500/40 bg-red-950/40 hover:bg-red-900/60 text-red-300 text-xs font-medium transition-colors cursor-pointer disabled:opacity-40"
                              >
                                <XCircle className="w-3 h-3" />
                                {busyId === b.id ? 'Cancelling…' : 'Cancel Taxi'}
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              onRebook(
                                { lat: b.pickupLat, lng: b.pickupLng, label: b.pickupLabel },
                                { lat: b.destLat, lng: b.destLng, label: b.destLabel },
                                b.vehicle
                              )
                            }
                            title="Load this route back on the map"
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-700 hover:border-amber-500/60 text-xs text-slate-300 hover:text-amber-300 transition-colors cursor-pointer"
                          >
                            <RotateCcw className="w-3 h-3" />
                            Rebook
                          </button>
                          <button
                            type="button"
                            disabled={busyId === b.id}
                            onClick={() => handleDelete(b.id, b.bookingCode)}
                            title="Delete booking record"
                            className="p-1.5 rounded text-slate-500 hover:text-red-400 transition-colors cursor-pointer disabled:opacity-40"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
