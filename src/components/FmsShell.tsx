"use client";

/**
 * Shell = OMS Sidebar + SidebarWrapper patterns (handover §7), with the FMS menu.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import {
  LayoutDashboard, Users, Calculator, Layers, FileText, Receipt, Landmark, BarChart3, Mail, History, Settings, LogOut, Menu, X, Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "./AuthContext";
import type { Permission } from "@/lib/permissions";

const LOGO = "https://i.ibb.co/qYQkmMDR/unnamed-1.png";

const NAV: { section: string; items: { href: string; label: string; icon: typeof LayoutDashboard; perm: Permission }[] }[] = [
  { section: "Overview", items: [{ href: "/", label: "Dashboard", icon: LayoutDashboard, perm: "dashboard.view" }] },
  {
    section: "Payroll",
    items: [
      { href: "/employees", label: "Employee Management", icon: Users, perm: "employees.view" },
      { href: "/payroll", label: "Payroll Management", icon: Calculator, perm: "payroll.view" },
      { href: "/salary-structures", label: "Salary Structures", icon: Layers, perm: "salary.view" },
      { href: "/payslips", label: "Payslip Management", icon: FileText, perm: "payslips.view" },
    ],
  },
  {
    section: "Finance",
    items: [
      { href: "/invoices", label: "Client Invoices", icon: Receipt, perm: "invoices.view" },
      { href: "/challans", label: "EPF, GST, PT & TDS Challans", icon: Landmark, perm: "challans.view" },
      { href: "/reports", label: "Financial Reports", icon: BarChart3, perm: "reports.view" },
    ],
  },
  {
    section: "System",
    items: [
      { href: "/email-management", label: "Email Management", icon: Mail, perm: "emails.view" },
      { href: "/audit", label: "Audit History", icon: History, perm: "audit.view" },
      { href: "/settings", label: "Settings", icon: Settings, perm: "settings.manage" },
    ],
  },
];

const ROLE_LABEL: Record<string, string> = { FMS_ADMIN: "FMS Admin", FOUNDER: "Founder", HR: "HR", ACCOUNTS: "Accounts" };

function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!now) return null;
  return (
    <div className="px-3 py-1.5 rounded-full border border-zinc-800 bg-zinc-900/60 text-[11px] text-zinc-400 tabular-nums">
      {now.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
    </div>
  );
}

export function FmsShell({ children }: { children: ReactNode }) {
  const { user, loading, can, logout } = useAuth();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center text-zinc-500 text-xs gap-2">
        <Loader2 size={16} className="animate-spin" /> Checking session…
      </div>
    );
  }

  const sidebar = (
    <aside
      className={cn(
        "w-56 shrink-0 bg-[#0a0a0b] border-r border-zinc-800/50 py-5 px-3 flex flex-col h-screen",
        "fixed inset-y-0 left-0 z-50 transition-transform lg:static lg:translate-x-0",
        open ? "translate-x-0" : "-translate-x-full",
      )}
    >
      <div className="flex items-center gap-2.5 px-3 mb-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={LOGO} alt="GOG" className="w-7 h-7 rounded-md object-contain" />
        <div className="min-w-0">
          <div className="text-sm font-bold text-white leading-tight">GOG FMS</div>
          <div className="text-[9px] text-zinc-500 truncate">Finance Management System</div>
        </div>
        <button className="ml-auto lg:hidden text-zinc-500" onClick={() => setOpen(false)} aria-label="Close menu"><X size={16} /></button>
      </div>
      <nav className="flex-1 overflow-y-auto space-y-5">
        {NAV.map((sec) => {
          const items = sec.items.filter((i) => can(i.perm));
          if (!items.length) return null;
          return (
            <div key={sec.section}>
              <div className="text-[9px] font-bold text-zinc-500 uppercase tracking-widest mb-2 px-3">{sec.section}</div>
              <div className="space-y-0.5">
                {items.map((i) => {
                  const active = i.href === "/" ? pathname === "/" : pathname.startsWith(i.href);
                  const Icon = i.icon;
                  return (
                    <Link
                      key={i.href}
                      href={i.href}
                      className={cn(
                        "flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium border transition-colors",
                        active ? "bg-primary/10 text-primary border-primary/10" : "text-zinc-400 border-transparent hover:text-white hover:bg-zinc-800/50",
                      )}
                    >
                      <Icon size={14} />
                      <span className="truncate">{i.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>
      <div className="mt-4 bg-zinc-900/80 border border-zinc-800/50 rounded-xl p-2.5">
        <div className="text-xs font-semibold text-white truncate">{user.name}</div>
        <div className="text-[10px] text-zinc-500 truncate">{user.employeeId} · {ROLE_LABEL[user.role] ?? user.role}</div>
        <button onClick={logout} className="mt-2 w-full flex items-center justify-center gap-1.5 h-8 rounded-lg border border-zinc-800 text-[11px] text-zinc-400 hover:text-white hover:border-zinc-600">
          <LogOut size={12} /> Sign Out
        </button>
      </div>
    </aside>
  );

  return (
    <div className="flex h-screen overflow-hidden">
      {open && <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden" onClick={() => setOpen(false)} />}
      {sidebar}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="lg:hidden px-4 py-3 border-b border-zinc-800 sticky top-0 z-30 bg-[#0a0a0b] flex items-center gap-3">
          <button onClick={() => setOpen(true)} className="text-zinc-400" aria-label="Open menu"><Menu size={18} /></button>
          <span className="text-sm font-bold text-white">GOG FMS</span>
        </header>
        <header className="hidden lg:flex px-8 py-3 border-b border-zinc-900 bg-[#0a0a0b]/80 backdrop-blur-md items-center justify-between">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">{ROLE_LABEL[user.role] ?? user.role} Dashboard</div>
            <div className="text-xl font-extrabold text-white">Welcome back, {user.name.split(" ")[0]}</div>
          </div>
          <Clock />
        </header>
        <main className="flex-1 overflow-y-auto">
          {user.omsRole === "TEST" && (
            <div className="px-4 py-1.5 text-center text-[11px] font-semibold bg-amber-500/15 border-b border-amber-500/30 text-amber-300">
              TEST USER — {user.employeeId} ({ROLE_LABEL[user.role] ?? user.role}). Not an OMS employee. Disable test users before go-live.
            </div>
          )}
          <div className="desktop-zoom">{children}</div>
        </main>
      </div>
    </div>
  );
}
