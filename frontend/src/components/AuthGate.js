'use client';

import { Activity, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import LoginScreen from '@/components/LoginScreen';
import Sidebar from '@/components/Sidebar';
import SyncAlertHost from '@/components/SyncAlertHost';

// Shows the sign-in screen until a team member is signed in, then the app. The data itself is protected
// by Supabase (schema.sql: only signed-in users may read), this only decides what to draw.
// The pages always render (out of sight until sign-in) so Next.js can prerender and validate every route
// instead of seeing an empty tree. Once signed out they are paused (Activity hidden: no effects, no polling).
export default function AuthGate({ children }) {
  // undefined = still reading the saved session, null = signed out
  const [session, setSession] = useState(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  // Signed up without tools/add-user.js: Supabase gives such accounts no data, so don't show an empty app
  const member = Boolean(session?.user.app_metadata?.team);

  return (
    <>
      {session === null && <LoginScreen />}
      {session && !member && <LoginScreen notice="This account is not part of the team yet. Ask an admin to add it." />}
      {member && <Sidebar user={session.user} />}
      {/* A failed Sync stays on screen on every page until closed */}
      {member && <SyncAlertHost />}
      {/* Visible while the session loads too: the server render must include the pages */}
      <Activity mode={session === undefined || member ? 'visible' : 'hidden'}>
        <main hidden={!member} className="flex-1 min-w-0">
          {children}
        </main>
      </Activity>
    </>
  );
}
