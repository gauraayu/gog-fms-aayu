# GOG FMS — Geeks of Gurukul Finance Management System

Independent finance web app (payroll, payslips, client invoices, EPF/GST/PT/TDS challans, reports) that **shares the GOG OMS MongoDB, employee identities, AWS S3 and SMTP — and nothing else**. Own repo, own deployment, own login/session, own APIs.

| | GOG OMS (unchanged) | GOG FMS (this repo) |
|---|---|---|
| Stack | Next.js 16.1.6 · React 19.2.4 · TS 5.9.3 · Tailwind 4.2.0 · Mongoose 9.2.4 | **identical pinned versions** + `recharts`, `tsx` (tests) |
| DB | `MONGODB_URI` | same DB · OMS collections **read-only** · writes only to `fms_*` |
| Login | `gog_session` cookie, `JWT_SECRET` | same OMS credentials · cookie `gog_fms_session` · secret `FMS_SESSION_SECRET` · explicit `fms_access` grant required |
| S3 | bucket root | same bucket, prefix `gog-fms/` only, private, SSE, 5-min signed GET |
| SMTP | nodemailer, auto-CC | same SMTP, sender "GoG FMS", **no CC** on salary mail |
| UI | dark, emerald `#10b981`, Inter/Outfit, `w-56` sidebar | same tokens & component patterns, FMS-owned copies |
| Host | Vercel `oms.geeksofgurukul.com` | separate Vercel project, e.g. `fms.geeksofgurukul.com` |

## Run locally
```bash
cp .env.example .env.local     # fill values — never commit
npm install
npm test                        # 24 unit tests (payroll engine + security)
npm run dev                     # http://localhost:3100
```
First admin (writes only to `fms_access` + `fms_audit_logs`):
```bash
FMS_BOOTSTRAP_ADMIN_IDS=EMP001 npx tsx scripts/grant-access.ts           # dry run
FMS_BOOTSTRAP_ADMIN_IDS=EMP001 npx tsx scripts/grant-access.ts --apply
```
Then sign in → **Settings → Payroll Policy** → Founder reviews & **Save & Confirm** (payroll can't be approved before this) → **Settings → FMS Access** to add HR / Accounts / Founders.

### Test users (temporary, built-in)
Login works **without any database** for now — 5 users are built into the code (`src/lib/test-users.ts`). Nothing is written to OMS or MongoDB.

| Role | Employee ID | Email | Password |
|---|---|---|---|
| FMS Admin | TEST-ADMIN | admin.test@fms.local | FmsTest@2026 |
| Founder | TEST-FOUNDER | founder.test@fms.local | FmsTest@2026 |
| HR | TEST-HR | hr.test@fms.local | FmsTest@2026 |
| HR Executive | TEST-HREXEC | hrexec.test@fms.local | FmsTest@2026 |
| Accounts | TEST-ACCOUNTS | accounts.test@fms.local | FmsTest@2026 |

- ON automatically while `MONGODB_URI` is empty → **OFF automatically once the real DB is connected**.
- Without the DB, pages open but data sections show "Database not connected yet".
- Remove permanently later: delete `src/lib/test-users.ts` and its two uses (login route, `auth.ts`).

Copy `public/3D.png` from OMS into `public/` so the login background matches exactly.

## Pages
Dashboard · Employee Management · Payroll Management · Salary Structures · Payslip Management · Client Invoices · EPF, GST, PT & TDS Challans · Financial Reports · Email Management · Audit History · Settings

See **docs/ARCHITECTURE.md** for the OMS data mapping, collections, payroll rules, security model, env vars and the test report.
