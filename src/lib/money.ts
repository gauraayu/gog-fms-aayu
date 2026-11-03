/** All money in FMS is stored as integer paise. */
export type Paise = number;

export const toPaise = (rupees: number | string | null | undefined): Paise => {
  const n = typeof rupees === "string" ? Number(rupees.replace(/[,₹\s]/g, "")) : Number(rupees ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
};

export const toRupees = (paise: Paise): number => Math.round(paise) / 100;

export const formatINR = (paise: Paise, opts: { decimals?: boolean } = {}): string => {
  const v = toRupees(paise);
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: opts.decimals === false ? 0 : 2,
    maximumFractionDigits: opts.decimals === false ? 0 : 2,
  }).format(v);
};

/** Compact INR for chart axes: ₹1.2L, ₹3.4Cr */
export const formatINRCompact = (paise: Paise): string => {
  const r = toRupees(paise);
  const abs = Math.abs(r);
  if (abs >= 1e7) return `₹${(r / 1e7).toFixed(1)}Cr`;
  if (abs >= 1e5) return `₹${(r / 1e5).toFixed(1)}L`;
  if (abs >= 1e3) return `₹${(r / 1e3).toFixed(1)}K`;
  return `₹${r.toFixed(0)}`;
};

export type RoundingMode = "PAISE" | "NEAREST_RUPEE";

export const roundFinal = (paise: number, mode: RoundingMode): Paise =>
  mode === "NEAREST_RUPEE" ? Math.round(paise / 100) * 100 : Math.round(paise);
