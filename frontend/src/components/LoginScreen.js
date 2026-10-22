'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { toLoginEmail } from '@/lib/username';

// Sign-in for team members. Accounts are made by an admin (tools/add-user.js); there is no sign-up.
export default function LoginScreen({ notice }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const signIn = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    await supabase.auth.signOut(); // leaves a non-team account first
    const { error } = await supabase.auth.signInWithPassword({ email: toLoginEmail(email.trim()), password });
    // On success AuthGate swaps this screen for the dashboard
    if (error) {
      setError(error.message === 'Invalid login credentials' ? 'Wrong username or password.' : error.message);
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-white px-4">
      <form onSubmit={signIn} className="w-full max-w-sm rounded-[14px] border border-[#E2E8F0] p-7 space-y-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-black flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-[#61A644]" aria-hidden />
            Opportunity Radar
          </h1>
          <p className="text-xs text-black/62 mt-1">Sign in with your team account</p>
        </div>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-black/62">Username or email</span>
          <input
            type="text"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-[#CBD5E1] px-3 py-2 text-sm outline-none focus:border-[#1EA0DA]"
          />
        </label>
        <div className="space-y-1.5">
          <label htmlFor="password" className="block text-xs font-medium text-black/62">Password</label>
          <div className="relative">
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-[#CBD5E1] pl-3 pr-10 py-2 text-sm outline-none focus:border-[#1EA0DA]"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              title={showPassword ? 'Hide password' : 'Show password'}
              className="absolute inset-y-0 right-0 flex items-center px-3 text-black/46 hover:text-[#12769F] transition"
            >
              <EyeIcon crossed={showPassword} />
            </button>
          </div>
        </div>

        {notice && !error && <p className="text-sm text-[#B3312C]">{notice}</p>}
        {error && (
          <p role="alert" className="text-sm text-[#B3312C]">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full bg-[#4A8033] hover:bg-[#3F6F2C] disabled:opacity-60 disabled:cursor-wait text-white px-4 py-2.5 rounded-full text-sm font-medium transition"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

// Eye = show the password; crossed-out eye = hide it again
function EyeIcon({ crossed }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      {crossed && <path d="M3 3l18 18" />}
    </svg>
  );
}
