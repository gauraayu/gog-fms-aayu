"use client";

/**
 * FMS UI kit — re-implements the GOG OMS component patterns (handover §7)
 * inside the FMS codebase, so FMS changes can never affect OMS.
 */
import { useEffect, useId, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes } from "react";
import { Loader2, Inbox, X, CheckCircle2, AlertTriangle, Upload } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

export function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <div className={cn("p-4 sm:p-6 space-y-5 mx-auto w-full", wide ? "max-w-7xl" : "max-w-6xl")}>{children}</div>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white">{title}</h1>
        {subtitle && <p className="text-[11px] text-zinc-500 mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className, title, actions }: { children: ReactNode; className?: string; title?: string; actions?: ReactNode }) {
  return (
    <div className={cn("bg-zinc-900/80 border border-zinc-800/50 rounded-2xl p-5", className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between mb-4 gap-2">
          {title && <h2 className="text-sm font-bold text-white">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}

const TONES = {
  emerald: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  sky: "text-sky-400 bg-sky-500/10 border-sky-500/20",
  amber: "text-amber-400 bg-amber-500/10 border-amber-500/20",
  red: "text-red-400 bg-red-500/10 border-red-500/20",
  purple: "text-purple-400 bg-purple-500/10 border-purple-500/20",
  zinc: "text-zinc-400 bg-zinc-500/10 border-zinc-500/20",
} as const;
export type Tone = keyof typeof TONES;

export function KpiCard({ icon, label, value, hint, tone = "emerald", loading }: { icon: ReactNode; label: string; value: ReactNode; hint?: ReactNode; tone?: Tone; loading?: boolean }) {
  return (
    <div className="flex items-center gap-3 p-4 rounded-2xl border border-zinc-800/50 bg-zinc-900">
      <div className={cn("w-10 h-10 shrink-0 rounded-xl border flex items-center justify-center", TONES[tone])}>{icon}</div>
      <div className="min-w-0">
        <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest truncate">{label}</div>
        <div className="text-xl font-bold text-white tabular-nums truncate">{loading ? <span className="inline-block h-6 w-24 rounded bg-zinc-800 animate-pulse" /> : value}</div>
        {hint && <div className="text-[10px] text-zinc-500 truncate">{hint}</div>}
      </div>
    </div>
  );
}

type BtnVariant = "primary" | "outline" | "danger" | "ghost";
export function Button({ variant = "primary", loading, className, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; loading?: boolean }) {
  const v = {
    primary: "bg-emerald-600 hover:bg-emerald-500 text-white border border-emerald-600",
    outline: "border border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-white",
    danger: "border border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20",
    ghost: "text-zinc-400 hover:text-white hover:bg-zinc-800/50 border border-transparent",
  }[variant];
  return (
    <button
      {...p}
      disabled={p.disabled || loading}
      className={cn("inline-flex items-center justify-center gap-1.5 h-9 px-4 rounded-lg text-xs font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed", v, className)}
    >
      {loading && <Loader2 size={13} className="animate-spin" />}
      {children}
    </button>
  );
}

export const inputCls = "h-9 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 text-xs text-white outline-none focus:border-zinc-600 placeholder:text-zinc-600";

export function Input(p: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cn(inputCls, p.className)} />;
}
/**
 * File picker styled like the other buttons. The real <input type="file"> stays inside the form
 * (visually hidden), so FormData, `name` and `required` keep working.
 */
export function FileInput({ className, onChange, ...p }: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [name, setName] = useState("");
  const id = useId();
  return (
    <div className={cn("flex items-center gap-2 min-w-0", className)}>
      <label
        htmlFor={id}
        className="shrink-0 cursor-pointer inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-zinc-700 bg-zinc-900 text-xs font-semibold text-zinc-200 hover:text-white hover:border-emerald-500/60 hover:bg-zinc-800 transition-colors focus-within:ring-2 focus-within:ring-emerald-500/40"
      >
        <Upload size={13} /> {name ? "Change file" : "Choose file"}
      </label>
      <span className={cn("text-xs truncate", name ? "text-zinc-200" : "text-zinc-500")} title={name}>{name || "No file selected"}</span>
      <input
        {...p}
        id={id}
        type="file"
        className="sr-only"
        onChange={(e) => { setName(e.target.files?.[0]?.name ?? ""); onChange?.(e); }}
      />
    </div>
  );
}
export function Select({ children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...p} className={cn(inputCls, "pr-7", p.className)}>
      {children}
    </select>
  );
}
export function Textarea(p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...p} className={cn(inputCls, "h-auto min-h-[72px] py-2", p.className)} />;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">{label}</span>
      {children}
      {hint && <span className="block text-[10px] text-zinc-600">{hint}</span>}
    </label>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  Draft: "zinc", "Under Review": "amber", Approved: "sky", Finalized: "purple", Disbursed: "emerald",
  Issued: "sky", "Partially Paid": "amber", Paid: "emerald", Overdue: "red", Cancelled: "zinc",
  Uploaded: "amber", Verified: "emerald", Sent: "emerald", Failed: "red", Queued: "zinc", Sending: "amber",
  Active: "emerald", Inactive: "zinc", Resigned: "zinc", Exited: "zinc",
};
export function Badge({ children, tone }: { children: ReactNode; tone?: Tone }) {
  const t = tone ?? STATUS_TONE[String(children)] ?? "zinc";
  return (
    <span className={cn("inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-semibold whitespace-nowrap", TONES[t])}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-xs text-zinc-500">
      <Loader2 size={16} className="animate-spin text-zinc-500" /> {label ?? "Loading…"}
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-xs text-zinc-500">
      <Inbox size={20} className="text-zinc-600" />
      {text}
    </div>
  );
}

export function Notice({ kind = "ok", children, onClose }: { kind?: "ok" | "error" | "warn"; children: ReactNode; onClose?: () => void }) {
  useEffect(() => {
    if (!onClose || kind === "warn") return;
    const t = setTimeout(onClose, kind === "error" ? 6000 : 4000);
    return () => clearTimeout(t);
  }, [onClose, kind]);
  const cls = { ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300", error: "border-red-500/30 bg-red-500/10 text-red-300", warn: "border-amber-500/30 bg-amber-500/10 text-amber-200" }[kind];
  return (
    <div className={cn("flex items-start gap-2 rounded-xl border px-4 py-2.5 text-xs", cls)}>
      {kind === "ok" ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> : <AlertTriangle size={14} className="mt-0.5 shrink-0" />}
      <div className="flex-1">{children}</div>
      {onClose && (
        <button onClick={onClose} className="opacity-60 hover:opacity-100" aria-label="Dismiss">
          <X size={13} />
        </button>
      )}
    </div>
  );
}

export function Modal({ open, onClose, title, children, size = "md", footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; size?: "md" | "lg" | "xl"; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[110] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            role="dialog" aria-modal="true"
            initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 12, opacity: 0 }}
            className={cn("bg-zinc-900 border border-zinc-800 rounded-2xl w-full shadow-2xl max-h-[90vh] flex flex-col", { md: "max-w-md", lg: "max-w-2xl", xl: "max-w-4xl" }[size])}
          >
            <div className="px-5 py-3 border-b border-zinc-800 flex items-center justify-between">
              <h3 className="text-sm font-bold text-white">{title}</h3>
              <button onClick={onClose} className="text-zinc-500 hover:text-white" aria-label="Close"><X size={15} /></button>
            </div>
            <div className="p-5 overflow-y-auto">{children}</div>
            {footer && <div className="px-5 py-3 border-t border-zinc-800 flex justify-end gap-2">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Table({ head, children, className }: { head: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-xl border border-zinc-800 overflow-x-auto", className)}>
      <table className="w-full text-xs">
        <thead className="bg-zinc-900 text-[10px] text-zinc-500 uppercase tracking-wider text-left">{head}</thead>
        <tbody className="divide-y divide-zinc-800/70">{children}</tbody>
      </table>
    </div>
  );
}
export const th = "px-3 py-2.5 font-bold whitespace-nowrap";
export const td = "px-3 py-3 text-zinc-300";
export const tr = "hover:bg-zinc-800/20";

export function Pagination({ page, limit, total, onPage }: { page: number; limit: number; total: number; onPage: (p: number) => void }) {
  const from = total ? (page - 1) * limit + 1 : 0;
  const to = Math.min(total, page * limit);
  return (
    <div className="flex items-center justify-between pt-3">
      <span className="text-[11px] text-zinc-500">Showing {from}–{to} of {total}</span>
      <div className="flex gap-2">
        <button disabled={page <= 1} onClick={() => onPage(page - 1)} className="h-8 px-2.5 rounded-lg border border-zinc-800 text-xs text-zinc-300 disabled:opacity-40">Prev</button>
        <button disabled={to >= total} onClick={() => onPage(page + 1)} className="h-8 px-2.5 rounded-lg border border-zinc-800 text-xs text-zinc-300 disabled:opacity-40">Next</button>
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: string }[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((i) => (
        <button
          key={i.value}
          onClick={() => onChange(i.value)}
          className={cn(
            "px-4 py-2.5 rounded-xl border text-xs font-semibold transition-colors",
            value === i.value ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300" : "border-zinc-800 text-zinc-400 hover:text-white",
          )}
        >
          {i.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 px-3 py-2">
      <div className="text-[9px] font-bold uppercase tracking-widest text-zinc-500">{label}</div>
      <div className="text-sm font-bold text-white tabular-nums">{value}</div>
    </div>
  );
}