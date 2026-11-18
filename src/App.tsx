import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { fetchBookings, getCurrentUser, logoutUser } from './api';
import { supabase } from './supabase';
import { BookingWorkspace } from './components/BookingWorkspace';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FareGuideView } from './components/FareGuideView';
import { LoginView } from './components/LoginView';
import { TopBar } from './components/TopBar';
import { TripHistoryView } from './components/TripHistoryView';
import type { AppTab, BookingRecord, LatLngPoint, UserProfile, VehicleTier } from './types';

function AppShell() {
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [bookings, setBookings] = useState<BookingRecord[]>([]);
  const [bookingsLoading, setBookingsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<AppTab>('book');
  const [rebookRoute, setRebookRoute] = useState<{
    pickup: LatLngPoint;
    dest: LatLngPoint;
    vehicle: VehicleTier;
  } | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: 'success' | 'error' } | null>(null);

  const showToast = useCallback((message: string, tone: 'success' | 'error' = 'success') => {
    setToast({ message, tone });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const refreshBookings = useCallback(async () => {
    try {
      const records = await fetchBookings();
      setBookings(records);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to load trip history.', 'error');
    } finally {
      setBookingsLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    let cancelled = false;
    getCurrentUser()
      .then((currentUser) => {
        if (cancelled) return;
        setUser(currentUser);
        setAuthReady(true);
      })
      .catch(() => {
        if (!cancelled) {
          setUser(null);
          setAuthReady(true);
        }
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        if (!cancelled) {
          setUser(null);
          setBookings([]);
          setAuthReady(true);
        }
      } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        void getCurrentUser().then((currentUser) => {
          if (!cancelled && currentUser) {
            setUser(currentUser);
            setAuthReady(true);
          }
        });
      }
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!authReady || !user) {
      setBookings([]);
      setBookingsLoading(false);
      return;
    }
    setBookingsLoading(true);
    void refreshBookings();
  }, [authReady, user, refreshBookings]);

  const handleAuthSuccess = (authenticatedUser: UserProfile) => {
    setUser(authenticatedUser);
    setAuthReady(true);
    setActiveTab('book');
  };

  const handleSignOut = async () => {
    try {
      await logoutUser();
      setUser(null);
      setBookings([]);
      setActiveTab('book');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Sign out failed.', 'error');
    }
  };

  if (!authReady) {
    return (
      <div className="min-h-dvh bg-[#090d16] text-slate-200 flex items-center justify-center">
        <div className="flex items-center gap-3 text-sm font-medium">
          <Loader2 className="w-5 h-5 animate-spin text-amber-400" />
          <span>Initializing session…</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginView onAuthSuccess={handleAuthSuccess} />;
  }

  return (
    <div className="min-h-dvh bg-[#090d16] text-slate-100 flex flex-col">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[2000] focus:px-4 focus:py-2 focus:rounded-lg focus:bg-amber-500 focus:text-slate-950 focus:font-semibold focus:text-xs"
      >
        Skip to main content
      </a>

      <TopBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        user={user}
        onSignOut={handleSignOut}
        bookingCount={bookings.length}
      />

      {/* Mobile Tab Navigation */}
      <nav
        aria-label="Mobile navigation"
        className="md:hidden sticky top-16 z-[1050] flex items-center gap-1 px-3 py-2 bg-[#0f172a]/95 backdrop-blur border-b border-slate-800"
      >
        {(['book', 'history', 'fares'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            aria-current={activeTab === tab ? 'page' : undefined}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 py-2 rounded-md text-xs font-semibold transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
              activeTab === tab ? 'bg-slate-800 text-amber-400' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {tab === 'book'
              ? 'Book Ride'
              : tab === 'history'
                ? `History (${bookings.length})`
                : 'Fare Guide'}
          </button>
        ))}
      </nav>

      <main id="main-content" tabIndex={-1} className="flex-1 focus:outline-none">
        {activeTab === 'book' && (
          <BookingWorkspace
            user={user}
            bookings={bookings}
            rebookRoute={rebookRoute}
            onConsumeRebook={() => setRebookRoute(null)}
            onBookingsChanged={refreshBookings}
            onOpenHistory={() => setActiveTab('history')}
            onToast={showToast}
          />
        )}

        {activeTab === 'history' && (
          <TripHistoryView
            bookings={bookings}
            isLoading={bookingsLoading}
            onBookingsChanged={refreshBookings}
            onRebook={(pickup, dest, vehicle) => {
              setRebookRoute({ pickup, dest, vehicle });
              setActiveTab('book');
            }}
            onStartBooking={() => setActiveTab('book')}
            onToast={showToast}
          />
        )}

        {activeTab === 'fares' && <FareGuideView onStartBooking={() => setActiveTab('book')} />}
      </main>

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed bottom-4 sm:bottom-5 left-1/2 -translate-x-1/2 z-[1500] max-w-[calc(100vw-2rem)] w-max text-center px-4 py-2.5 rounded-lg border text-xs font-semibold shadow-2xl transition-all ${
            toast.tone === 'error'
              ? 'bg-red-950/95 border-red-800 text-red-100'
              : 'bg-[#0f172a]/95 border-amber-500/50 text-slate-100'
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  );
}
