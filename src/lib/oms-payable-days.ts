/* eslint-disable @typescript-eslint/no-explicit-any */
// ─────────────────────────────────────────────────────────────────────────────
// OMS payable-days rules, as OMS computes them on 23/11/2026
// (doc "OMS → FMS: Payable Days aur Penalty ke Niyam").
// Pure: no database, no money. FMS must give exactly the same payable /
// non-payable / penalty / % fine result as OMS → Salary Management.
// The 13 test cases of that doc are in tests/oms-rules.test.ts.
// If OMS changes its rules, update this file and those tests together.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Day rules (checked in this order, the first that applies decides the day):
 *  1. Before joining / after exit → Not Employed (not counted at all).
 *  2. Current month, after "asOf" → Upcoming, projected payable (provisional).
 *  3. Sunday / approved holiday → payable 1, no penalty (HR correction still applies).
 *  4. Approved leave: 1 paid leave day per month, rest unpaid. Half-day leave = 0.5;
 *     the other half without attendance = 0.5 LOP. Short leave ignored.
 *  5. Present (clock-in, or status present / late, or WFH) → payable 1.
 *  6. Anything else → LOP 1 (pending leave = still LOP, shown as pending).
 *  7. Penalty: never more than the day's remaining payable part; the part of a
 *     penalty above one day (Late 5th+ = 2 days) is taken from the month total.
 *  8. HR correction last (Payable / Non-Payable / Half Day Payable).
 *
 * Penalties (count restarts every month, date order; removed flags never count):
 *  - Late Clock-In from POLICY_FROM: automatic, count 1,2 → 0 · 3 → 0.5 · 4 → 1 · 5+ → 2 days.
 *    Before POLICY_FROM: proposedDeduction, only when "Approved for Payroll".
 *    Counter skips Waived / Approved and days with a pending Late Justification
 *    (those days are on hold: no number, no deduction). Stored `instance` is not used.
 *  - Early Clock-Out: renumbered (from POLICY_FROM) 1–3 None · 4 Half-Day · 5+ Full-Day;
 *    deducted only when the final hrStatus is "Approved for Payroll".
 *  - Missing Clock-Out: flag only, never deducts.
 *  - Location mismatch (rejected, half_day / full_day): automatic 0.5 / 1.
 *  - Dress Code: before POLICY_FROM 4th → 0.5, 5th+ → 1 day; from POLICY_FROM no day,
 *    % fine of one day's gross: 3rd 10% · 4th 20% · 5th+ 30%. One counter for the month.
 *  - Full Attire (from POLICY_FROM only): same % fine, its own counter.
 */

export const POLICY_FROM = "2026-11-04";

export type PdAttendance = { _id?: any; date: string; status?: string; clockIn?: string; clockOut?: string; workMode?: string; location?: string; dressCodeStatus?: string; dressCodeRejectionReasons?: string[] };
export type PdLeave = { id?: string; type?: string; leaveType?: string; startDate: string; endDate: string; days?: number; status?: string };
export type PdViolation = { id: string; date: string; type: string; level?: string; instance?: number | null; proposedDeduction?: string; hrStatus?: string; scheduledTime?: string; actualTime?: string };
/** fullattirereviews (status rejected) joined to fullattiresubmissions.submittedAt (IST day) */
export type PdFullAttire = { id: string; date: string; reasons?: string };
export type PdCorrection = { id: string; direction?: string; payableType?: string; correctionCategory?: string; correctionReason?: string; correctedByName?: string; correctedByRole?: string; correctedAt?: string; relatedTicketId?: string };
export type PdInput = {
    month: string; asOf?: string; joiningDate?: string; exitDate?: string;
    attendance: PdAttendance[]; leaves: PdLeave[]; holidays: string[]; violations: PdViolation[];
    removed: Map<string, { removedAt?: string; removedByName?: string; removalReason?: string }>;
    paidLeavePerMonth?: number; weeklyOff?: number[];
    /** HR payable-day corrections (ACTIVE), by date */
    corrections?: Map<string, PdCorrection>;
    /** dates with a pending Late Justification (latejustifications) */
    lateJustificationPending?: Set<string>;
    /** rejected Full Attire reviews */
    fullAttire?: PdFullAttire[];
};

export const LEVEL_LABEL: Record<string, string> = {
    FIRST_WARNING: 'First Warning', SECOND_WARNING: 'Second Warning', FINAL_WARNING: 'Final Warning',
    HALF_DAY: 'Half-Day Deduction', FULL_DAY: 'Full-Day Deduction', TWO_DAY: '2-Day Deduction', MISSING_ALERT: 'Missing Clock-Out Alert',
    FINE_10: '10% Fine', FINE_20: '20% Fine', FINE_30: '30% Fine',
};
export const TYPE_LABEL: Record<string, string> = { LATE_IN: 'Late Clock-In', EARLY_OUT: 'Early Clock-Out', MISSING_OUT: 'Missing Clock-Out', DRESS_CODE: 'Dress Code', FULL_ATTIRE: 'Full Attire', LOCATION_MISMATCH: 'Location Mismatch' };
export const CATEGORY_OF: Record<string, string> = { LATE_IN: 'CLOCK_IN', EARLY_OUT: 'CLOCK_OUT', MISSING_OUT: 'CLOCK_OUT', DRESS_CODE: 'DRESS_CODE', FULL_ATTIRE: 'DRESS_CODE', LOCATION_MISMATCH: 'LOCATION' };
/** HR statuses that close a violation (not counted) */
export const VIOLATION_CLOSED = ['Waived', 'Approved'];

/** Old (before POLICY_FROM) dress-code ladder: 1–3 warnings, 4th Half-Day, 5th+ Full-Day */
export function ladder(instance: number) {
    if (instance <= 1) return { level: 'FIRST_WARNING', deduction: 'None' };
    if (instance === 2) return { level: 'SECOND_WARNING', deduction: 'None' };
    if (instance === 3) return { level: 'FINAL_WARNING', deduction: 'None' };
    if (instance === 4) return { level: 'HALF_DAY', deduction: 'Half-Day' };
    return { level: 'FULL_DAY', deduction: 'Full-Day' };
}
/** Late Clock-In from POLICY_FROM: 1, 2 warnings · 3 Half-Day · 4 Full-Day · 5+ 2 days */
export function lateLadder(n: number) {
    if (n <= 1) return { level: 'FIRST_WARNING', deduction: 'None' };
    if (n === 2) return { level: 'SECOND_WARNING', deduction: 'None' };
    if (n === 3) return { level: 'HALF_DAY', deduction: 'Half-Day' };
    if (n === 4) return { level: 'FULL_DAY', deduction: 'Full-Day' };
    return { level: 'TWO_DAY', deduction: '2 Day' };
}
/** Early Clock-Out renumbering (lateEarlyNumbers): 1–3 None · 4 Half-Day · 5+ Full-Day */
export function earlyLadder(n: number) {
    if (n <= 1) return { level: 'FIRST_WARNING', deduction: 'None' };
    if (n === 2) return { level: 'SECOND_WARNING', deduction: 'None' };
    if (n === 3) return { level: 'FINAL_WARNING', deduction: 'None' };
    if (n === 4) return { level: 'HALF_DAY', deduction: 'Half-Day' };
    return { level: 'FULL_DAY', deduction: 'Full-Day' };
}
/** Dress Code / Full Attire % fine from POLICY_FROM: 3rd 10% · 4th 20% · 5th+ 30% */
export const finePercent = (n: number) => (n <= 2 ? 0 : n === 3 ? 10 : n === 4 ? 20 : 30);

/** proposedDeduction text → days: "2 day" → 2 · "full" → 1 · "half" → 0.5 · else 0 */
export const units = (d?: string) => {
    const s = String(d || '');
    return /2\s*-?\s*day/i.test(s) ? 2 : /full/i.test(s) ? 1 : /half/i.test(s) ? 0.5 : 0;
};
const approvedForPayroll = (s?: string) => /approved for payroll/i.test(String(s || ''));

export type PenaltyItem = {
    flagId: string; date: string; type: string; typeLabel: string; category: string;
    instance: number | null; level: string; levelLabel: string; deduction: string;
    status: string;              // Warning | Deducted | Fine | Pending HR Verification | Awaiting Explanation | On Hold | Waived | Resolved | Removed | Flag
    deductedDays: number;        // days this penalty takes (can be 2)
    /** % of one day's gross (Dress Code / Full Attire from POLICY_FROM) */
    finePercent?: number;
    active: boolean;             // an active flag
    detail?: string;
    removal?: { removedAt?: string; removedByName?: string; removalReason?: string };
};
export type FineItem = { flagId: string; type: 'DRESS_CODE' | 'FULL_ATTIRE'; date: string; instance: number; percent: number };
export type DayRow = {
    date: string; weekday: string; attendance: string; leave: string;
    payableStatus: 'Payable' | 'Non-Payable' | 'Partly Payable' | 'Upcoming' | 'Not Employed';
    payable: number; lop: number; reason: string; penalties: string[];
    clockIn?: string; clockOut?: string; holiday?: boolean; weeklyOff?: boolean;
    /** penalty days of this date that are above one day (taken from the month total) */
    extraPenalty?: number;
    basePayableStatus?: string; basePayable?: number; baseReason?: string;
    correctable?: boolean;
    deductible?: boolean;
    correction?: PdCorrection;
};

const pad = (n: number) => String(n).padStart(2, '0');
export const daysInMonth = (month: string) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const dow = (date: string) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const nextDay = (d: string) => { const [y, m, day] = d.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, day + 1)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
const r2 = (n: number) => Math.round(n * 100) / 100;
const isApproved = (s?: string) => /^approved$/i.test(String(s || ''));
const isPending = (s?: string) => /pending/i.test(String(s || ''));
const isShort = (l: PdLeave) => /short/i.test(`${l.type || ''} ${l.leaveType || ''}`);
const statusOf = (hr: string | undefined, u: number) =>
    approvedForPayroll(hr) ? (u ? 'Deducted' : 'Warning')
        : hr === 'Waived' ? 'Waived'
            : hr === 'Approved' ? 'Resolved'
                : /pending hr/i.test(String(hr || '')) ? 'Pending HR Verification'
                    : /awaiting/i.test(String(hr || '')) ? 'Awaiting Explanation'
                        : /rejected/i.test(String(hr || '')) ? 'Explanation Rejected'
                            : 'Warning';

export function calculatePayableDays(input: PdInput) {
    const N = daysInMonth(input.month);
    const weeklyOff = input.weeklyOff || [0];
    const holidays = new Set(input.holidays || []);
    const ljPending = input.lateJustificationPending || new Set<string>();
    const att = new Map<string, PdAttendance>();
    for (const a of input.attendance || []) if (a?.date) att.set(a.date, a);

    // ── leave units per day ──
    const approvedLeave = new Map<string, { u: number; label: string }>();
    const pendingLeave = new Map<string, string>();
    for (const l of input.leaves || []) {
        if (!l?.startDate || isShort(l)) continue;
        const half = typeof l.days === 'number' && l.days > 0 && l.days < 1;
        const label = l.type || l.leaveType || 'Leave';
        for (let d = l.startDate; d <= (l.endDate || l.startDate); d = nextDay(d)) {
            if (!d.startsWith(input.month)) continue;
            if (isApproved(l.status)) {
                const prev = approvedLeave.get(d);
                approvedLeave.set(d, { u: Math.min(1, (prev?.u || 0) + (half ? 0.5 : 1)), label });
            } else if (isPending(l.status)) pendingLeave.set(d, label);
        }
    }

    // ── penalties / flags ──
    const penalties: PenaltyItem[] = [];
    const fines: FineItem[] = [];
    const inMonth = (input.violations || []).filter(x => x?.date?.startsWith(input.month)).sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
    let lateN = 0, earlyN = 0;
    for (const v of inMonth) {
        const flagId = `VIO:${v.id}`;
        const rem = input.removed.get(flagId);
        const closed = VIOLATION_CLOSED.includes(String(v.hrStatus || ''));
        const base = {
            flagId, date: v.date, type: v.type, typeLabel: TYPE_LABEL[v.type] || v.type, category: CATEGORY_OF[v.type] || 'OTHER',
            detail: v.actualTime ? `${v.scheduledTime ? `Scheduled ${v.scheduledTime} · ` : ''}Actual ${v.actualTime}` : undefined,
            ...(rem ? { removal: rem } : {}),
        };
        if (rem) {
            penalties.push({ ...base, instance: null, level: v.level || '', levelLabel: LEVEL_LABEL[v.level || ''] || v.level || '', deduction: 'None', status: 'Removed', deductedDays: 0, active: false });
            continue;
        }
        if (v.type === 'LATE_IN') {
            const onHold = !closed && ljPending.has(v.date);
            if (closed || onHold) {
                penalties.push({ ...base, instance: null, level: v.level || '', levelLabel: LEVEL_LABEL[v.level || ''] || v.level || '', deduction: 'None', status: onHold ? 'On Hold (justification pending)' : statusOf(v.hrStatus, 0), deductedDays: 0, active: !closed });
                continue;
            }
            lateN++;
            if (v.date >= POLICY_FROM) {
                const l = lateLadder(lateN), u = units(l.deduction);
                penalties.push({ ...base, instance: lateN, level: l.level, levelLabel: LEVEL_LABEL[l.level], deduction: l.deduction, status: u ? 'Deducted' : 'Warning', deductedDays: u, active: true });
            } else {
                const u = units(v.proposedDeduction), ok = approvedForPayroll(v.hrStatus);
                penalties.push({ ...base, instance: lateN, level: v.level || '', levelLabel: LEVEL_LABEL[v.level || ''] || v.level || '', deduction: v.proposedDeduction || 'None', status: statusOf(v.hrStatus, u), deductedDays: ok ? u : 0, active: true });
            }
            continue;
        }
        if (v.type === 'EARLY_OUT') {
            if (closed) {
                penalties.push({ ...base, instance: null, level: v.level || '', levelLabel: LEVEL_LABEL[v.level || ''] || v.level || '', deduction: v.proposedDeduction || 'None', status: statusOf(v.hrStatus, 0), deductedDays: 0, active: false });
                continue;
            }
            earlyN++;
            let deduction = v.proposedDeduction || 'None', level = v.level || '', hr = v.hrStatus;
            if (v.date >= POLICY_FROM) {
                const l = earlyLadder(earlyN);
                deduction = l.deduction; level = l.level;
                if (!hr || /^not required$/i.test(hr) || /^pending hr verification$/i.test(hr)) hr = earlyN <= 3 ? 'Not Required' : 'Pending HR Verification';
            }
            const u = units(deduction);
            penalties.push({ ...base, instance: earlyN, level, levelLabel: LEVEL_LABEL[level] || level, deduction, status: /^not required$/i.test(String(hr)) ? 'Warning' : statusOf(hr, u), deductedDays: approvedForPayroll(hr) ? u : 0, active: true });
            continue;
        }
        if (v.type === 'MISSING_OUT') {
            penalties.push({ ...base, instance: null, level: v.level || 'MISSING_ALERT', levelLabel: LEVEL_LABEL[v.level || 'MISSING_ALERT'] || v.level || '', deduction: 'None', status: closed ? statusOf(v.hrStatus, 0) : 'Flag', deductedDays: 0, active: !closed });
            continue;
        }
        // LOCATION_MISMATCH (rejected half_day / full_day → automatic) and any other type
        const u = units(v.proposedDeduction);
        penalties.push({ ...base, instance: v.instance ?? null, level: v.level || '', levelLabel: LEVEL_LABEL[v.level || ''] || v.level || '', deduction: v.proposedDeduction || 'None', status: statusOf(v.hrStatus, u), deductedDays: approvedForPayroll(v.hrStatus) ? u : 0, active: !closed });
    }

    // dress code: the month's rejected photos, numbered in date order; removed ones do not count
    let dressN = 0;
    for (const a of (input.attendance || []).filter(x => x?.date?.startsWith(input.month) && x.dressCodeStatus === 'Rejected').sort((x, y) => x.date.localeCompare(y.date))) {
        const flagId = `DRESS:${String(a._id)}`;
        const rem = input.removed.get(flagId);
        const reasons = Array.isArray(a.dressCodeRejectionReasons) ? a.dressCodeRejectionReasons.join(', ') : '';
        if (rem) {
            penalties.push({ flagId, date: a.date, type: 'DRESS_CODE', typeLabel: 'Dress Code', category: 'DRESS_CODE', instance: null, level: '', levelLabel: '—', deduction: 'None', status: 'Removed', deductedDays: 0, active: false, detail: reasons || undefined, removal: rem });
            continue;
        }
        dressN++;
        if (a.date >= POLICY_FROM) {
            const pct = finePercent(dressN);
            const level = pct ? `FINE_${pct}` : (dressN === 1 ? 'FIRST_WARNING' : 'SECOND_WARNING');
            if (pct) fines.push({ flagId, type: 'DRESS_CODE', date: a.date, instance: dressN, percent: pct });
            penalties.push({ flagId, date: a.date, type: 'DRESS_CODE', typeLabel: 'Dress Code', category: 'DRESS_CODE', instance: dressN, level, levelLabel: LEVEL_LABEL[level], deduction: pct ? `${pct}% fine` : 'None', status: pct ? 'Fine' : 'Warning', deductedDays: 0, finePercent: pct || undefined, active: true, detail: reasons || undefined });
        } else {
            const l = ladder(dressN);
            penalties.push({ flagId, date: a.date, type: 'DRESS_CODE', typeLabel: 'Dress Code', category: 'DRESS_CODE', instance: dressN, level: l.level, levelLabel: LEVEL_LABEL[l.level], deduction: l.deduction, status: units(l.deduction) ? 'Deducted' : 'Warning', deductedDays: units(l.deduction), active: true, detail: reasons || undefined });
        }
    }
    // full attire: only from POLICY_FROM, own counter
    let faN = 0;
    for (const f of (input.fullAttire || []).filter(x => x?.date?.startsWith(input.month) && x.date >= POLICY_FROM).sort((x, y) => x.date.localeCompare(y.date) || x.id.localeCompare(y.id))) {
        const flagId = `FATTIRE:${f.id}`;
        const rem = input.removed.get(flagId);
        if (rem) {
            penalties.push({ flagId, date: f.date, type: 'FULL_ATTIRE', typeLabel: 'Full Attire', category: 'DRESS_CODE', instance: null, level: '', levelLabel: '—', deduction: 'None', status: 'Removed', deductedDays: 0, active: false, detail: f.reasons || undefined, removal: rem });
            continue;
        }
        faN++;
        const pct = finePercent(faN);
        const level = pct ? `FINE_${pct}` : (faN === 1 ? 'FIRST_WARNING' : 'SECOND_WARNING');
        if (pct) fines.push({ flagId, type: 'FULL_ATTIRE', date: f.date, instance: faN, percent: pct });
        penalties.push({ flagId, date: f.date, type: 'FULL_ATTIRE', typeLabel: 'Full Attire', category: 'DRESS_CODE', instance: faN, level, levelLabel: LEVEL_LABEL[level], deduction: pct ? `${pct}% fine` : 'None', status: pct ? 'Fine' : 'Warning', deductedDays: 0, finePercent: pct || undefined, active: true, detail: f.reasons || undefined });
    }

    penalties.sort((a, b) => a.date.localeCompare(b.date) || a.typeLabel.localeCompare(b.typeLabel));
    /** per date: day part (≤ 1) and the part above one day of each penalty */
    const penaltyByDate = new Map<string, { u: number; extra: number; labels: string[] }>();
    for (const p of penalties) {
        const cur = penaltyByDate.get(p.date) || { u: 0, extra: 0, labels: [] };
        if (p.deductedDays) {
            cur.u = Math.min(1, cur.u + Math.min(1, p.deductedDays));
            cur.extra = r2(cur.extra + Math.max(0, p.deductedDays - 1));
        }
        if (p.status !== 'Removed') cur.labels.push(`${p.typeLabel}${p.levelLabel && p.levelLabel !== '—' ? ` — ${p.levelLabel}` : ''}`);
        penaltyByDate.set(p.date, cur);
    }

    // ── day by day ──
    let entitlementLeft = input.paidLeavePerMonth ?? 1;
    const days: DayRow[] = [];
    let workingDays = 0, employedDays = 0, presentDays = 0, paidLeave = 0, unpaidLeave = 0, absentDays = 0, penaltyDays = 0;
    let holidayDays = 0, weeklyOffDays = 0, upcomingDays = 0, pendingLeaveDays = 0, correctedDays = 0, hrDeductedDays = 0;
    /** HR correction on top of the records (attendance / leave shown on the row stay as recorded) */
    const applyCorrection = (row: DayRow) => {
        const corr = input.corrections?.get(row.date);
        if (!corr) return;
        const who = `${corr.correctedByName || 'HR'}${corr.correctedByRole ? ` (${corr.correctedByRole})` : ''}`;
        const half = /^half$/i.test(String(corr.payableType || ''));
        const target = half ? 0.5 : corr.direction === 'TO_NON_PAYABLE' ? 0 : 1;
        const before = row.payable;
        // the day's 2-day extra penalty is never taken on a corrected day
        const hadExtra = row.extraPenalty || 0;
        if (target === before && !hadExtra) return;
        if (target > before) correctedDays = r2(correctedDays + (target - before));
        if (target < before) hrDeductedDays = r2(hrDeductedDays + (before - target));
        row.correction = corr; row.correctable = false; row.deductible = false; row.extraPenalty = 0;
        row.payable = target; row.lop = r2(1 - target);
        row.payableStatus = target >= 1 ? 'Payable' : target > 0 ? 'Partly Payable' : 'Non-Payable';
        const label = half ? 'half day payable' : target ? 'payable' : 'non-payable';
        row.reason = `Marked ${label} by ${who} — ${corr.correctionCategory || 'Correction'} · Records: ${row.baseReason}`;
    };
    for (let i = 1; i <= N; i++) {
        const date = `${input.month}-${pad(i)}`;
        const off = weeklyOff.includes(dow(date)), hol = holidays.has(date);
        if (!off && !hol) workingDays++;
        const row: DayRow = { date, weekday: WD[dow(date)], attendance: '—', leave: '', payableStatus: 'Payable', payable: 1, lop: 0, reason: '', penalties: penaltyByDate.get(date)?.labels || [], holiday: hol, weeklyOff: off };
        if ((input.joiningDate && date < input.joiningDate) || (input.exitDate && date > input.exitDate)) {
            Object.assign(row, { payableStatus: 'Not Employed', payable: 0, reason: input.joiningDate && date < input.joiningDate ? 'Before joining date' : 'After last working day' });
            days.push(row); continue;
        }
        employedDays++;
        const a = att.get(date);
        const wfh = !!a && (a.workMode === 'WFH' || String(a.location || '').toLowerCase() === 'wfh');
        const present = !!a && !/absent/i.test(String(a.status || '')) && (!!a.clockIn || /present|late/i.test(String(a.status || '')) || wfh);
        if (a) { row.clockIn = a.clockIn || ''; row.clockOut = a.clockOut || ''; }
        if (a) row.attendance = wfh ? 'WFH' : (a.status || (a.clockIn ? 'Present' : '—'));
        if (input.asOf && date > input.asOf) {
            Object.assign(row, { payableStatus: 'Upcoming', reason: 'Not yet worked (projected as payable)' });
            upcomingDays++; days.push(row); continue;
        }
        if (hol || off) {
            if (hol) holidayDays++; else weeklyOffDays++;
            row.attendance = row.attendance === '—' ? (hol ? 'Holiday' : 'Weekly Off') : row.attendance;
            row.reason = hol ? 'Holiday (paid)' : 'Sunday — weekly off (paid)';
            row.basePayableStatus = row.payableStatus; row.basePayable = row.payable; row.baseReason = row.reason;
            row.correctable = false; row.deductible = true;
            applyCorrection(row);
            days.push(row); continue;
        }
        let lop = 0; const why: string[] = [];
        const lv = approvedLeave.get(date);
        if (lv) {
            const paid = Math.min(lv.u, entitlementLeft); entitlementLeft = r2(entitlementLeft - paid);
            const unpaid = r2(lv.u - paid);
            paidLeave += paid; unpaidLeave += unpaid; lop += unpaid;
            row.leave = `${lv.u < 1 ? 'Half-day ' : ''}${lv.label}${paid ? ` · ${paid} paid` : ''}${unpaid ? ` · ${unpaid} unpaid` : ''}`;
            if (paid) why.push(`Approved paid leave (${paid} day${paid === 1 ? '' : 's'}, monthly paid leave)`);
            if (unpaid) why.push(`Approved leave beyond the monthly paid leave → unpaid (${unpaid} day)`);
            if (lv.u < 1) {
                if (present) presentDays += 0.5;
                else { lop += 0.5; absentDays += 0.5; why.push('No attendance for the other half of the day → unpaid (0.5 day)'); }
            }
        } else if (present) {
            presentDays++; why.push(row.attendance === 'WFH' ? 'Work from home (payable)' : 'Present');
        } else {
            lop = 1; absentDays++;
            if (pendingLeave.has(date)) { pendingLeaveDays++; row.leave = `${pendingLeave.get(date)} (pending)`; why.push('Leave pending approval — unpaid until it is approved'); }
            else why.push(a ? 'Absent (loss of pay)' : 'No attendance on a working day (loss of pay)');
        }
        const pen = penaltyByDate.get(date);
        let applied = 0;
        if (pen?.u) {
            applied = Math.min(pen.u, Math.max(0, 1 - lop));
            if (applied) { lop += applied; why.push(`Penalty deduction ${applied} day`); }
        }
        if (pen?.extra) { row.extraPenalty = pen.extra; why.push(`Penalty above one day: ${pen.extra} day from the month total`); }
        row.lop = r2(lop); row.payable = r2(1 - lop);
        row.payableStatus = lop >= 1 ? 'Non-Payable' : lop > 0 ? 'Partly Payable' : 'Payable';
        row.reason = why.join(' · ');
        row.basePayableStatus = row.payableStatus; row.basePayable = row.payable; row.baseReason = row.reason;
        row.correctable = row.lop > 0;
        row.deductible = row.payable > 0;
        applyCorrection(row);
        // penalty days count only when HR has not corrected the day
        if (!row.correction && applied) penaltyDays = r2(penaltyDays + applied);
        days.push(row);
    }
    const extraDays = r2(days.reduce((s, d) => s + (d.extraPenalty || 0), 0));
    penaltyDays = r2(penaltyDays + extraDays);
    const lopDays = r2(Math.min(employedDays, days.reduce((s, d) => s + d.lop, 0) + extraDays));
    return {
        month: input.month, provisional: !!input.asOf, asOf: input.asOf || null,
        totalDays: N, workingDays, employedDays,
        payableDays: r2(employedDays - lopDays),
        presentDays: r2(presentDays), holidayDays, weeklyOffDays, upcomingDays,
        paidLeaveEntitlement: input.paidLeavePerMonth ?? 1,
        paidLeaves: r2(paidLeave), unpaidLeaves: r2(unpaidLeave), absentDays: r2(absentDays), pendingLeaveDays,
        penaltyDays: r2(Math.min(penaltyDays, lopDays)), extraPenaltyDays: extraDays, lopDays,
        nonPayableDays: lopDays,
        basePayableDays: r2(employedDays - lopDays - correctedDays + hrDeductedDays),
        correctedDays, hrDeductedDays,
        activeFlags: penalties.filter(p => p.active).length,
        dressCodeViolations: penalties.filter(p => p.type === 'DRESS_CODE' && p.status !== 'Removed').length,
        dressCodeDeductionDays: r2(penalties.filter(p => p.type === 'DRESS_CODE').reduce((s, p) => s + p.deductedDays, 0)),
        pendingPenalties: penalties.filter(p => p.status === 'Pending HR Verification' || p.status === 'Awaiting Explanation').length,
        removedFlags: penalties.filter(p => p.status === 'Removed').length,
        /** Dress Code + Full Attire % fines (FMS turns them into rupees) */
        fines,
        penalties, days,
    };
}
export type PayableCalc = ReturnType<typeof calculatePayableDays>;