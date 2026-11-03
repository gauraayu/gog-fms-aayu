"use client";

/** Same layout as OMS src/app/login/page.tsx (handover §7), FMS texts, no role dropdown. */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, useMotionValue, useSpring, useTransform } from "framer-motion";
import { Mail, KeyRound, ArrowRight, Loader2, ShieldCheck } from "lucide-react";

const LOGO = "https://res.cloudinary.com/dtkim5oeu/image/upload/v1780628580/pr3a07yep93zxqmrnsno.png";

export default function LoginPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [choices, setChoices] = useState<{ employeeId: string; role: string }[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const bgX = useSpring(useTransform(mx, [-1, 1], [-14, 14]), { stiffness: 60, damping: 20 });
  const bgY = useSpring(useTransform(my, [-1, 1], [-14, 14]), { stiffness: 60, damping: 20 });

  useEffect(() => {
    fetch("/api/auth/session").then((r) => r.ok && router.replace("/"));
  }, [router]);

  async function submit(employeeId?: string) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password, employeeId }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.status === 409 && d.needsChoice) {
        setChoices(d.choices);
        return;
      }
      if (!res.ok) throw new Error(d.error || "Login failed");
      router.replace("/");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="min-h-screen bg-black relative overflow-hidden flex items-center justify-center p-6"
      onMouseMove={(e) => {
        mx.set((e.clientX / window.innerWidth) * 2 - 1);
        my.set((e.clientY / window.innerHeight) * 2 - 1);
      }}
    >
      {/* Background: OMS uses /public/3D.png — copy that file into FMS public/ to match exactly. */}
      <motion.div
        style={{ x: bgX, y: bgY, backgroundImage: "url(/3D.png), radial-gradient(circle at 70% 30%, rgba(16,185,129,0.18), transparent 55%)" }}
        className="absolute -inset-8 bg-cover bg-center opacity-60"
      />
      <div className="absolute inset-0 bg-gradient-to-br from-black via-black/80 to-black/40" />

      <div className="relative z-10 w-full max-w-6xl grid lg:grid-cols-2 gap-12 items-center">
        <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.6 }} className="hidden lg:block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={LOGO} alt="Geeks of Gurukul" className="h-14 mb-10 object-contain" />
          <h1 className="text-5xl xl:text-6xl font-black tracking-tight text-white leading-[1.05]" style={{ fontFamily: "var(--font-outfit)" }}>
            Finance{" "}
            <span className="text-[#10b981] drop-shadow-[0_0_25px_rgba(16,185,129,0.45)]">Management</span>
            <br />
            System.
          </h1>
          <p className="mt-6 text-sm text-zinc-400 max-w-md">
            Payroll, payslips, client invoices and statutory compliance for Geeks of Gurukul — in one secure place.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.1 }}
          className="bg-[#0d0f12]/40 backdrop-blur-3xl border border-white/[0.08] rounded-[2.5rem] p-8 sm:p-12 w-full max-w-md mx-auto"
        >
          <div className="lg:hidden mb-6">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={LOGO} alt="Geeks of Gurukul" className="h-10 object-contain" />
          </div>
          <div className="text-[10px] font-bold uppercase tracking-[0.3em] text-[#10b981]">GOG FMS</div>
          <h2 className="mt-2 text-2xl font-black text-white" style={{ fontFamily: "var(--font-outfit)" }}>Sign in</h2>
          <p className="text-xs text-zinc-500 mt-1">Use your GOG OMS credentials. Finance access must be granted separately.</p>

          <form
            className="mt-8 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="relative">
              <Mail size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input
                autoComplete="username" required value={identifier} onChange={(e) => { setIdentifier(e.target.value); setChoices(null); }}
                placeholder="Official email or Employee ID"
                className="w-full bg-[#1c1f26]/40 border border-white/10 rounded-2xl py-4 pl-12 pr-4 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-[#10b981]/50"
              />
            </div>
            <div className="relative">
              <KeyRound size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input
                type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                className="w-full bg-[#1c1f26]/40 border border-white/10 rounded-2xl py-4 pl-12 pr-4 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-[#10b981]/50"
              />
            </div>

            {choices && (
              <div className="space-y-2">
                <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Choose FMS profile</div>
                {choices.map((c) => (
                  <button
                    type="button" key={c.employeeId} onClick={() => submit(c.employeeId)}
                    className="w-full flex items-center justify-between px-4 py-3 rounded-2xl border border-white/10 text-sm text-white hover:border-[#10b981]/50"
                  >
                    <span>{c.employeeId}</span><span className="text-xs text-zinc-400">{c.role}</span>
                  </button>
                ))}
              </div>
            )}

            {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-xs text-red-300">{error}</div>}

            <button
              type="submit" disabled={busy}
              className="w-full flex items-center justify-center gap-2 bg-[#10b981] text-black font-black uppercase tracking-[0.25em] text-xs rounded-2xl py-4 shadow-[0_15px_30px_-5px_rgba(16,185,129,0.3)] hover:bg-[#12d393] disabled:opacity-60"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <>Enter <ArrowRight size={14} /></>}
            </button>
          </form>
          <div className="mt-6 flex items-center gap-2 text-[10px] text-zinc-600">
            <ShieldCheck size={12} /> Forgot password? Ask HR to reset it in GOG OMS.
          </div>
        </motion.div>
      </div>
    </div>
  );
}
