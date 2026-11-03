# GOG FMS — Architecture, OMS Integration & Test Report

Source of truth for OMS facts: *GOG OMS Technical Architecture & Integration Handover* (read-only analysis). Nothing in OMS was changed.

## 1. Structure
```
src/
  app/(app)/…            pages (dashboard, employees, payroll, salary-structures, payslips, invoices, challans, reports, email-management, audit, settings)
  app/login              OMS-style login, FMS texts, no role dropdown
  app/api/**             24 route handlers — every one calls requireUser(<permission>)
  components/            FmsShell (sidebar/top bar), ui.tsx (OMS patterns), EmployeeDetail, TrendChart
  lib/
    db.ts                cached Mongoose connection (OMS pattern, WITHOUT onDbConnected index creation)
    oms-read.ts          the ONLY module that reads OMS collections
    payable-days.ts      PURE payable-days engine (per-day trace)
    payroll-calc.ts      PURE salary engine (paise)
    payroll-service.ts   loads OMS inputs + structures + adjustments → engine
    payroll-run.ts       run lifecycle, maker-checker, disbursement (idempotent)
    payslip-*.ts         server-side jsPDF payslip, S3 storage, de-duplicated email
    s3.ts / fms-mail.ts  prefix-confined S3, nodemailer
    session.ts / auth.ts / permissions.ts / password.ts / audit.ts / policy.ts / reports.ts
  models/oms-readonly.ts read-only OMS models (write middleware throws)
  models/fms.ts          all fms_* collections
scripts/grant-access.ts  bootstrap first FMS_ADMIN
tests/                   node:test via tsx
```

## 2. OMS data consumed (read-only)
| FMS need | OMS collection / field | Rule applied |
|---|---|---|
| Employee directory | `employees` (`id`, name, email, role, dept, designation→fallback `current_designation_at_gog`, location, status, joiningDate, fines.records) | `isRemoved ≠ true` added explicitly; `password`, PAN/Aadhaar/bank fields never selected (except `password` inside login only) |
| Active count | `employees.status ∈ policy.activeStatuses`, role ∉ `policy.excludedRoles` (default FOUNDER) | configurable |
| Exit date | `exitrecords.lastWorkingDay` | days after it are NOT_EMPLOYED |
| Weekly off / working day | `workschedules` exact date > weekday ("Mon".."Sun") > `policy.weeklyOffDays` (default Sunday) | location "Holiday" = off |
| Holidays | `holidays` status Approved and (`forAll` or employee location ∈ `collegeIds`) | |
| Presence | `attendances` (one per day): clockIn or status Present/Late; WFH counted; `HR_MANUAL` corrections already in record | WFH with `wfhStatus` Rejected → flagged |
| Absent | `attendances.status = "Absent"` | LOP |
| No record | — | **not auto-LOP**: policy `missingRecordTreatment` (default payable + flag) |
| Leave | `leaverequests` Approved; `days` spread over the leave's working days (0.5 = half day); `classification` Paid/Unpaid | paid leave over `paidLeaveMonthlyCap` → LOP + flag; pending → policy |
| Leave LOP | `leaverequests.lossOfPayDays` (rejected emergency) | added if `includeOmsLeaveLop` |
| Penalties | `attendanceviolations` with `hrStatus = "Approved for Payroll"` only; Half-Day/Full-Day → policy days; `employees.fines.records[]` dated in month | |
| Salary | **none in OMS** (legacy `employees.salary` ignored) | FMS salary structures |

OMS APIs are never called. FMS never writes, indexes, or renames OMS collections (`autoIndex:false`, `autoCreate:false`, write hooks throw `OmsWriteBlockedError` — covered by a unit test). Recommended: an FMS-only MongoDB user with `read` on OMS collections and `readWrite` on `fms_*`.

## 3. FMS collections
`fms_access` · `fms_settings` (payrollPolicy, permissions) · `fms_login_attempts` (TTL 1 h) · `fms_salary_structures` (unique employeeId+effectiveFrom; versions never edited) · `fms_payroll_runs` (unique month, status history, policy snapshot) · `fms_payroll_entries` (unique month+employeeId; attendance trace + calc) · `fms_payroll_adjustments` · `fms_payslips` (unique employeeId+month, S3 key) · `fms_client_invoices` · `fms_statutory_challans` (unique type+year+month, version history) · `fms_financial_transactions` (unique idempotencyKey `salary:<month>:<emp>`) · `fms_email_logs` (unique key `payslip:<emp>:<month>`) · `fms_audit_logs` (append-only: update/delete hooks throw; no API to modify) · `fms_job_runs`.
All money is integer **paise**.

## 4a. Payable days = OMS (since 2 Nov 2026)
- `src/lib/oms-payable-days.ts` is a **verbatim copy** of OMS `src/lib/payable-days.ts` (`calculatePayableDays`). Do not edit; re-copy if OMS changes.
- `oms-read.loadMonthInputs` loads exactly what OMS `payableForMany` loads: `attendances`, `leaverequests`, `holidays` (Approved), `attendanceviolations`, `exitrecords`, `flagremovals`, `payablecorrections` (ACTIVE), `locationjustifications` (rejected → day penalty or ₹), `employees.noticePeriod.lastWorkingDay`.
- Employee list = OMS `salaryEmployees` rule (no founders, joined by month end, exit not before month start).
- HR changes in OMS (payable / non-payable correction, mark present/absent, approve-for-payroll / waive, flag removal, leave/WFH, dress code, location decision) flow into FMS automatically:
  - Employee Management: live on every view.
  - Payroll Draft / Under Review: auto-recalculated on view (≤1/min) and by daily cron `/api/cron/oms-sync`; changed rows flagged `UPDATED_FROM_OMS` with previous values.
  - Approved: approve/finalize re-checks OMS; changes block finalize ("send back to review").
  - Finalized / Disbursed: never changed; differences shown as a warning (drift).
  - An FMS HR adjustment on payable / LOP / penalty days or ₹ penalty is ignored once OMS data for it changes later (OMS value wins, shown in the employee view).
- Penalty days are already part of OMS LOP → FMS never deducts them twice; the payslip only splits LOP vs "Penalties". ₹ penalties = OMS `monetaryPenalties` (location mismatch). `employees.fines` is off by default (OMS does not use it).

## 4. Payroll rules
- Payable days per day = paid portion; LOP = unpaid portion; every day carries its source (visible in *Employee → Day-wise Attendance*).
- `CALENDAR_DAYS`: fraction = payable / days-in-month. `FIXED n`: fraction = (n − unpaid)/n, unpaid = days-in-month − payable (so ₹40,000 × 28/30 = ₹37,333.33 — unit-tested).
- Earned component = round(component × fraction). Payslip shows full monthly components under Earnings and **LOP** under Deductions.
- Penalty = round(gross/divisor) × penalty days + penalty amount (fines). EPF/PT/TDS = per structure, FIXED or % of earned basic, **rate typed in by Accounts — FMS assumes none**.
- Net rounded per policy, floored at 0 (flagged).
- HR adjustments (payableDays, lopDays, penaltyDays, penaltyAmount, otherEarnings, otherDeductions): reason ≥ 10 chars, original + updated value, who/when; locked once payroll is Approved.
- Lifecycle: Draft → Under Review → Approved → Finalized → Disbursed. Approve/Finalize require **confirmed policy**, month ended, no missing structures; **maker-checker** (computer ≠ approver, except FMS_ADMIN). Disbursement is a separate event with date + reference and creates transactions (dashboard counts only these).
- Payslips only for Finalized/Disbursed runs. Scheduler (Vercel Cron daily 10:00 IST, `CRON_SECRET`): from `payslipEmailDay` (25) emails the previous month's payslips once each, retries failures daily, 200/day cap; if payroll isn't Finalized it sends **nothing** to employees and alerts finance users.

## 4b. Payslip emails (since 3 Nov 2026)
- **No automatic emailing.** `/api/cron/payslips` is disabled and removed from `vercel.json`. Emails go only when a user clicks Send.
- **Preview first:** `GET /api/payslips/email/preview?month&employeeId` returns the exact recipient, subject, HTML body and attached PDF; the UI shows it before Send. Bulk "Email Selected" shows a confirmation list; already-sent employees are skipped (resend needs a reason).
- **Archive:** every successful send stores `sentS3Key`, version, net pay, recipient, sender and a `sentHistory[]` on `fms_email_logs`. Payslip Management → "Sent Payslips (month-wise)" (`GET /api/payslips/archive`, `GET /api/payslips/archive/[id]/file`) opens exactly the PDF that was mailed, even if the payslip is regenerated later (S3 objects are never overwritten).

## 5. Security
Explicit `fms_access` allow-list (OMS login ≠ FMS access) · own HMAC cookie (`httpOnly`, `secure`, `sameSite=strict`, 10 h) with no secret fallback · grant/OMS status re-checked every request (revocation immediate) · login rate limit 5 fails / 15 min per identifier+IP · generic login errors · FMS never rewrites passwords and rejects empty stored passwords (OMS default passkey not honoured) · configurable permission matrix enforced on every API and export · S3 keys confined to `gog-fms/`, magic-byte type check, 10 MB limit, SSE, 5-min signed URLs after authorization, download audited · salary values hidden from users without `salary.view` · security headers (DENY framing, nosniff, HSTS).

## 6. Environment (no secrets)
`MONGODB_URI` · `FMS_SESSION_SECRET` (new, ≥32 chars) · `FMS_SESSION_HOURS` · `AWS_REGION` · `AWS_BUCKET_NAME` · `FMS_AWS_ACCESS_KEY_ID` / `FMS_AWS_SECRET_ACCESS_KEY` (FMS-only IAM: `s3:PutObject`, `s3:GetObject` on `arn:aws:s3:::<bucket>/gog-fms/*`) · `FMS_S3_PREFIX` · `SMTP_HOST/PORT/SECURE/USER/PASS` · `APP_URL` · `TZ_NAME=Asia/Kolkata` · `CRON_SECRET` (new) · `PAYSLIP_EMAIL_DAY` · `FMS_BOOTSTRAP_ADMIN_IDS` (script only).

## 7. Test report (run 29 Oct 2026, sandbox)
| Check | Result |
|---|---|
| `tsc --noEmit` (strict) | ✅ 0 errors |
| `next build` (Next 16.1.6, Turbopack) | ✅ 33 routes — built with Google Fonts stubbed because the sandbox blocks fonts.googleapis.com; on Vercel the real `next/font` import is used (same as OMS) |
| Unit tests `npm test` | ✅ 24/24 — spec example ₹37,333.33, calendar/fixed divisor, Sunday off, missing clock-in not LOP, Absent = LOP, half-day leave, paid-leave cap, leave spanning Sunday, holiday by location, only "Approved for Payroll" violations, mid-month joiner, HR override, EPF %/PT/TDS + rounding, pending leave flag, OMS leave LOP toggle, schedule override, "so far" view, negative net clamp, FY helpers, password (plain/scrypt/empty), token tamper/expiry/OMS-token rejection, permission matrix, **OMS models refuse all writes**, S3 prefix + file sniffing |
| HTTP smoke on built server | ✅ pages 200 · all protected APIs 401 without session · OMS `gog_session` cookie rejected · forged FMS cookie rejected · cron 401 without/with wrong secret · login validation 400 · security headers present |

**Not tested here (no MongoDB/AWS/SMTP/OMS access in the sandbox) — must be done on staging before go-live:**
1. Login with real OMS credentials (plain + scrypt records, multi-designation emails).
2. Payable days against real OMS attendance/leave/schedule data — compare 3–5 employees with HR's manual numbers.
3. Full payroll run → approve (second user) → finalize → payslip PDF → S3 → email → disburse → dashboard.
4. S3 upload/download with the FMS IAM user; confirm writes outside `gog-fms/` are denied by IAM.
5. Cron on staging with `CRON_SECRET`; duplicate-send prevention across two runs.
6. **OMS regression**: OMS login, clock-in/out, leave apply/approve, HR attendance edit — before and after FMS is pointed at the shared DB; confirm no new indexes/collections other than `fms_*` (`db.getCollectionNames()`).
7. UI review side-by-side with OMS on desktop + mobile.

## 8. Open decisions for management (pre-filled defaults, all editable in Settings)
Payroll divisor · paid-leave cap · treatment of missing attendance & pending leave · violation day values · whether OMS `fines` count and their unit · rounding · payslip day/period · Accounts users list · FMS domain · whether `employees.salary` should seed salary structures (FMS ignores it today) · one challan per type per month (current model) vs multiple.