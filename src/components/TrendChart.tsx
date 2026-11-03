"use client";

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { formatINR, formatINRCompact } from "@/lib/money";
import { Card, Empty } from "./ui";

export function TrendChart({ title, data, color = "#10b981", loading, note }: {
  title: string; data: { label: string; amount: number }[]; color?: string; loading?: boolean; note?: string;
}) {
  const hasData = data.some((d) => d.amount > 0);
  const total = data.reduce((a, d) => a + d.amount, 0);
  return (
    <Card title={title} actions={<span className="text-[11px] text-zinc-500 tabular-nums">6-mo total {formatINR(total, { decimals: false })}</span>}>
      <div className="h-52">
        {loading ? (
          <div className="h-full rounded-xl bg-zinc-800/30 animate-pulse" />
        ) : !hasData ? (
          <Empty text="No recorded payments in this period" />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: "#71717a", fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={(v) => formatINRCompact(Number(v))} tick={{ fill: "#71717a", fontSize: 10 }} axisLine={false} tickLine={false} width={56} />
              <Tooltip
                cursor={{ stroke: "#3f3f46" }}
                contentStyle={{ background: "#111111", border: "1px solid #27272a", borderRadius: 12, fontSize: 12 }}
                labelStyle={{ color: "#a1a1aa" }}
                formatter={(v) => [formatINR(Number(v)), "Amount"]}
              />
              <Line type="monotone" dataKey="amount" stroke={color} strokeWidth={2} dot={{ r: 3, fill: color }} activeDot={{ r: 5 }} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
      {note && <p className="mt-2 text-[10px] text-zinc-600">{note}</p>}
    </Card>
  );
}
