import type { BookingRecord, UserProfile, VehicleTier } from './types';

const SESSION_STORAGE_KEY = 'taxibook_session_token';
let memoryToken: string | null = null;

function getStoredToken(): string | null {
  if (memoryToken) return memoryToken;
  try {
    const stored = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (stored) memoryToken = stored;
    return stored;
  } catch {
    return memoryToken;
  }
}

function setStoredToken(token: string | null): void {
  memoryToken = token;
  try {
    if (token) {
      window.localStorage.setItem(SESSION_STORAGE_KEY, token);
    } else {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  } catch {
    // Fallback to in-memory token when storage is restricted
  }
}

async function apiRequest<T>(url: string, options: RequestInit = {}): Promise<T> {
  const token = getStoredToken();
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(url, {
    ...options,
    headers,
    credentials: 'include',
  });

  const payload = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(payload.error || `Request failed (${res.status})`);
  }
  return payload;
}

export async function getCurrentUser(): Promise<UserProfile | null> {
  try {
    const res = await apiRequest<{ user: UserProfile | null }>('/api/auth/me');
    return res.user ?? null;
  } catch {
    setStoredToken(null);
    return null;
  }
}

export async function registerUser(input: {
  displayName: string;
  email: string;
  password: string;
}): Promise<UserProfile> {
  const res = await apiRequest<{ user: UserProfile; token?: string }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (res.token) setStoredToken(res.token);
  return res.user;
}

export async function loginUser(input: {
  email: string;
  password: string;
}): Promise<UserProfile> {
  const res = await apiRequest<{ user: UserProfile; token?: string }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (res.token) setStoredToken(res.token);
  return res.user;
}

export async function logoutUser(): Promise<void> {
  try {
    await apiRequest<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
  } finally {
    setStoredToken(null);
  }
}

export async function fetchBookings(): Promise<BookingRecord[]> {
  const res = await apiRequest<{ bookings: BookingRecord[] }>('/api/bookings');
  return Array.isArray(res.bookings) ? res.bookings : [];
}

export interface NewBookingPayload {
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
}

export async function createBookingRecord(payload: NewBookingPayload): Promise<string> {
  const res = await apiRequest<{ id: string }>('/api/bookings', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return res.id;
}

export async function updateBookingStatus(
  bookingId: string,
  status: 'completed' | 'cancelled'
): Promise<void> {
  await apiRequest<{ ok: boolean }>('/api/bookings/status', {
    method: 'POST',
    body: JSON.stringify({ id: bookingId, status }),
  });
}

export async function removeBookingRecord(bookingId: string): Promise<void> {
  await apiRequest<{ ok: boolean }>('/api/bookings/delete', {
    method: 'POST',
    body: JSON.stringify({ id: bookingId }),
  });
}
