import type { User } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { BookingRecord, BookingStatus, UserProfile, VehicleTier } from './types';

interface SupabaseUserRow {
  id: string;
  display_name: string | null;
  email: string;
  default_phone: string | null;
  role: 'rider' | null;
  created_at: string | null;
  updated_at: string | null;
}

interface SupabaseBookingRow {
  id: string;
  user_id: string;
  booking_code: string;
  passenger_name: string;
  passenger_phone: string;
  vehicle: VehicleTier;
  pickup_lat: number;
  pickup_lng: number;
  pickup_label: string;
  dest_lat: number;
  dest_lng: number;
  dest_label: string;
  distance_km: number;
  duration_min: number;
  base_fare: number;
  per_km_rate: number;
  fare_inr: number;
  driver_name: string;
  driver_phone: string;
  plate_number: string;
  status: BookingStatus;
  created_at: string | null;
  updated_at: string | null;
}

function formatSupabaseError(err: { code?: string; message?: string } | null, fallback: string): Error {
  if (!err) return new Error(fallback);
  if (
    err.code === 'PGRST205' ||
    err.code === '42P01' ||
    err.message?.includes('Could not find the table')
  ) {
    return new Error(
      'Supabase tables (users, bookings) are not created yet. Run schema.sql in your Supabase SQL Editor.'
    );
  }
  return new Error(err.message || fallback);
}

function mapUserFallback(authUser: User): UserProfile {
  const metaName =
    typeof authUser.user_metadata?.display_name === 'string'
      ? authUser.user_metadata.display_name
      : '';
  return {
    uid: authUser.id,
    displayName: metaName || authUser.email?.split('@')[0] || 'Rider',
    email: authUser.email || '',
    defaultPhone: '',
    role: 'rider',
    createdAt: authUser.created_at ?? null,
    updatedAt: null,
  };
}

function mapUserRow(row: SupabaseUserRow): UserProfile {
  return {
    uid: row.id,
    displayName: row.display_name || row.email.split('@')[0] || 'Rider',
    email: row.email,
    defaultPhone: row.default_phone || '',
    role: row.role || 'rider',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapBookingRow(row: SupabaseBookingRow): BookingRecord {
  return {
    id: row.id,
    userId: row.user_id,
    bookingCode: row.booking_code,
    passengerName: row.passenger_name,
    passengerPhone: row.passenger_phone,
    vehicle: row.vehicle,
    pickupLat: Number(row.pickup_lat),
    pickupLng: Number(row.pickup_lng),
    pickupLabel: row.pickup_label,
    destLat: Number(row.dest_lat),
    destLng: Number(row.dest_lng),
    destLabel: row.dest_label,
    distanceKm: Number(row.distance_km),
    durationMin: Number(row.duration_min),
    baseFare: Number(row.base_fare),
    perKmRate: Number(row.per_km_rate),
    fareInr: Number(row.fare_inr),
    driverName: row.driver_name,
    driverPhone: row.driver_phone,
    plateNumber: row.plate_number,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function syncUserRow(authUser: User, recordLoginTimestamp: boolean): Promise<UserProfile> {
  const fallback = mapUserFallback(authUser);
  const nowIso = new Date().toISOString();

  const { data: existing, error: selectErr } = await supabase
    .from('users')
    .select('*')
    .eq('id', authUser.id)
    .maybeSingle<SupabaseUserRow>();

  if (selectErr) {
    throw formatSupabaseError(selectErr, 'Unable to read user profile.');
  }

  if (existing) {
    if (recordLoginTimestamp) {
      const { data: updated, error: updateErr } = await supabase
        .from('users')
        .update({
          last_login_at: nowIso,
          updated_at: nowIso,
        })
        .eq('id', authUser.id)
        .select('*')
        .single<SupabaseUserRow>();

      if (updateErr) {
        throw formatSupabaseError(updateErr, 'Unable to update login timestamp.');
      }
      return mapUserRow(updated);
    }
    return mapUserRow(existing);
  }

  const { data: inserted, error: insertErr } = await supabase
    .from('users')
    .upsert(
      {
        id: authUser.id,
        display_name: fallback.displayName,
        email: fallback.email,
        default_phone: '',
        role: 'rider',
        last_login_at: recordLoginTimestamp ? nowIso : null,
        updated_at: nowIso,
      },
      { onConflict: 'id' }
    )
    .select('*')
    .single<SupabaseUserRow>();

  if (insertErr) {
    throw formatSupabaseError(insertErr, 'Unable to save user profile.');
  }
  return mapUserRow(inserted);
}

export async function getCurrentUser(): Promise<UserProfile | null> {
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();

  if (error || !session?.user) {
    return null;
  }

  try {
    return await syncUserRow(session.user, false);
  } catch {
    return mapUserFallback(session.user);
  }
}

export interface RegisterResult {
  user: UserProfile | null;
  requiresEmailConfirmation: boolean;
}

export async function registerUser(input: {
  displayName: string;
  email: string;
  password: string;
}): Promise<RegisterResult> {
  const { data, error } = await supabase.auth.signUp({
    email: input.email.trim(),
    password: input.password,
    options: {
      data: {
        display_name: input.displayName.trim(),
      },
    },
  });

  if (error) {
    throw new Error(error.message || 'Unable to create account.');
  }

  if (!data.user) {
    throw new Error('Signup did not return a user record.');
  }

  if (!data.session) {
    return {
      user: null,
      requiresEmailConfirmation: true,
    };
  }

  const profile = await syncUserRow(data.user, true);
  return {
    user: profile,
    requiresEmailConfirmation: false,
  };
}

export async function loginUser(input: {
  email: string;
  password: string;
}): Promise<UserProfile> {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: input.email.trim(),
    password: input.password,
  });

  if (error || !data.user) {
    throw new Error(error?.message || 'Invalid email or password.');
  }

  return await syncUserRow(data.user, true);
}

export async function logoutUser(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) {
    throw new Error(error.message || 'Sign out failed.');
  }
}

export async function fetchBookings(): Promise<BookingRecord[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    throw formatSupabaseError(error, 'Unable to load bookings from Supabase.');
  }

  return Array.isArray(data) ? (data as SupabaseBookingRow[]).map(mapBookingRow) : [];
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
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    throw new Error('Please sign in to confirm your booking.');
  }

  const nowIso = new Date().toISOString();

  // Ensure user row exists and remember passenger name + phone in public.users
  const { error: userSyncErr } = await supabase.from('users').upsert(
    {
      id: user.id,
      email: user.email || '',
      display_name: payload.passengerName,
      default_phone: payload.passengerPhone,
      role: 'rider',
      updated_at: nowIso,
    },
    { onConflict: 'id' }
  );

  if (userSyncErr) {
    throw formatSupabaseError(userSyncErr, 'Unable to sync rider profile in Supabase.');
  }

  const { data, error } = await supabase
    .from('bookings')
    .insert({
      user_id: user.id,
      booking_code: payload.bookingCode,
      passenger_name: payload.passengerName,
      passenger_phone: payload.passengerPhone,
      vehicle: payload.vehicle,
      pickup_lat: payload.pickupLat,
      pickup_lng: payload.pickupLng,
      pickup_label: payload.pickupLabel,
      dest_lat: payload.destLat,
      dest_lng: payload.destLng,
      dest_label: payload.destLabel,
      distance_km: payload.distanceKm,
      duration_min: payload.durationMin,
      base_fare: payload.baseFare,
      per_km_rate: payload.perKmRate,
      fare_inr: payload.fareInr,
      driver_name: payload.driverName,
      driver_phone: payload.driverPhone,
      plate_number: payload.plateNumber,
      status: 'dispatched',
    })
    .select('id')
    .single<{ id: string }>();

  if (error || !data) {
    throw formatSupabaseError(error, 'Failed to save booking in Supabase.');
  }

  return data.id;
}

export async function updateBookingStatus(
  bookingId: string,
  status: 'completed' | 'cancelled'
): Promise<void> {
  const { error } = await supabase
    .from('bookings')
    .update({
      status,
      updated_at: new Date().toISOString(),
    })
    .eq('id', bookingId)
    .eq('status', 'dispatched');

  if (error) {
    throw formatSupabaseError(error, 'Unable to update booking status.');
  }
}

export async function removeBookingRecord(bookingId: string): Promise<void> {
  const { error } = await supabase.from('bookings').delete().eq('id', bookingId);

  if (error) {
    throw formatSupabaseError(error, 'Unable to delete booking record.');
  }
}
