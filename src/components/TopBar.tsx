import { LogOut, User as UserIcon } from 'lucide-react';
import type { AppTab, UserProfile } from '../types';

interface TopBarProps {
  activeTab: AppTab;
  onSelectTab: (tab: AppTab) => void;
  user: UserProfile;
  onSignOut: () => void;
  bookingCount: number;
}

export function TopBar({
  activeTab,
  onSelectTab,
  user,
  onSignOut,
  bookingCount,
}: TopBarProps) {
  const navItems: { id: AppTab; label: string }[] = [
    { id: 'book', label: 'Book Ride' },
    { id: 'history', label: bookingCount > 0 ? `Trip History (${bookingCount})` : 'Trip History' },
    { id: 'fares', label: 'Fare Guide' },
  ];

  return (
    <header className="h-16 bg-[#0f172a] border-b border-slate-800/90 px-4 sm:px-7 flex items-center justify-between gap-8 sticky top-0 z-[1100]">
      {/* Zone 1: Single-line Brand Wordmark */}
      <button
        type="button"
        onClick={() => onSelectTab('book')}
        className="text-lg font-extrabold tracking-tight text-slate-50 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded"
      >
        TaxiBook <span className="text-amber-400">India</span>
      </button>

      {/* Zone 2: Clean single-line Navigation Links */}
      <nav aria-label="Primary navigation" className="hidden md:flex items-center gap-7">
        {navItems.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-current={isActive ? 'page' : undefined}
              onClick={() => onSelectTab(item.id)}
              className={`py-1.5 text-sm font-medium whitespace-nowrap shrink-0 border-b-2 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
                isActive
                  ? 'text-amber-400 border-amber-400'
                  : 'text-slate-400 border-transparent hover:text-slate-100'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* Zone 3: Single Primary Account Control */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="hidden sm:flex items-center gap-2.5 text-sm text-slate-200 max-w-[200px]">
          <span className="w-7 h-7 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-300 shrink-0">
            <UserIcon className="w-4 h-4" />
          </span>
          <span className="truncate font-medium">{user.displayName || user.email}</span>
        </div>

        <button
          type="button"
          onClick={onSignOut}
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-xs font-semibold text-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          <LogOut className="w-3.5 h-3.5 text-slate-400" />
          Sign Out
        </button>
      </div>
    </header>
  );
}
