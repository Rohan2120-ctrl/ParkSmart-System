import type { CityPreset, VehicleTier } from '../types';

export const VEHICLE_TIERS: {
  id: VehicleTier;
  name: string;
  seats: string;
  baseFare: number;
  perKmRate: number;
  summary: string;
}[] = [
  {
    id: 'bike',
    name: 'Bike Moto',
    seats: '1 Seat',
    baseFare: 20,
    perKmRate: 8,
    summary: 'Quick solo lane-filtering commute across dense city traffic.',
  },
  {
    id: 'auto',
    name: 'Auto Rickshaw',
    seats: '3 Seats',
    baseFare: 30,
    perKmRate: 12,
    summary: 'Open-air three-wheeler ideal for short and mid-range hops.',
  },
  {
    id: 'car',
    name: 'Car AC',
    seats: '4 Seats',
    baseFare: 50,
    perKmRate: 18,
    summary: 'Climate-controlled sedan or hatchback for longer corridors.',
  },
];

export const CITY_PRESETS: CityPreset[] = [
  {
    id: 'delhi',
    name: 'Delhi NCR',
    corridor: 'Connaught Place to Noida Sec 18',
    pickup: { lat: 28.6315, lng: 77.2167, label: 'Connaught Place, New Delhi' },
    dest: { lat: 28.5708, lng: 77.3271, label: 'Noida Sector 18, UP' },
  },
  {
    id: 'mumbai',
    name: 'Mumbai Coast',
    corridor: 'Bandra West to Marine Drive',
    pickup: { lat: 19.0596, lng: 72.8295, label: 'Bandra West, Mumbai' },
    dest: { lat: 18.9432, lng: 72.8235, label: 'Marine Drive, Mumbai' },
  },
  {
    id: 'bengaluru',
    name: 'Bengaluru Tech',
    corridor: 'Koramangala to Indiranagar',
    pickup: { lat: 12.9352, lng: 77.6245, label: 'Koramangala 4th Block, Bengaluru' },
    dest: { lat: 12.9784, lng: 77.6408, label: 'Indiranagar 100ft Rd, Bengaluru' },
  },
  {
    id: 'hyderabad',
    name: 'Hyderabad Corridor',
    corridor: 'HITEC City to Charminar',
    pickup: { lat: 17.4435, lng: 78.3772, label: 'HITEC City, Hyderabad' },
    dest: { lat: 17.3616, lng: 78.4747, label: 'Charminar Old City, Hyderabad' },
  },
];

export const BLUEPRINT_LIMITS = {
  DISPLAY_NAME_MAX: 80,
  EMAIL_MAX: 160,
  PHONE_MIN: 6,
  PHONE_MAX: 24,
  PHOTO_URL_MAX: 500,
  LABEL_MAX: 160,
  BOOKING_CODE_MAX: 24,
  DRIVER_NAME_MAX: 80,
  PLATE_MAX: 24,
  MAX_DISTANCE_KM: 5000,
} as const;

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function formatCoordsLabel(lat: number, lng: number): string {
  return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}

export function formatDurationMinutes(minutes: number): string {
  const rounded = Math.max(1, Math.round(minutes));
  if (rounded < 60) {
    return `${rounded} min`;
  }
  const hrs = Math.floor(rounded / 60);
  const mins = rounded % 60;
  return mins === 0 ? `${hrs} hr` : `${hrs} hr ${mins} min`;
}
