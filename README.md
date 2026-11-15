# Deal Me In

*Great deals. Count me in.* A mobile-first site that lists shopping offers reported by sources, with search, filters, and an administrator review/publish workflow.

Stack: React + TypeScript + Tailwind (Vite), Spring Boot 3 (Java 21), PostgreSQL 16 with Flyway migrations, Docker Compose.

> **Status:** local only. Nothing is deployed, and no GitHub repo or Firebase project has been created. The real `DealPlate_Thanksgiving_Data` dataset has **not** been imported (see "Importing").

## Run locally

```bash
cp .env.example .env          # then set POSTGRES_PASSWORD, APP_ADMIN_PASSWORD_HASH, APP_JWT_SECRET
docker compose up --build     # site: http://localhost:5173  API: http://localhost:8080
```

Generate the administrator hash (keep the single quotes in `.env`):

```bash
pip install bcrypt && python3 -c "import bcrypt,getpass;print(bcrypt.hashpw(getpass.getpass().encode(),bcrypt.gensalt(10)).decode())"
```

Credentials are read by the backend only. Admin sign-in is at `/admin`.

Without Docker: run PostgreSQL, export `DATABASE_URL`, `DATABASE_USER`, `DATABASE_PASSWORD` and the `APP_*` variables from `.env.example`, then `cd backend && mvn spring-boot:run` and `cd frontend && npm install && npm run dev`.

## Tests

```bash
cd backend && mvn test        # needs PostgreSQL with a `dealmein_test` database (TEST_DATABASE_URL overrides); tables are truncated
cd frontend && npm test && npm run lint && npm run build
```

## Behaviour

- **Public** (`/api/deals`): only published offers, with server-side keyword (PostgreSQL full-text), category, retailer, price, timing, offer-type, sort and pagination. All state lives in URL parameters. Drafts, archived offers and unknown ids return 404.
- **Admin** (`/api/admin/*`, bearer token, 401 without it): import preview/commit/history/row issues, review queue and filters, editing with corrections, product-link and image handling, featured, status changes, visitor reports, audit log, merge preview, retailer time zones, CSV export.
- **Publishing** requires confirmation that identity, link, price, conditions and timing were checked, and refuses offers whose timing has expired. Editing price, date or link fields on a published offer returns it to draft.
- **Prices**: `listed_cash_price` is separate from the source-reported price, rewards, shipping/tax and the advertised reference price. Unknown values are null. Price filters exclude offers without a listed cash price; price sorts put them last. A discount percentage appears only when an explicit reference price exists, and is not described as historical value.
- **Links**: "Go to retailer" only for an admin-verified product URL; otherwise "View original listing" (publisher). Only http/https URLs are accepted.
- **Saved deals** are stored in the browser (`localStorage`); the UI says so and shows expired/unavailable states.

### Date rule

Exact timestamps (`starts_at`/`ends_at`) win. For date-only values, a sale starts at 00:00 on `starts_on` and ends at the first instant of the day after `ends_on` (so `ends_on` is inclusive), both in the **retailer's configured time zone** (default `APP_DEFAULT_RETAILER_TIMEZONE`, editable per retailer under Admin > Stores). Unknown or conflicting dates, missing dates, or date-only values without a time zone are shown as "unknown" and are never treated as active. A scheduler runs every 60 seconds and automatically marks published offers with known dates as expired.

## Importing

Upload JSON in Admin > Imports: preview, then commit. Rows are keyed by the source record ID; new rows are **drafts**; re-importing updates rather than duplicates; fields an administrator corrected are not overwritten; changes to price, conditions, rewards or dates add a `MATERIAL_CHANGE` flag and send a published offer back to draft; archived/expired/rejected offers are never republished. Publisher URLs are stored as listing links, never as retailer product links. Missing values stay null.

**Limitation:** the dataset ZIP never reached the development machine, so `JsonDatasetAdapter` maps fields through a generic alias table and was tested only with a synthetic fixture (`backend/src/test/resources/synthetic-fixture.json`). The real file's schema, counts and README still need to be inspected and the aliases adjusted before importing.

Future authorized feeds can implement `com.dealmein.importer.ImportAdapter`. No connectors ship, and nothing refreshes automatically.

## Known limitations

- Rate limits (visitor reports, admin login) are in-memory per instance and key on the socket address; behind a proxy all clients share one address unless forwarded headers are handled.
- USD only. Single administrator account configured by environment variables.
- Uploaded images are stored on local disk (`APP_UPLOAD_DIR`; a Docker volume in Compose).
- The admin screens were type-checked and built, but only the public flows were exercised in a browser.
- Out of scope: AI analysis, price alerts, budgets, checkout, payments, visitor accounts.
