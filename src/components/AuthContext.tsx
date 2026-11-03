"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Permission } from "@/lib/permissions";

export interface ClientUser {
  employeeId: string;
  name: string;
  email: string;
  role: string;
  omsRole: string;
  permissions: Permission[];
}

const Ctx = createContext<{ user: ClientUser | null; loading: boolean; can: (p: Permission) => boolean; logout: () => Promise<void> }>({
  user: null, loading: true, can: () => false, logout: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<ClientUser | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/session", { credentials: "same-origin" })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive) return;
        if (d?.authenticated) setUser(d.user);
        else router.replace("/login");
      })
      .catch(() => router.replace("/login"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [router]);

  const can = useCallback((p: Permission) => !!user?.permissions.includes(p), [user]);
  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }, [router]);

  return <Ctx.Provider value={{ user, loading, can, logout }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
