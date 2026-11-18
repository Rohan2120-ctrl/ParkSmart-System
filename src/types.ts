export type VehicleTier = 'bike' | 'auto' | 'car';
export type BookingStatus = 'dispatched' | 'completed' | 'cancelled';
export type AppTab = 'book' | 'history' | 'fares';

export interface LatLngPoint {
  lat: number;
  lng: number;
  label: string;
}

export interface TierQuote {
  vehicle: VehicleTier;
  baseFare: number;
  perKmRate: number;
  fareInr: number;
}

export interface FareCalculationResponse {
  booking_code: string;
  distance_km: number;
  fare_inr: number;
  base_fare: number;
  per_km_rate: number;
  vehicle: VehicleTier;
  driver_name: string;
  driver_phone: string;
  plate_number: string;
  tier_quotes: Record<VehicleTier, TierQuote>;
}

export interface UserProfile {
  uid: string;
  displayName: string;
  email: string;
  defaultPhone: string;
  role: 'rider';
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface BookingRecord {
  id: string;
  userId: string;
  bookingCode: string;
  passengerName: string;
  passengerPhone: string;
  vehicle: VehicleTier;
  pickupLat: number;
  pickupLng: number;
  pickupLabel: string;
  destLat: number;
  destLng: number;
  destLabel: string;
  distanceKm: number;
  durationMin: number;
  baseFare: number;
  perKmRate: number;
  fareInr: number;
  driverName: string;
  driverPhone: string;
  plateNumber: string;
  status: BookingStatus;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface CityPreset {
  id: string;
  name: string;
  corridor: string;
  pickup: LatLngPoint;
  dest: LatLngPoint;
}
