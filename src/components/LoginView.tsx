import { useState, type FormEvent } from 'react';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
  MapPin,
  ShieldCheck,
  User as UserIcon,
} from 'lucide-react';
import { loginUser, registerUser } from '../api';
import type { UserProfile } from '../types';

interface LoginViewProps {
  onAuthSuccess: (user: UserProfile) => void;
}

export function LoginView({ onAuthSuccess }: LoginViewProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setInfoMessage(null);

    const trimmedEmail = email.trim();
    const trimmedName = displayName.trim();

    if (mode === 'register' && trimmedName.length < 1) {
      setErrorMessage('Please enter your full name.');
      return;
    }
    if (!trimmedEmail || !trimmedEmail.includes('@')) {
      setErrorMessage('Please enter a valid email address.');
      return;
    }
    if (password.length < 6) {
      setErrorMessage('Password must be at least 6 characters.');
      return;
    }

    setIsSubmitting(true);
    try {
      if (mode === 'register') {
        const result = await registerUser({
          displayName: trimmedName,
          email: trimmedEmail,
          password,
        });
        if (result.requiresEmailConfirmation) {
          setInfoMessage(
            'Account created in Supabase! Please check your email inbox to confirm your address before signing in.'
          );
          setMode('login');
          setIsSubmitting(false);
          return;
        }
        if (result.user) {
          onAuthSuccess(result.user);
        }
      } else {
        const user = await loginUser({
          email: trimmedEmail,
          password,
        });
        onAuthSuccess(user);
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Unable to authenticate. Please try again.'
      );
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-dvh bg-[#090d16] text-slate-100 grid lg:grid-cols-12 items-stretch">
      {/* Left Architectural Visual Column */}
      <div className="relative hidden lg:block lg:col-span-6 overflow-hidden border-r border-slate-800/80 bg-[#0f172a]">
        {!imageFailed ? (
          <img
            src="/src/assets/images/login_india_mobility_1794929236234.jpg"
            alt="Evening urban mobility corridor in India"
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-slate-900 via-[#0f172a] to-amber-950/30 flex items-center justify-center">
            <MapPin className="w-16 h-16 text-amber-500/40" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-[#090d16] via-[#090d16]/45 to-transparent" />
        <div className="absolute bottom-10 left-10 right-10 space-y-3">
          <p className="text-xs font-medium text-amber-400 tracking-wide">
            Pan-India Urban Dispatch · OSRM Road Routing
          </p>
          <h2 className="text-3xl font-bold text-slate-50 leading-tight max-w-lg [text-wrap:balance]">
            Real-time road routing, instant fare clarity, and persistent trip records.
          </h2>
          <p className="text-sm text-slate-300 max-w-md leading-relaxed">
            Pin any pickup and drop corridor across India, inspect live Bike, Auto, and Car AC fares, and store every dispatched booking in your Supabase account database.
          </p>
        </div>
      </div>

      {/* Right Sign-In Column */}
      <div className="lg:col-span-6 flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-md space-y-8">
          <div className="space-y-3">
            <div className="text-lg font-extrabold tracking-tight text-slate-50">
              TaxiBook <span className="text-amber-400">India</span>
            </div>
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-slate-50 [text-wrap:balance]">
              {mode === 'login'
                ? 'Sign in to book and manage your rides'
                : 'Create your rider account'}
            </h1>
            <p className="text-sm sm:text-base text-slate-400 leading-relaxed">
              Sign in with your rider credentials to access the interactive dispatch map, driver assignment, and saved trip history.
            </p>
          </div>

          {/* Primary Supabase Auth Form Card */}
          <form
            onSubmit={handleSubmit}
            className="bg-[#0f172a] border border-slate-800 rounded-xl p-6 space-y-4"
          >
            <div
              role="tablist"
              aria-label="Authentication mode"
              className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-[#090d16] border border-slate-800"
            >
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'login'}
                onClick={() => {
                  setMode('login');
                  setErrorMessage(null);
                }}
                className={`py-2 rounded-md text-xs font-semibold transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${
                  mode === 'login'
                    ? 'bg-amber-500 text-slate-950'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'register'}
                onClick={() => {
                  setMode('register');
                  setErrorMessage(null);
                  setInfoMessage(null);
                }}
                className={`py-2 rounded-md text-xs font-semibold transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${
                  mode === 'register'
                    ? 'bg-amber-500 text-slate-950'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                Create Account
              </button>
            </div>

            {infoMessage && (
              <div
                role="status"
                className="flex items-start gap-2.5 p-3.5 rounded-lg bg-emerald-950/50 border border-emerald-800/70 text-sm text-emerald-200"
              >
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <span>{infoMessage}</span>
              </div>
            )}

            {errorMessage && (
              <div
                role="alert"
                className="flex items-start gap-2.5 p-3.5 rounded-lg bg-red-950/50 border border-red-900/70 text-sm text-red-200"
              >
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <span>{errorMessage}</span>
              </div>
            )}

            {mode === 'register' && (
              <div className="space-y-1">
                <label htmlFor="auth-name" className="block text-xs text-slate-400">
                  Full Name
                </label>
                <div className="relative">
                  <UserIcon className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    id="auth-name"
                    type="text"
                    autoComplete="name"
                    maxLength={80}
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Rohan Sharma"
                    className="w-full pl-9 pr-3 py-2.5 rounded-lg bg-[#090d16] border border-slate-800 focus:border-amber-500 focus:outline-none text-base sm:text-sm text-slate-100 placeholder:text-slate-600"
                  />
                </div>
              </div>
            )}

            <div className="space-y-1">
              <label htmlFor="auth-email" className="block text-xs text-slate-400">
                Email Address
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="auth-email"
                  type="email"
                  autoComplete="email"
                  maxLength={160}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="rohan@example.com"
                  className="w-full pl-9 pr-3 py-2.5 rounded-lg bg-[#090d16] border border-slate-800 focus:border-amber-500 focus:outline-none text-base sm:text-sm text-slate-100 placeholder:text-slate-600"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label htmlFor="auth-password" className="block text-xs text-slate-400">
                Password
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="auth-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 6 characters"
                  className="w-full pl-9 pr-10 py-2.5 rounded-lg bg-[#090d16] border border-slate-800 focus:border-amber-500 focus:outline-none text-base sm:text-sm text-slate-100 placeholder:text-slate-600"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full flex items-center justify-center gap-2.5 px-5 py-3.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-60 disabled:cursor-not-allowed text-slate-950 font-semibold text-sm transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0f172a]"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>{mode === 'login' ? 'Signing in…' : 'Creating account…'}</span>
                </>
              ) : (
                <>
                  <span>{mode === 'login' ? 'Sign In' : 'Create Account'}</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>

            <div className="flex items-start gap-2.5 text-xs text-slate-400 pt-1">
              <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <span>
                Your profile and booking records are scoped strictly to your authenticated rider session in Supabase.
              </span>
            </div>
          </form>

          {/* Unboxed Tariff Reference */}
          <div className="pt-2 border-t border-slate-800/80 space-y-2">
            <p className="text-xs font-medium text-slate-400">Standard Indian Fare Schedule</p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-mono-tabular text-slate-300">
              <span>Bike ₹20 + ₹8/km</span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span>Auto ₹30 + ₹12/km</span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span>Car AC ₹50 + ₹18/km</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
