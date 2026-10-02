# Auto Fix

A mobile-first repair assistance platform connecting Washington drivers with participating shops and mobile mechanics.

**Live:** https://goldennftplatform-svg.github.io/autofix/

## Run locally

Requires Node.js 22 or later.

```sh
npm ci
npm run dev
```

Without Supabase environment variables, the app starts in **explicitly labeled demo mode**. Click **Explore the platform**, or **Sign in** and choose a workspace. Switch between provider, customer, and administrator with the demo selector. Changes persist in this browser. Demo role switching is not used for production authentication. No real payments are made.

```sh
npm test
npm run build
npm run preview
```

## Working features

- Public website, mobile navigation, responsive provider feed, search and filters.
- Customer/provider application and manual administrator review.
- Google OAuth and email magic-link sign-in when Supabase is connected.
- Approved-customer ticket submission, vehicle snapshots, private photos.
- Shop/mobile/general service matching by city, service type, and specialty.
- Atomic job claims; itemized estimates; customer consent; administrator funding authorization.
- Funding reservations serialized per customer, including across simultaneous tickets.
- Repair start, itemized final invoice, completion review, disputes, and documented administrator resolution.
- Calendar-day payment schedule: verified completion + 32 days in Washington local time, including DST changes.
- Payment records, holds, overdue indicators, payment references, activity history.
- In-app notifications, Supabase realtime notifications, and a 30-second refresh fallback.
- Server-side role checks and private photo storage. No client-controlled admin signup.

## Connect production authentication and data

1. Create a Supabase project and run `supabase/migrations/202610020001_autofix.sql` once in its SQL editor. Use a fresh project or review existing schema before applying. This creates tables, checked RPCs, RLS, private storage, and realtime notification publication.
2. In **Authentication → Sign-in / Providers**, enable Google. Create a Google OAuth web client; its authorized redirect URI is `https://YOUR_PROJECT.supabase.co/auth/v1/callback`. Put the Google client ID and secret into Supabase, never this repository.
3. Set Supabase **Site URL** to `https://goldennftplatform-svg.github.io/autofix/`. Add that URL and `http://localhost:5173/` to **Redirect URLs**. Enable email magic links if desired; configure SMTP for production email delivery.
4. Copy `.env.example` to `.env` for local development. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to the project URL and **publishable/anon** key. Never use the secret/service-role key in any `VITE_` variable.
5. For GitHub Pages, add repository **Actions variables**, not source files:

   ```sh
   gh variable set VITE_SUPABASE_URL --repo goldennftplatform-svg/autofix --body "https://YOUR_PROJECT.supabase.co"
   gh variable set VITE_SUPABASE_ANON_KEY --repo goldennftplatform-svg/autofix --body "YOUR_PUBLIC_ANON_OR_PUBLISHABLE_KEY"
   gh workflow run deploy.yml --repo goldennftplatform-svg/autofix
   ```

6. Sign up as a customer first. To bootstrap the first administrator, use the **Supabase SQL editor** (privileged operator access):

   ```sql
   update public.profiles
   set role = 'admin', approval = 'approved'
   where id = (select id from auth.users where email = 'YOUR_ADMIN_EMAIL');
   ```

   Refresh the app. Subsequent account approvals and funding allocations use the admin workspace.

## Deployment

Every push to `main` runs tests and builds the app, then deploys to GitHub Pages through `.github/workflows/deploy.yml`. Configure repository **Settings → Pages → Source → GitHub Actions**. The app uses in-app navigation, so static hosting does not require a server rewrite.

For a custom domain or another static host, use build command `npm run build`, output directory `dist`, and `VITE_BASE_PATH=/`. For GitHub project Pages it is `/autofix/`.

## End-to-end demo walkthrough

1. Enter the provider workspace. Open **Front brakes making a grinding noise** and claim it.
2. Submit an itemized estimate with a total below the customer’s remaining funding.
3. Switch to **Customer**, open that request, and approve the estimate.
4. Switch to **Administrator**, open it, and authorize funding.
5. Switch to **Service provider → My jobs**, start the repair, and submit completed work and the final invoice.
6. Switch to **Customer** and confirm completion.
7. Open **Payments** to see the 32-calendar-day schedule.
8. As **Administrator**, open the payment and record a disbursement reference. The provider then sees it as paid.

To reset demo data, delete the `autofix-demo-v1` local-storage key in browser developer tools and reload. No real customer data should be entered into demo mode.

## Program and payment policy

This is an independent MVP, **not a verified state-program integration**. The program name, eligibility criteria, support contact, and actual disbursement agreement were not provided. A program operator must validate the proposed 32-day terms before onboarding real participants. The UI explicitly distinguishes scheduled payments from funds actually paid.

Current versioned terms are `2026-10-v1` (`src/domain.ts` and the migration). Update both application and database policy together with a new acceptance version if terms change. Provider participation requires reacceptance after a policy-version update. Payments are recorded manually; no banking details are collected and no funds are transferred.

## Scope and implementation notes

- Vehicle, estimate, invoice, and payment snapshots live in the ticket JSONB aggregate. Customer/provider identities and assignments are relational foreign keys. This keeps the MVP small while preserving transactional approval and funding checks.
- Funding uses integer cents. Completed repairs keep the full authorized reservation, conservatively preventing overspend. An invoice below the estimate does not automatically release the difference.
- Approved estimates are locked once work is authorized. Scope increases require administrator coordination and a new request; providers cannot bypass consent by increasing the final invoice.
- In-app alerts are implemented. Email job alerts and SMS are not enabled. `notifications` is the integration point for a future server-side mail worker; do not expose privileged keys or send mail from the browser.
- City matching is intentional; the map illustration is decorative, not live geolocation. No routing, distance calculations, scheduling integrations, or government eligibility APIs are claimed.
- Profile changes after review require administrator assistance. Funding expiration and document-based eligibility checks remain operator-managed.
- Optional customer ticket photos are private; final invoices are itemized records entered in the application. Uploaded PDF invoices and provider completion-photo uploads are future enhancements.

## Security model

Anonymous callers cannot read application tables or call protected RPCs. Authenticated users can read only their notification rows directly. All workspace data goes through a security-definer RPC that returns role-filtered records; public job cards exclude customer identities, contact details, private attachments, and availability. Assigned providers receive only the customer contact fields needed for service. Writes use authenticated RPCs with checked transitions and consistent lock ordering. Audit events are append-only through the client API. File uploads are limited to JPG/PNG/WebP, three ticket attachments, and 5 MB per image.

The test suite includes domain tests and database integration tests that execute the actual migration and RPCs in PostgreSQL via PGlite, with minimal mock Supabase auth/storage schemas. Tests cover role boundaries, private feed data, direct-table denial, funding reservations, invoice limits, disputes, and payment transitions. Hosted Google OAuth, storage delivery, and realtime connectivity still require verification against your configured Supabase project before accepting real participants.
