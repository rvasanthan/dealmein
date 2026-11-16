# Deal Me In

*Great deals. Count me in.* A mobile-first site that lists shopping offers reported by sources, with search, filters, and administrator product entry.

Runtime stack: React + TypeScript + Tailwind (Vite), Firebase Hosting, Cloud Functions for Firebase (Node.js 22), Cloud Firestore, Firebase Storage.

> **Deployment status:** the frontend and Firestore Functions backend are live at `https://lifestyle-101.web.app`. The `backend/` Java/PostgreSQL service and Docker Compose files remain as a legacy local implementation and are not used by the Firebase deployment.
>
> Deal Me In stores its Firestore collections under `dealmein_*` and uploaded files under `dealmein/` in the project's Storage bucket to avoid colliding with other apps in `lifestyle-101`.

## Run Firebase locally

```bash
cd frontend && npm ci && npm run build
cd ../functions && npm ci
cd ..
firebase emulators:start --only hosting,functions,firestore,storage --project lifestyle-101
```

Google sign-in must be enabled in Firebase Authentication and the app domain must be authorized. `APP_ADMIN_USERNAME` is a Firebase Function secret containing the initial administrator's Google email (`vasanth.ravindran@gmail.com` in the deployed project). Other administrators are managed in the app; the initial administrator cannot be revoked through the UI. For local emulators, configure the corresponding Firebase Auth emulator and `functions/.secret.local` with `APP_ADMIN_USERNAME`.

For deployment, the `lifestyle-101` project needs a Firestore database; image uploads also require a default Storage bucket. Cloud Functions, scheduled functions, and Firebase Storage require Blaze billing; usage can incur charges.

## Legacy local PostgreSQL app

The former Spring Boot/PostgreSQL implementation is still available for reference:

```bash
cp .env.example .env
docker compose up --build
```

This legacy service is not the backend deployed by Firebase.

## Tests

```bash
cd functions && npm test && npm run lint
cd ../frontend && npm test && npm run lint && npm run build
```

## Behaviour

- **Deals** (`/api/deals`): approved Google users and administrators can browse imported drafts and published offers. Archived offers remain hidden. The catalog query scans visible records before filtering, so larger catalogs need a dedicated search/indexing design to control latency and Firestore reads.
- **Admin** (`/api/admin/*`): a verified Google Firebase ID token and administrator approval are required. The initial administrator can nominate Google emails or approve sign-in requests; approved administrators can manage deals and other administrator accounts. Access changes are audited.
- **Users**: Google sign-in creates a pending user request; an administrator can approve it as a normal user or administrator, change its role, or revoke access under Admin > Users. Revoking a user also revokes administrator access. Pending and revoked users are signed out after the request. Deal APIs require a verified Google token and check approval on every request.
- **Publishing**: the existing review and publish endpoints remain available, but are not required for imports or product entry.
- **Prices**: the listed cash price is separate from the source-reported price, rewards, shipping/tax and the advertised reference price. Unknown values are null. Price filters exclude offers without a listed cash price; price sorts put them last. A discount percentage appears only when an explicit reference price exists, and is not described as historical value.
- **Links**: valid product URLs lead directly to the retailer. When a product URL is absent, its detail page can link to the original publisher. Only http/https URLs are accepted.
- **Saved deals** are stored in the browser (`localStorage`); the UI says so and shows expired/unavailable states.

### Date rule

Exact timestamps (`starts_at`/`ends_at`) win. For date-only values, a sale starts at 00:00 on `starts_on` and ends at the first instant of the day after `ends_on` (so `ends_on` is inclusive), both in the **retailer's configured time zone** (default `APP_DEFAULT_RETAILER_TIMEZONE`, editable per retailer under Admin > Stores). Unknown or conflicting dates, missing dates, or date-only values without a time zone are shown as "unknown" and are never treated as active. A scheduler runs every 60 seconds and automatically marks published offers with known dates as expired.

## Importing

Upload JSON in Admin > Add products. Valid rows are imported automatically, and row errors are reported. Rows are keyed by source record ID; re-importing updates rather than duplicates, and administrator corrections are preserved. Archived offers are not automatically restored. Publisher URLs are not treated as retailer product links. Missing values stay null.

Administrators can also add a single product through `POST /api/admin/deals` with a Google Firebase ID token as the bearer token. Example JSON: `{ "title": "Desk lamp", "retailer": "Example Store", "category": "Home", "listed_cash_price": 19.99, "product_url": "https://example.com/lamp" }`. The endpoint returns the created deal ID. New entries are visible without a separate publish action.

Future authorized feeds can implement `com.dealmein.importer.ImportAdapter`. No connectors ship, and nothing refreshes automatically.

## Known limitations

- Rate limits for visitor reports are in-memory per instance and key on the socket address; behind a proxy all clients share one address unless forwarded headers are handled.
- USD only.
- Firebase Functions, Cloud Storage, and scheduled expiry require the Firebase project to be on Blaze. Firestore has no-cost quotas, but excess usage and other Firebase products can incur charges.
- Out of scope: AI analysis, price alerts, budgets, checkout, payments, and account-synced saved deals.
