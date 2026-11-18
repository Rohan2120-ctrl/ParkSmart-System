import { Bike, Car, MapPin, Navigation } from 'lucide-react';
import { VEHICLE_TIERS } from '../constants/mobility';

interface FareGuideViewProps {
  onStartBooking: () => void;
}

export function FareGuideView({ onStartBooking }: FareGuideViewProps) {
  const sampleDistances = [5, 15, 30];

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-8 py-8 space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-50">
            Transparent Fare Schedule
          </h1>
          <p className="text-sm text-slate-400 max-w-2xl">
            Every quote combines a fixed base booking fee and per-kilometer road distance computed via OSRM routing with Haversine geodesic fallback.
          </p>
        </div>
        <button
          type="button"
          onClick={onStartBooking}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-sm font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <MapPin className="w-4 h-4" />
          Open Dispatch Map
        </button>
      </div>

      {/* Tier Cards */}
      <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-4">
        {VEHICLE_TIERS.map((tier) => (
          <div
            key={tier.id}
            className="bg-[#0f172a] border border-slate-800 rounded-xl p-6 space-y-4"
          >
            <div className="flex items-center justify-between">
              <div className="text-amber-400">
                {tier.id === 'bike' ? (
                  <Bike className="w-5 h-5" />
                ) : tier.id === 'car' ? (
                  <Car className="w-5 h-5" />
                ) : (
                  <Navigation className="w-5 h-5" />
                )}
              </div>
              <span className="text-xs text-slate-400">{tier.seats}</span>
            </div>

            <div>
              <h2 className="text-lg font-bold text-slate-50">{tier.name}</h2>
              <p className="text-xs text-slate-400 mt-1 leading-relaxed">{tier.summary}</p>
            </div>

            <div className="pt-3 border-t border-slate-800 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-400">Base Fare</span>
                <span className="font-mono-tabular font-semibold text-slate-100">
                  ₹{tier.baseFare}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Distance Rate</span>
                <span className="font-mono-tabular font-semibold text-amber-400">
                  ₹{tier.perKmRate} / km
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Sample Fare Matrix */}
      <div className="bg-[#0f172a] border border-slate-800 rounded-xl overflow-x-auto">
        <div className="px-5 py-4 border-b border-slate-800">
          <h2 className="text-sm font-semibold text-slate-100">Distance Estimate Matrix</h2>
        </div>
        <table className="w-full text-left border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-xs text-slate-400 whitespace-nowrap">
              <th className="py-3 px-3.5 sm:px-5 font-medium">Vehicle Tier</th>
              <th className="py-3 px-3.5 sm:px-5 font-medium text-right">Formula</th>
              {sampleDistances.map((km) => (
                <th key={km} className="py-3 px-3.5 sm:px-5 font-medium text-right font-mono-tabular">
                  {km} km Trip
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/80 whitespace-nowrap">
            {VEHICLE_TIERS.map((tier) => (
              <tr key={tier.id}>
                <td className="py-3.5 px-3.5 sm:px-5 font-semibold text-slate-100">{tier.name}</td>
                <td className="py-3.5 px-3.5 sm:px-5 text-right font-mono-tabular text-xs text-slate-400">
                  ₹{tier.baseFare} + (₹{tier.perKmRate} × km)
                </td>
                {sampleDistances.map((km) => (
                  <td
                    key={km}
                    className="py-3.5 px-3.5 sm:px-5 text-right font-mono-tabular font-semibold text-amber-400"
                  >
                    ₹{tier.baseFare + tier.perKmRate * km}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
