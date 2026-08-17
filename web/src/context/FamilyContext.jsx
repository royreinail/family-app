// Plain React state + Context — no Redux or equivalent (frontend guardrail
// 2). This is the one place session/family state lives; components read it
// via useFamily() rather than each re-fetching /auth/session themselves.
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { getSession } from '../api/client.js';

const FamilyContext = createContext(null);

export function FamilyProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getSession();
      setSession(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <FamilyContext.Provider value={{ session, loading, refresh }}>
      {children}
    </FamilyContext.Provider>
  );
}

export function useFamily() {
  const ctx = useContext(FamilyContext);
  if (!ctx) throw new Error('useFamily must be used within a FamilyProvider');
  return ctx;
}
