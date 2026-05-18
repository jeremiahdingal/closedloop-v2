/**
 * Seed all 40 Shop Diary V3 production-readiness epics into ClosedLoop-v2.
 *
 * Usage:
 *   npx tsx scripts/seed-40day-plan.ts [--port 4010] [--dry-run]
 *
 * Each epic corresponds to one day of work with its own git branch.
 * scheduledDate controls when ClosedLoop will start executing each epic.
 */

const API_HOST = "http://127.0.0.1";
const DEFAULT_PORT = 4010;

const TARGET_DIR = "C:\\Users\\dinga\\Projects\\shop-diary-apps";

interface EpicInput {
  day: number;
  title: string;
  goalText: string;
  branch: string;
  scheduledDate: string;
}

const epics: EpicInput[] = [
  {
    day: 1,
    title: "Day 01 — Bug Fixes & Playwright Baseline",
    branch: "day-01-bug-fixes-baseline",
    scheduledDate: "2026-05-17",
    goalText: `Fix remaining bug backlog items in shop-diary-apps:

1. AddCategoryDialog query invalidation: In packages/app/dashboard/categories/screen.tsx, the AddCategoryDialog mutation has no onSuccess callback — categories list doesn't refresh after adding. Add useQueryClient + queryClient.invalidateQueries({ queryKey: ['categories'] }) in onSuccess.

2. Categories DELETE using unauthenticated fetcher: In packages/app/dashboard/categories/screen.tsx, useSWRMutation calls bare fetcher for DELETE. Replace with fetcherWithToken so the auth header is sent.

3. Audit ALL mutations across the codebase for the same auth-header bug pattern. Check items, orders, users, shop mutations for missing auth tokens.

After bug fixes, set up Playwright MCP and write baseline E2E tests for: login, dashboard load, cashier load, items list, categories list. All baseline tests must pass.

Project is a Turborepo monorepo: api/ (Cloudflare Workers), dashboard/web/ (Next.js port 3200), cashier/web/ (Next.js port 3201), packages/app/, packages/ui/. Uses Tamagui, Kysely, Zod, TanStack Query.`
  },
  {
    day: 2,
    title: "Day 02 — Fix Failing Tests & Test Infrastructure",
    branch: "day-02-test-infrastructure",
    scheduledDate: "2026-05-18",
    goalText: `Fix all currently failing tests in shop-diary-apps (14 tests failing).

Then add Vitest unit test infrastructure:
- Configure Vitest in packages/app, packages/ui, and api/ packages
- Configure test coverage reporting (istanbul/c8) with minimum 60% threshold
- Add test scripts to turbo.json pipeline
- Write unit tests for: auth middleware (api/src/middleware/), Zod schemas (api/src/schemas/), Kysely query builders, API error handlers
- Create test utilities: mock database, mock auth, test data factories

Tech stack: Cloudflare Workers (miniflare for testing), Kysely ORM, Zod validation, itty-router. Tests should use miniflare's test helpers for D1 database.`
  },
  {
    day: 3,
    title: "Day 03 — CI/CD Pipeline (GitHub Actions)",
    branch: "day-03-ci-cd",
    scheduledDate: "2026-05-19",
    goalText: `Create complete CI/CD pipeline for shop-diary-apps:

1. .github/workflows/ci.yml: Run on every PR — lint (eslint), typecheck (tsc --noEmit), unit tests (vitest), E2E tests (playwright). Use turborepo for parallel execution.

2. .github/workflows/deploy-api.yml: Deploy Cloudflare Workers API on merge to main. Use wrangler deploy. Set up staging (preview) and production environments.

3. .github/workflows/deploy-web.yml: Build and deploy Next.js apps (dashboard port 3200, cashier port 3201) on merge to main.

4. Add PR checks: code coverage threshold enforcement, bundle size diff comment, TypeScript strict mode verification.

5. Configure turborepo remote caching using GitHub Actions cache.

6. Add branch protection rules documentation in CONTRIBUTING.md.

Monorepo structure: api/ (Wrangler), dashboard/web/ (Next.js), cashier/web/ (Next.js), packages/. Uses yarn workspaces + turbo.`
  },
  {
    day: 4,
    title: "Day 04 — Docker & Development Environment",
    branch: "day-04-docker-devex",
    scheduledDate: "2026-05-20",
    goalText: `Create Docker and development environment for shop-diary-apps:

1. Dockerfile for API using miniflare (Cloudflare Workers local dev). Multi-stage build.

2. docker-compose.yml: API service, D1 database (SQLite), R2 mock (MinIO or similar). Network configuration for ports 8787 (API), 3200 (dashboard), 3201 (cashier).

3. .devcontainer/devcontainer.json for VS Code Codespaces with pre-built dev environment.

4. Makefile with standard commands: make dev, make test, make build, make deploy, make lint, make clean.

5. CONTRIBUTING.md with step-by-step setup instructions.

6. Verify that yarn install && yarn dev works from clean clone in under 5 minutes.

Tech: Turborepo monorepo with yarn workspaces. API uses Cloudflare Workers with D1 and R2.`
  },
  {
    day: 5,
    title: "Day 05 — Error Handling & Resilience",
    branch: "day-05-error-handling",
    scheduledDate: "2026-05-21",
    goalText: `Add comprehensive error handling to shop-diary-apps:

1. React Error Boundaries: Wrap DashboardLayout, CashierLayout, and each individual page component. Create shared ErrorFallback component with retry button and error reporting.

2. Next.js error pages: pages/_error.tsx (500), pages/404.tsx.

3. Standardize API error responses to format: { error: { code: string, message: string, details?: any } }. Update errorHandler.ts in api/src/ to produce this format consistently. Map Zod validation errors to 400 with field-level details.

4. Global toast notification system for mutation errors using Tamagui Toast. Show on any failed TanStack Query mutation.

5. TanStack Query retry configuration: exponential backoff, 3 retries for network errors, no retry for 4xx errors.

6. Network status indicator: detect online/offline events, show banner when offline. Use navigator.onLine and event listeners.

Frontend uses Tamagui UI framework, TanStack Query for data fetching, Next.js 13.5.`
  },
  {
    day: 6,
    title: "Day 06 — Security Hardening",
    branch: "day-06-security",
    scheduledDate: "2026-05-22",
    goalText: `Security hardening for shop-diary-apps API and frontend:

1. Rate limiting middleware: Per-IP rate limiting on API routes using Cloudflare Workers rate limiting. Limit auth routes to 10 req/min, API routes to 100 req/min.

2. CSRF protection: Add CSRF token generation and validation for all mutation endpoints (POST, PATCH, DELETE).

3. CORS configuration: Set explicit allowed origins (no wildcard in production). Configure in API middleware.

4. XSS prevention: Sanitize all user inputs (item names, descriptions, shop name) using DOMPurify or similar on output. Escape HTML in API responses.

5. Content-Security-Policy headers: Add CSP headers via Cloudflare Workers.

6. Password hashing: Replace current AES-GCM encryption with bcrypt for password storage. Current auth is in api/src/routes/auth.ts.

7. JWT refresh token rotation: Add refresh token endpoint, rotate tokens on use.

8. Security headers: X-Content-Type-Options, X-Frame-Options, Strict-Transport-Security, Referrer-Policy.

9. Remove all console.log statements that contain sensitive data (tokens, passwords, user info).

10. Playwright tests: verify auth redirects work, CSRF tokens are validated, rate limiting triggers correctly.

API uses Cloudflare Workers with itty-router. Auth uses JWT with middleware in api/src/middleware/.`
  },
  {
    day: 7,
    title: "Day 07 — Logging, Monitoring & Observability",
    branch: "day-07-observability",
    scheduledDate: "2026-05-23",
    goalText: `Add comprehensive observability to shop-diary-apps:

1. Sentry integration: Add @sentry/nextjs for dashboard and cashier web apps. Add Sentry to Cloudflare Workers API using Sentry DSN. Configure source maps upload. Set up release tracking.

2. Structured JSON logging: Replace all console.log in API with structured logger. Format: { timestamp, level, message, correlationId, ...context }. Create logger utility in api/src/utils/logger.ts.

3. Request/response logging middleware: Log all API requests with method, path, status, duration, correlationId. Add correlationId header to all responses.

4. Health check endpoint: GET /health returns { ok, version, dbConnected, uptime }. Check D1 database connectivity.

5. Web Vitals monitoring: Add web-vitals library to Next.js apps. Track LCP, FID, CLS, TTFB. Send to analytics endpoint.

6. Cloudflare Workers analytics: Set up Cloudflare Web Analytics for the web apps. Configure Workers analytics for API.

7. Uptime monitoring: Add /health endpoint to be polled by external monitoring. Document monitoring setup.

8. Configure alert thresholds: Error rate > 1% triggers alert, response time p95 > 2s triggers alert.

Tech: Cloudflare Workers API, Next.js 13.5 frontend, Tamagui UI.`
  },
  {
    day: 8,
    title: "Day 08 — Environment & Configuration Management",
    branch: "day-08-config-management",
    scheduledDate: "2026-05-24",
    goalText: `Set up proper environment and configuration management for shop-diary-apps:

1. Create .env.example files for all apps with documented variables: api/.env.example, dashboard/web/.env.example, cashier/web/.env.example.

2. Environment validation with Zod: On app startup, validate all required env vars using Zod schemas. Fail fast with clear error messages if missing.

3. Cloudflare Workers environments: Configure staging and production environments in wrangler.toml. Separate D1 databases per environment.

4. Secret management: Document how to set secrets via wrangler secret put. Create script to validate all required secrets are set.

5. Feature flags: Simple JSON-based feature flags in Cloudflare KV or environment variables. Flags for: loyalty_points, discounts, multi_location, offline_mode.

6. Database migration system: Create versioned SQL migration files in api/migrations/. Migration runner script that applies pending migrations. Support up and down migrations.

7. Seed data scripts: Create scripts/seed-demo.ts that populates a demo shop with items, categories, orders, users for testing.

8. Playwright tests: Verify all environment configurations connect properly.

Tech: Cloudflare Workers with D1 and R2, Wrangler CLI, Kysely ORM.`
  },
  {
    day: 9,
    title: "Day 09 — Cash Checkout API & Order Totals",
    branch: "day-09-checkout-api",
    scheduledDate: "2026-05-25",
    goalText: `Build the cash checkout API and order total summary for shop-diary-apps:

1. Create order_items junction table: itemId, orderId, quantity, unitPrice, lineTotal, shopId. Add migration in api/migrations/.

2. API: PATCH /orders/:id/complete — Sets status='completed', payment_method='cash', paid_at=CURRENT_TIMESTAMP. For each item in the order, deduct quantity from item inventory (itemBaseCount). All in a transaction.

3. Modify existing order creation (POST /orders) to populate order_items from cart data. Each line item records itemId, quantity, unitPrice, lineTotal.

4. Cashier: Add order total summary panel at bottom of cart. Show: subtotal (sum of line totals), any discounts applied, final total. Matches Loyverse's pre-checkout total display. This is in cashier/web/ using Tamagui components.

5. Playwright E2E tests: Test order creation populates order_items. Test PATCH /orders/:id/complete sets correct status, records paid_at, deducts inventory. Test order total calculation.

Tech: Cloudflare Workers API with Kysely ORM and D1 database. Frontend uses Next.js with Tamagui. Data fetching uses TanStack Query with SWR patterns.`
  },
  {
    day: 10,
    title: "Day 10 — Cash Confirmation Modal & Change Calculator",
    branch: "day-10-cash-confirmation",
    scheduledDate: "2026-05-26",
    goalText: `Build the cash confirmation modal and change calculator for shop-diary-apps cashier:

1. Cash confirmation modal: After "Send Order"/"Charge" button press, show a Tamagui Dialog modal. Contains: order total display, tendered amount input (number pad style), calculated change due (tendered - total), "Confirm Cash Received" button.

2. Change calculator: Real-time calculation as cashier types tendered amount. Show change in green if sufficient, red if insufficient. Disable "Confirm" button if tendered < total.

3. Handle edge cases: exact change (no change due), zero total order, very large amounts.

4. On confirm: Call PATCH /orders/:id/complete API. Show loading state during API call.

5. Order completed screen: After successful confirmation, show success screen with order summary (items, total, change given). "New Sale" button clears cart and returns to POS.

6. Keyboard support: Enter key confirms payment, Escape cancels and returns to cart.

7. Playwright tests: Test cash modal flow with various amounts (exact, over, under). Test keyboard shortcuts. Test success screen and New Sale flow.

Cashier is at cashier/web/ using Next.js and Tamagui. Uses Zustand for cart state (useCurrentCart).`
  },
  {
    day: 11,
    title: "Day 11 — Cart Improvements",
    branch: "day-11-cart-improvements",
    scheduledDate: "2026-05-27",
    goalText: `Improve the shopping cart in shop-diary-apps cashier:

1. Quick quantity +/- buttons: Add increment and decrement icon buttons on each cart line item. Pressing + increments qty by 1, - decrements (removes line at qty 0). No need to open item detail sheet.

2. Remove item from cart: Add X/trash icon button on each cart line to remove it entirely. Currently no way to remove without re-opening item detail.

3. Order note field: Add a "Note" text input at bottom of cart (above total). Optional free text that gets sent with order as orderNote field. Shown on order detail in dashboard.

4. Cart item count badge: Show total item count in cart header or button.

5. Empty cart state: When cart is empty, show illustration and "Start adding items" message instead of empty space.

6. Cart persistence: Save cart state to localStorage so it survives page refresh. Hydrate on load.

7. Swipe-to-delete: On mobile (React Native), add swipe gesture to delete cart items.

8. Playwright tests: Test all cart interactions — add, remove, quantity change, note, persistence.

Cart state is in packages/app/cashier/ using Zustand (useCurrentCart store). UI in cashier/web/ with Tamagui.`
  },
  {
    day: 12,
    title: "Day 12 — Receipt Screen & Print Support",
    branch: "day-12-receipt-screen",
    scheduledDate: "2026-05-28",
    goalText: `Build the receipt screen and print support for shop-diary-apps:

1. Receipt screen: After cash confirmation, show receipt-style view. Contains: shop name and logo (from shop settings), date/time, line items (name, qty, price, subtotal), discount amount if any, total paid, payment method (Cash), change given.

2. Print-friendly CSS: Add @media print styles. Receipt format optimized for 80mm thermal receipt printers. Hide navigation, buttons, and non-essential UI.

3. window.print() support: "Print Receipt" button triggers window.print(). Print media queries handle formatting.

4. Receipt footer customization: In /myshop settings, add fields for receiptWebsite (URL), receiptThankYou (text), receiptSocial (text). Store in shops table. Shown at bottom of receipt.

5. API: GET /receipts/:orderId — Returns structured receipt payload: shopName, shopLogo, orderDate, lineItems (name, qty, price, subtotal), discountAmount, total, paymentMethod, cashierName.

6. Playwright tests: Test receipt rendering with mock data. Test print trigger. Test receipt API endpoint.

Tech: Next.js cashier app, Tamagui UI, Cloudflare Workers API with Kysely.`
  },
  {
    day: 13,
    title: "Day 13 — Checkout Flow E2E & Polish",
    branch: "day-13-checkout-e2e",
    scheduledDate: "2026-05-29",
    goalText: `Full checkout flow E2E testing and polish for shop-diary-apps:

1. Full Playwright E2E suite for checkout: Login → browse items → add to cart → adjust quantities → add note → send order → cash confirmation modal → enter tendered amount → confirm → receipt screen → new sale. Test complete happy path.

2. Edge case testing: empty cart submission attempt, rapid double-click on confirm, network error mid-checkout (simulate offline), browser back button during checkout.

3. Loading states: Add spinner/loading indicators for all checkout mutations (order creation, order completion). Disable buttons during loading.

4. Optimistic updates: Cart operations (add, remove, quantity change) should update UI immediately, with rollback on API error.

5. Performance: Cart operations must complete in under 100ms. Measure and optimize if needed.

6. Accessibility: Cash modal must be focus-trapped (Tab cycles within modal). Screen reader should announce totals and change. Escape closes modal.

7. Mobile-specific checkout testing: Test on mobile viewport (375px). Touch targets must be 44px minimum.

8. Write all tests to tests/checkout-flow.spec.ts using Playwright.`
  },
  {
    day: 14,
    title: "Day 14 — Reports API",
    branch: "day-14-reports-api",
    scheduledDate: "2026-05-31",
    goalText: `Build the reports and analytics API for shop-diary-apps:

1. GET /reports/summary?period=today|week|month|year — Returns: totalRevenue (sum of completed order totals), orderCount, avgOrderValue. Queries only orders with status='completed'. Groups by created_at using date functions.

2. GET /reports/items?period=today|week|month|year — Returns items ranked by qty_sold and revenue. Joins orders → order_items → items. Returns: itemId, itemName, itemImage, qtySold, revenue. Sorted by revenue desc.

3. GET /reports/categories?period=today|week|month|year — Sales volume and revenue grouped by categoryId. Joins same tables as items report but groups by category. Returns: categoryId, categoryName, qtySold, revenue.

4. Database indexes: Add indexes on orders.created_at, orders.status, order_items.orderId, order_items.itemId for report query performance.

5. Query result caching: Use Cloudflare Cache API to cache report results for 5 minutes. Invalidate on new order completion.

6. All endpoints require authentication (withAuthenticatedUser middleware). Shop-scoped results.

7. Playwright tests: Test all report endpoints with seed data. Verify calculations. Test period filtering.

Tech: Cloudflare Workers with Kysely ORM, D1 database. Routes in api/src/routes/.`
  },
  {
    day: 15,
    title: "Day 15 — Analytics Dashboard KPI Cards",
    branch: "day-15-analytics-kpi",
    scheduledDate: "2026-06-01",
    goalText: `Create the analytics dashboard page with KPI cards for shop-diary-apps:

1. New /analytics page in dashboard/web/: Create dashboard/web/src/pages/analytics.tsx. Add to DashboardLayout navigation sidebar.

2. 3 KPI cards at top: Today's Revenue (formatted currency), Order Count, Avg Order Value. Large numbers with labels. Use Tamagui Card components.

3. Period selector: Dropdown or segmented control for Today / Week / Month / Year. On change, refetch data from /reports/summary API. Selected period sent as query parameter.

4. Auto-refresh: TanStack Query with refetchOnWindowFocus and staleTime of 60 seconds.

5. Loading skeletons: Show Tamagui Skeleton components while data is loading. Match card dimensions.

6. Responsive grid: 3-column grid on desktop (>= 1024px), 2-column on tablet, 1-column on mobile. Use Tamagui $sm/$gtSm breakpoints.

7. Empty state: When no data for selected period, show "No sales data for this period" with illustration.

8. Playwright tests: Test analytics page renders correctly. Test period switching. Test loading states. Test empty state.

Dashboard is in dashboard/web/ using Next.js 13.5, Tamagui, TanStack Query. Navigation in DashboardLayout.tsx.`
  },
  {
    day: 16,
    title: "Day 16 — Sales Charts & Top Items",
    branch: "day-16-charts-top-items",
    scheduledDate: "2026-06-02",
    goalText: `Add sales trend charts and top items table to analytics page in shop-diary-apps:

1. Install recharts: yarn workspace dashboard-web add recharts (lightweight chart library, works with React).

2. Sales trend line chart: X-axis shows days/weeks/months based on period selector. Y-axis shows revenue. Smooth line with gradient fill. Tooltip showing date and revenue on hover.

3. Period toggle on chart: Same period selector affects both KPI cards and chart. Re-fetches data on change.

4. Top items table below chart: Columns: Item image (thumbnail), Name, Qty Sold, Revenue. Sorted by revenue descending. Show top 10 by default with "Show more" option. Uses GET /reports/items API.

5. Chart responsive: On mobile, chart should be full width with horizontal scroll for time axis if needed. Touch-friendly tooltips.

6. Loading/error states: Skeleton while loading, error message with retry on failure.

7. Playwright tests: Test chart renders with data. Test top items table accuracy. Test period switching updates chart.

Add to existing /analytics page in dashboard/web/. Uses recharts, Tamagui, TanStack Query.`
  },
  {
    day: 17,
    title: "Day 17 — CSV Export & Analytics Polish",
    branch: "day-17-csv-export",
    scheduledDate: "2026-06-03",
    goalText: `Add CSV export and polish analytics page in shop-diary-apps:

1. "Export CSV" button on analytics page: Downloads CSV file with report data. Filename includes date range: sales-report-2026-06-04-to-2026-06-04.csv.

2. CSV export for sales summary: Headers: Date, Revenue, Order Count, Avg Order Value. One row per day in selected period.

3. CSV export for item performance: Headers: Item Name, Category, Qty Sold, Revenue. One row per item.

4. CSV export for category breakdown: Headers: Category, Qty Sold, Revenue. One row per category.

5. Client-side CSV generation: Generate CSV string from fetched report data. Trigger browser download using Blob + URL.createObjectURL + anchor click.

6. Analytics print support: Add @media print styles. Print-friendly layout with charts, tables, and KPI cards. Hide navigation and interactive elements.

7. Full analytics E2E test suite: Test all analytics features end-to-end including CSV export contents verification.

Add to existing /analytics page in dashboard/web/.`
  },
  {
    day: 18,
    title: "Day 18 — Inventory Adjustments API",
    branch: "day-18-inventory-api",
    scheduledDate: "2026-06-04",
    goalText: `Build the inventory adjustments API for shop-diary-apps:

1. Database migration: Add lowStockThreshold column (INTEGER, nullable, default NULL) to items table. Add InventoryAdjustments table: adjustmentId (ULID), itemId, shopId, oldQty, newQty, delta, reason (enum: 'recount'|'damaged'|'restock'|'other'), createdAt.

2. POST /inventory/adjustments: Accept { itemId, delta, reason }. Validate item exists and belongs to shop. Calculate oldQty (current itemBaseCount), newQty (oldQty + delta). Ensure newQty >= 0. Create InventoryAdjustment record. Update item.itemBaseCount to newQty. Return adjustment record.

3. GET /inventory/adjustments: Return history of adjustments. Support ?itemId= filter and ?shopId= filter (shopId comes from auth context). Sorted by createdAt desc. Return: adjustmentId, itemId, oldQty, newQty, delta, reason, createdAt.

4. GET /inventory/low-stock: Return all items where itemBaseCount <= lowStockThreshold (and lowStockThreshold IS NOT NULL). Return: itemId, itemName, itemImage, currentStock, lowStockThreshold.

5. All endpoints require authentication (withAuthenticatedUser). Shop-scoped results.

6. Playwright tests: Test adjustment creation, retrieval, and low-stock endpoint.

Tech: Cloudflare Workers API with Kysely ORM, D1 database. Routes in api/src/routes/. Migrations in api/migrations/.`
  },
  {
    day: 19,
    title: "Day 19 — Inventory Management Screen",
    branch: "day-19-inventory-screen",
    scheduledDate: "2026-06-05",
    goalText: `Create the inventory management dashboard screen for shop-diary-apps:

1. New /inventory page in dashboard/web/: Add to DashboardLayout navigation. Create dashboard/web/src/pages/inventory.tsx.

2. Inventory table: Columns: item image (thumbnail), item name, current stock (itemBaseCount), low stock threshold (inline editable — click to edit, shows input), last adjusted date. Sorted by name.

3. "Adjust" button on each row: Opens adjustment modal with fields: delta (positive or negative number), reason (dropdown: recount, damaged, restock, other). On submit: POST /inventory/adjustments. Refresh table on success.

4. Expandable rows: Click to expand and show adjustment history for that item. Uses GET /inventory/adjustments?itemId=X.

5. Low stock alert banner: In DashboardLayout.tsx header/sidebar, check GET /inventory/low-stock on load. If items returned, show yellow banner: "X items low on stock". Click navigates to /inventory with ?filter=low-stock.

6. Low-stock filter: When URL has ?filter=low-stock, only show items that are low on stock.

7. Playwright tests: Test inventory page loads. Test adjustment modal. Test inline threshold editing. Test low stock banner and navigation.

Dashboard uses Next.js 13.5, Tamagui, TanStack Query. Layout in packages/app/dashboard/layout/DashboardLayout.tsx.`
  },
  {
    day: 20,
    title: "Day 20 — Suppliers Management",
    branch: "day-20-suppliers",
    scheduledDate: "2026-06-06",
    goalText: `Build the suppliers management feature for shop-diary-apps:

1. Database migration: Create Suppliers table: supplierId (ULID), shopId, name (TEXT NOT NULL), contactName (TEXT), email (TEXT), phone (TEXT), address (TEXT), notes (TEXT), createdAt, updatedAt.

2. API CRUD /suppliers:
   - GET /suppliers — List all suppliers for current shop. Return: supplierId, name, contactName, email, phone, open PO count.
   - POST /suppliers — Create supplier. Validate with Zod: name required, email valid format if provided.
   - PATCH /suppliers/:id — Update supplier fields.
   - DELETE /suppliers/:id — Delete supplier (only if no open purchase orders linked).
   All endpoints require admin authentication.

3. Frontend /suppliers page in dashboard/web/: Table with columns: name, contact, email, phone, open PO count. Add button opens create modal. Edit/Delete actions on each row. Search by name.

4. Add to navigation: Under inventory section in DashboardLayout nav.

5. Playwright tests: Test supplier CRUD operations. Test validation (name required, email format). Test delete prevention when POs exist.

Tech: Cloudflare Workers API, Kysely ORM, Next.js dashboard, Tamagui UI.`
  },
  {
    day: 21,
    title: "Day 21 — Purchase Orders",
    branch: "day-21-purchase-orders",
    scheduledDate: "2026-06-07",
    goalText: `Build the purchase orders system for shop-diary-apps:

1. Database migration: Create PurchaseOrders table: poId (ULID), shopId, supplierId (FK to Suppliers), status (TEXT: 'draft'|'sent'|'received'), notes (TEXT), createdAt, updatedAt. Create PurchaseOrderItems table: poItemId (ULID), poId (FK), itemId (FK), quantity (INTEGER), unitCost (REAL).

2. API CRUD /purchase-orders:
   - GET /purchase-orders — List with supplier name, status badge, total cost. Support ?status= filter.
   - POST /purchase-orders — Create with supplierId, notes, lineItems array [{itemId, quantity, unitCost}]. Status defaults to 'draft'.
   - PATCH /purchase-orders/:id — Update fields or line items (only in 'draft' status).
   - POST /purchase-orders/:id/send — Change status from 'draft' to 'sent'.
   - POST /purchase-orders/:id/receive — Change status to 'received'. For each line item: increment item.itemBaseCount by quantity, create InventoryAdjustment with reason='restock'.

3. Frontend /purchase-orders page: List view with status badges (draft=gray, sent=blue, received=green). "Create PO" form: select supplier (dropdown), add line items (item selector + qty + unit cost). Status action buttons.

4. Playwright tests: Test PO lifecycle (create → send → receive). Verify inventory update on receive. Test status transitions.

Tech: Cloudflare Workers API, Kysely ORM, Next.js dashboard, Tamagui.`
  },
  {
    day: 22,
    title: "Day 22 — Inventory E2E & Integration",
    branch: "day-22-inventory-e2e",
    scheduledDate: "2026-06-08",
    goalText: `Full inventory E2E testing and integration testing for shop-diary-apps:

1. Full Playwright E2E inventory lifecycle: Create supplier → create purchase order → add line items → mark as sent → mark as received → verify inventory updated → make manual adjustment → verify low stock alert triggers.

2. Inventory deduction on order completion: Create an order in cashier → complete the order → verify item inventory is deducted by correct quantity. Test with multiple items.

3. Concurrent inventory adjustments: Test that rapid concurrent adjustments don't cause race conditions. Kysely transactions should handle this.

4. Performance testing: Inventory queries must return in under 200ms with 10,000+ items. Seed 10K items, run queries, measure response times. Add indexes if needed.

5. Add inventory reports tab to /analytics: Show inventory value (sum of stock * unit cost), top items by stock level, stock movement trends. Use existing report infrastructure.

6. Mobile inventory management testing: Test /inventory page on mobile viewport. Tables should scroll horizontally or switch to card layout.

7. Write all tests to tests/inventory-lifecycle.spec.ts using Playwright.`
  },
  {
    day: 23,
    title: "Day 23 — Open Tickets / Hold Orders",
    branch: "day-23-open-tickets",
    scheduledDate: "2026-06-09",
    goalText: `Build the open tickets / hold orders system for shop-diary-apps:

1. API: Orders can be created with status='open' (held ticket, no payment). Modify POST /orders to accept status='open' as valid initial status.

2. GET /orders?status=open: Returns held orders/tickets. Already supported by existing endpoint but ensure proper filtering.

3. PATCH /orders/:id: Can transition status from 'open' to 'active' (resume held ticket). Only allow this transition, not backwards.

4. Cashier "Hold" button: In cashier cart area, add "Hold" button. Saves current cart as an order with status='open'. Clears the cart. Shows confirmation toast "Ticket held".

5. "Open Tickets" tab/section: In cashier interface, add a tab or button to view held orders. Shows list of open orders with: order ID, item count, total, time held. Tapping one loads it back into the current cart for completion.

6. Resume held ticket: When loading a held order into cart, populate cart items, quantities. Remove the held order or mark it as 'active'. Cart is ready for normal checkout flow.

7. Playwright tests: Test hold flow (cart → hold → verify open order exists). Test resume flow (open tickets list → tap → cart loaded → complete checkout).

Cashier in cashier/web/ using Next.js, Tamagui, Zustand (useCurrentCart). API in api/src/routes/orders.`
  },
  {
    day: 24,
    title: "Day 24 — Order Detail & Refund API",
    branch: "day-24-order-detail-refund",
    scheduledDate: "2026-06-10",
    goalText: `Build order detail page and refund API for shop-diary-apps:

1. Frontend /orders/:id detail page: Show line items table (name, qty, unit price, line total), customer info if attached, subtotal, discounts, total, payment method, paid_at timestamp, cashier name. Add navigation from orders list rows.

2. API: POST /orders/:id/refund: Accept { items: [{itemId, quantity}] } (empty = full refund). For each item: restore inventory (increment itemBaseCount), create InventoryAdjustment with reason='other'. Calculate refund amount. Create Refund record linked to original order. Set order status to 'refunded' (full) or 'partially_refunded' (partial).

3. Refunds table: Create migration for refunds table: refundId (ULID), orderId (FK), amount, type ('full'|'partial'), items JSON, createdBy (userId), createdAt.

4. Order status filters on /orders page: Add tab filters: All / Open / Completed / Refunded. Click to filter the orders list.

5. Date range picker on /orders page: Add date input to filter orders by created_at range.

6. Order rows link to detail view: Click an order row to navigate to /orders/:id.

7. Playwright tests: Test order detail page displays correctly. Test refund API: full refund, partial refund, inventory restoration.

Tech: Next.js dashboard, Tamagui, Cloudflare Workers API, Kysely ORM.`
  },
  {
    day: 25,
    title: "Day 25 — Refund Flow UI",
    branch: "day-25-refund-ui",
    scheduledDate: "2026-06-11",
    goalText: `Build the refund flow UI for shop-diary-apps:

1. "Refund" button on /orders/:id detail page: Only visible for completed orders. Only visible for Admin/Manager role. Opens refund modal.

2. Refund modal: Two modes — "Full Refund" (radio button, refunds all items) and "Partial Refund" (checkbox list of items with quantity input for each). Shows refund total calculation. "Confirm Refund" button.

3. Confirm refund: Calls POST /orders/:id/refund. Shows loading state. On success: updates order status display, shows success toast, refreshes order detail.

4. Refund receipt: After successful refund, show refund receipt with: original order info, refunded items, refund amount, timestamp. Print-friendly format.

5. Staff permission gate: Only Admin and Manager roles can see/use the Refund button. Check user role from auth context.

6. Refund history: In order detail, show list of past refunds (if any) with date, amount, items, who processed it.

7. Playwright E2E: Test full refund flow. Test partial refund with specific items. Test permission gate (cashier can't refund). Test refund receipt display.

Dashboard in dashboard/web/ using Next.js, Tamagui. Auth context from useUserStore (Zustand).`
  },
  {
    day: 26,
    title: "Day 26 — Orders E2E & Polish",
    branch: "day-26-orders-e2e",
    scheduledDate: "2026-06-12",
    goalText: `Full orders E2E testing and polish for shop-diary-apps:

1. Complete orders E2E test suite: Create order → complete checkout → view order detail → hold another order → resume held order → complete → view detail → process refund. Full lifecycle in one test.

2. Print-friendly order detail: Add @media print styles for /orders/:id page. Hide nav, show clean order detail with line items and totals.

3. Order CSV export: "Export" button on /orders page. Downloads CSV with columns: Order ID, Date, Status, Items Count, Total, Payment Method, Cashier. Respects current filters (status, date range).

4. Order search: Add search input on /orders page. Search by order ID (partial match) or customer name. Client-side filtering or API parameter.

5. Bulk order actions: Checkbox selection on order rows. "Export Selected" button downloads CSV of selected orders only.

6. Performance: Orders list with pagination for 50,000+ orders. Cursor-based pagination (not offset). Load 25 per page. Infinite scroll or "Load More" button.

7. Mobile order management: Test /orders and /orders/:id on mobile viewport. Responsive layout.

8. Write all tests to tests/orders-lifecycle.spec.ts using Playwright.`
  },
  {
    day: 27,
    title: "Day 27 — Customer Management",
    branch: "day-27-customers",
    scheduledDate: "2026-06-14",
    goalText: `Build the customer management system for shop-diary-apps:

1. Database migration: Create Customers table: customerId (ULID), shopId, firstName (TEXT), lastName (TEXT), email (TEXT), phone (TEXT), address (TEXT), notes (TEXT), loyaltyPoints (INTEGER DEFAULT 0), createdAt, updatedAt. Add customerId column to Orders table (nullable FK).

2. API CRUD /customers:
   - GET /customers — List customers for shop. Support ?search= parameter for name/email/phone search. Return: customerId, firstName, lastName, email, phone, loyaltyPoints, lastVisit.
   - POST /customers — Create customer. Validate: email format if provided, phone format if provided.
   - GET /customers/:id — Get customer details.
   - PATCH /customers/:id — Update customer fields.
   - DELETE /customers/:id — Delete customer (soft, set active=false).
   - GET /customers/:id/history — Paginated order history for this customer.

3. Frontend /customers page in dashboard: Table with search input (searches name/email/phone). Columns: Name, Email, Phone, Points Balance, Last Visit. Add/Edit/Delete modals using Tamagui Dialog.

4. Customer detail page /customers/:id: Show editable info, loyalty points balance, purchase history list.

5. Add /customers to DashboardLayout navigation.

6. Playwright tests: Test customer CRUD, search functionality, detail page, order history.

Tech: Cloudflare Workers API, Kysely ORM, Next.js dashboard, Tamagui.`
  },
  {
    day: 28,
    title: "Day 28 — Loyalty Points & Cashier Customer Search",
    branch: "day-28-loyalty",
    scheduledDate: "2026-06-15",
    goalText: `Implement loyalty points and cashier customer search for shop-diary-apps:

1. Loyalty configuration: Add pointsPerCurrency field to Shops table (e.g., 1 point per $1 spent). Default: 1. Editable in /myshop settings.

2. Points accrual on order completion: When PATCH /orders/:id/complete is called, if order has customerId, calculate earned points = floor(orderTotal * pointsPerCurrency). Add to customer's loyaltyPoints. Store earned points on order record.

3. Display earned points in receipt: Show "You earned X points!" on receipt screen. Show customer's new total points balance.

4. Cashier customer search: In cart panel header, add search input. Type name or phone to search customers via GET /customers?search=X. Dropdown shows matching customers. Selecting attaches customerId to current cart/order.

5. Customer points display: When customer is attached to cart, show their name and loyalty points balance in cart header area.

6. Points redemption: Toggle "Redeem points" in cart. If enabled, calculate discount = min(availablePoints * pointsValue, orderTotal). Deduct from total. Deduct from customer points on order completion. Add pointsValue to shop settings (default: $0.01 per point).

7. Playwright tests: Test points accrual on order completion. Test customer search in cashier. Test points redemption and discount calculation.

Tech: Cashier uses Next.js, Tamagui, Zustand. API uses Cloudflare Workers, Kysely.`
  },
  {
    day: 29,
    title: "Day 29 — Discounts & Promotions",
    branch: "day-29-discounts",
    scheduledDate: "2026-06-16",
    goalText: `Build the discounts and promotions system for shop-diary-apps:

1. Database migration: Create Discounts table: discountId (ULID), shopId, name (TEXT NOT NULL), type (TEXT: 'fixed'|'percent'), value (REAL NOT NULL), scope (TEXT: 'item'|'receipt'), active (BOOLEAN DEFAULT true), createdAt, updatedAt.

2. API CRUD /discounts:
   - GET /discounts — List active discounts for shop. Support ?active=true/false filter.
   - POST /discounts — Create discount. Validate with Zod: type must be 'fixed' or 'percent', value must be positive, percent value <= 100.
   - PATCH /discounts/:id — Update discount. Can toggle active status.
   - DELETE /discounts/:id — Delete discount.

3. Apply discount on order creation: POST /orders accepts optional discountId (receipt-level). Each order_item can have optional discountId (item-level). Server computes discounted total. Stores discountAmount on order record.

4. Frontend /discounts page: Table with columns: Name, Type (% or $), Value, Scope (Item/Receipt), Active toggle. Add/Edit/Delete modals.

5. Cashier "% Discount" button: In cart area, button opens modal. Options: select a saved discount from dropdown, or enter quick one-off percentage. Applied to cart total.

6. Cashier item-level discount: Long press/right-click on cart line item. Context menu option: "Apply Discount". Choose saved discount or enter quick value. Applied to that line only.

7. Playwright tests: Test discount CRUD. Test discount application on order. Test cashier discount button and item-level discount.

Tech: Cloudflare Workers API, Kysely, Next.js dashboard and cashier, Tamagui.`
  },
  {
    day: 30,
    title: "Day 30 — Customer & Discount E2E",
    branch: "day-30-customer-discount-e2e",
    scheduledDate: "2026-06-17",
    goalText: `Full customer, discount, and loyalty E2E testing for shop-diary-apps:

1. Full E2E flow: Create customer → create discount (10% off) → open cashier → search and attach customer → add items to cart → apply discount → complete order → verify points earned → verify discount applied to total → start new sale → search customer → redeem points → complete → verify points deducted → refund order → verify points reversed.

2. Discount stacking rules: Test that only one receipt-level discount can be applied. Test that item-level discounts stack with receipt-level discount. Test that two item-level discounts on same item use the highest value.

3. Loyalty edge cases: Test negative points (should not go below 0). Test max redemption (can't redeem more than order total). Test points on free orders (0 points). Test points on discounted orders (points based on amount paid).

4. Performance: Customer search with 10,000+ records must return results in under 200ms. Seed 10K customers, test search performance.

5. Mobile customer management: Test /customers page on mobile. Test cashier customer search on mobile viewport.

6. Discount analytics: Add discount impact to /analytics reports. Show: total discount amount given, most used discounts, discount revenue impact (revenue lost to discounts vs total revenue).

7. Write all tests to tests/customer-discount-loyalty.spec.ts using Playwright.`
  },
  {
    day: 31,
    title: "Day 31 — RBAC & Staff Management",
    branch: "day-31-rbac-staff",
    scheduledDate: "2026-06-18",
    goalText: `Implement role-based access control and staff management for shop-diary-apps:

1. Add 'manager' role: Update users table role enum to include 'admin', 'manager', 'cashier'. Database migration for existing data.

2. requireRole(role) middleware: Create api/src/middleware/requireRole.ts. Accepts allowed roles array. Returns 403 if user's role is not in allowed list. Use after withAuthenticatedUser middleware.

3. Route-level role requirements:
   - Dashboard management routes (items, categories, staff, discounts, suppliers, POs): require admin or manager
   - Reports/analytics: require admin or manager
   - Cashier routes (order creation, completion): allow all roles
   - Refund: require admin or manager
   - Customer management: require admin or manager

4. Staff API CRUD:
   - GET /staff — List staff for shop (admin only). Return: userId, firstName, lastName, email, role, active status.
   - POST /staff/invite — Create user with temp password, send invite (admin only). Body: email, firstName, lastName, role.
   - PATCH /staff/:id — Update role (admin only). Can change role between cashier/manager.
   - DELETE /staff/:id — Soft deactivate (set active=false, admin only). Does not delete data.

5. Frontend /staff page: Table with columns: Name, Role badge (color-coded: admin=purple, manager=blue, cashier=gray), Email, Status (active/inactive). Invite button, Edit role dropdown, Deactivate button. All admin-only actions.

6. Playwright tests: Test cashier cannot access admin routes (403). Test manager can access management routes. Test staff CRUD operations.

Tech: Cloudflare Workers API, Kysely, Next.js dashboard, Tamagui.`
  },
  {
    day: 32,
    title: "Day 32 — Time Clock & Staff Reports",
    branch: "day-32-timeclock-reports",
    scheduledDate: "2026-06-19",
    goalText: `Build time clock and staff performance reports for shop-diary-apps:

1. Database migration: Create Shifts table: shiftId (ULID), shopId, userId (FK to users), clockInAt (TEXT ISO datetime), clockOutAt (TEXT nullable), hoursWorked (REAL nullable), createdAt.

2. API endpoints:
   - POST /timeclock/in — Create shift with userId, clockInAt=now. Return shift record. Require authenticated user.
   - POST /timeclock/out/:shiftId — Set clockOutAt=now, calculate hoursWorked. Return updated shift.
   - GET /timeclock?userId=&startDate=&endDate= — Return shift history. Admin sees all, staff sees own.

3. Staff reports API: GET /reports/staff?period=today|week|month — Return per-employee: userId, name, orderCount, totalRevenue, avgOrderValue. Join orders where completed, group by cashier userId.

4. Frontend: Staff performance tab in /analytics page. Table: Employee Name, Orders Handled, Total Revenue, Avg Order Value. Sortable. Filterable by date range.

5. Time clock UI in cashier: Clock in/out button in cashier header. Shows current shift duration (live timer). Green when clocked in, gray when clocked out.

6. Shift history: In /staff detail, show shift history with clock in/out times and hours.

7. Playwright tests: Test clock in, clock out, hours calculation. Test staff reports accuracy. Test time clock UI.

Tech: Cloudflare Workers API, Kysely, Next.js cashier and dashboard, Tamagui.`
  },
  {
    day: 33,
    title: "Day 33 — Employee PIN Login",
    branch: "day-33-pin-login",
    scheduledDate: "2026-06-20",
    goalText: `Build the employee PIN login system for shop-diary-apps cashier:

1. Database migration: Add pin column to users table (TEXT, nullable, 4-digit hashed PIN). Add pinAttempts column (INTEGER DEFAULT 0). Add pinLockedUntil column (TEXT nullable, ISO datetime).

2. PIN storage: Hash PINs using bcrypt before storage. Never store plain text PINs.

3. API: POST /auth/pin-login — Accept { pin: string, shopId: string }. Look up user by shopId + PIN hash (compare with bcrypt). If found and not locked: return JWT (same format as email login). Increment pinAttempts on failure. Lock after 5 failed attempts for 15 minutes (set pinLockedUntil).

4. PIN management API:
   - POST /auth/change-pin — Change own PIN. Requires current PIN.
   - POST /staff/:id/reset-pin — Admin resets employee PIN to a new value.

5. Cashier PIN pad screen: Landing screen for cashier app shows a numeric pad (0-9, clear, enter). 4 dots showing entered digits. "Enter your PIN" prompt. Shop name displayed at top. "Use email/password instead" link.

6. PIN change UI: In cashier settings, option to change PIN. Enter current PIN, enter new PIN, confirm new PIN.

7. Admin PIN reset: In /staff page, admin can click "Reset PIN" which generates a temporary PIN shown once.

8. Playwright tests: Test PIN login flow. Test wrong PIN (error message). Test lockout after 5 attempts. Test PIN change. Test admin reset.

Tech: Cashier in cashier/web/ (Next.js). API uses bcrypt for PIN hashing, JWT for auth tokens.`
  },
  {
    day: 34,
    title: "Day 34 — Cashier UX Improvements",
    branch: "day-34-cashier-ux",
    scheduledDate: "2026-06-21",
    goalText: `Improve cashier UX with search, barcode, and keyboard shortcuts for shop-diary-apps:

1. Item search/filter: Add text input above the item grid in cashier. Filters displayed items in real-time using local state (filter by itemName, case-insensitive). No API call — filters from already-fetched items. Clears when category changes.

2. Barcode support:
   - Add barcode column to items table (TEXT, nullable). Add to migration.
   - Add barcode field to Add/Edit Item forms in dashboard.
   - In cashier: hidden text input that auto-captures barcode scanner input (rapid keystroke sequence ending in Enter). On Enter: look up item by barcode from local item list. If found, add to cart. Clear input.

3. Keyboard shortcuts in cashier web:
   - / key focuses search input
   - Escape clears search, closes modals
   - Enter in cash modal confirms payment
   - N key starts new sale (after order completed)
   - +/- keys adjust quantity of last added item
   Show shortcut hints in UI (bottom bar or tooltips).

4. Offline mode foundation: On cashier load, cache items and categories in IndexedDB (using idb-keyval or similar). When creating order while offline, queue order locally. Show "Offline" badge in cashier header. When connection restored, flush queue to API.

5. Playwright tests: Test search filtering. Test barcode input and item lookup. Test all keyboard shortcuts.

Cashier in cashier/web/ using Next.js, Tamagui, Zustand. Items fetched with TanStack Query.`
  },
  {
    day: 35,
    title: "Day 35 — Accessibility (WCAG 2.1 AA)",
    branch: "day-35-accessibility",
    scheduledDate: "2026-06-22",
    goalText: `Full WCAG 2.1 AA accessibility audit and fixes for shop-diary-apps:

1. Automated audit: Run axe-core on all pages (dashboard + cashier). Fix all critical and serious violations. Use @axe-core/playwright for automated testing.

2. ARIA labels: Add aria-label to all interactive elements without visible text (icon buttons, inputs without labels). Add aria-describedby for form fields with help text. Add role attributes where semantic HTML is insufficient.

3. Keyboard navigation: Ensure all functionality is accessible via keyboard alone. Tab order follows visual layout. Focus indicators are visible (2px solid outline). Skip navigation link at top of each page.

4. Screen reader support: All images have alt text. Form inputs have associated labels (htmlFor). Dynamic content updates use aria-live regions. Modal dialogs have proper focus management (focus trap).

5. Color contrast: All text meets WCAG 2.1 AA contrast ratios (4.5:1 for normal text, 3:1 for large text). Test with Tamagui theme colors.

6. Focus management: When modals open, focus moves to first interactive element. When modals close, focus returns to trigger element. Route changes move focus to main content.

7. Touch targets: All interactive elements have minimum 44x44px touch target on mobile. Adequate spacing between targets.

8. Playwright automated accessibility tests: Write axe-core based tests for every page and modal. Run in CI.

Audit and fix: login, register, dashboard, cashier, items, categories, orders, customers, inventory, staff, settings pages.`
  },
  {
    day: 36,
    title: "Day 36 — Theming, Dark Mode & Responsive Polish",
    branch: "day-36-theming-responsive",
    scheduledDate: "2026-06-23",
    goalText: `Implement theming, dark mode, and responsive polish for shop-diary-apps:

1. Dark/light mode: Add toggle switch in /myshop settings. Saves darkMode (boolean) to shop record via PATCH /shops/myshop. On toggle: update Tamagui colorScheme prop in _app.tsx. Store preference in shop settings (server-side) and localStorage (client-side fallback).

2. Accent color picker: Color picker input in /myshop settings. Saves accentColor (hex string, 7 chars) to shop record. On change: update Tamagui theme tokens (currently hardcoded purple). Should cascade through buttons, active states, highlights, focus rings.

3. Shop logo in cashier header: Show shop logo (TImage from Tamagui) beside shop name in cashier top bar. Fetch from useShop() hook. Falls back to shop name initials in a colored circle if no logo uploaded.

4. API: Extend PATCH /shops/myshop with darkMode (boolean) and accentColor (varchar 7) fields. Add to shops table migration. Add to Zod validation schema.

5. Receipt footer customization: In /myshop, add fields: receiptWebsite (URL), receiptThankYou (text), receiptSocial (text). Stored in shops table. Shown at bottom of receipt screen.

6. Responsive audit: Test every screen at 320px, 768px, 1024px, 1440px widths. Fix any layout issues. Tables should scroll horizontally on small screens or convert to card layout. Navigation should collapse to hamburger menu on mobile.

7. Playwright visual regression tests: Screenshot each page at all breakpoints. Compare against baseline.

Dashboard and cashier use Tamagui with custom theme tokens.`
  },
  {
    day: 37,
    title: "Day 37 — Performance Optimization",
    branch: "day-37-performance",
    scheduledDate: "2026-06-24",
    goalText: `Performance optimization across shop-diary-apps:

1. Code splitting: React.lazy() for all dashboard pages (items, categories, orders, analytics, inventory, suppliers, purchase-orders, customers, discounts, staff, settings). Dynamic imports for heavy components (charts, editors, modals). Add Suspense boundaries with loading fallbacks.

2. Image optimization: Use Next.js Image component throughout. Configure Cloudflare R2 for WebP conversion. Add lazy loading for below-fold images. Responsive image sizes. Image compression pipeline for uploaded shop logos and item images.

3. Virtual scrolling: For large lists (items table with 1000+ rows, orders, inventory), implement virtual scrolling with react-window or @tanstack/virtual. Only render visible rows.

4. API compression: Enable Cloudflare Brotli/Gzip compression for API responses. Verify Content-Encoding headers.

5. Database optimization: Run EXPLAIN QUERY PLAN on all report and list queries. Add missing indexes (orders.created_at, orders.status, order_items.orderId, items.shopId). Optimize N+1 queries with proper JOINs.

6. Bundle analysis: Run @next/bundle-analyzer. Identify and remove unused dependencies. Tree-shake Tamagui imports. Target initial bundle < 200KB gzipped.

7. Lighthouse CI: Target Performance > 90, FCP < 1.5s, LCP < 2.5s on all pages. Add Lighthouse CI to GitHub Actions.

8. Playwright performance regression tests: Measure page load times, API response times. Fail if > 20% regression from baseline.

Tech: Next.js 13.5, Tamagui, Cloudflare Workers, D1/Kysely.`
  },
  {
    day: 38,
    title: "Day 38 — SEO & Meta Tags",
    branch: "day-38-seo",
    scheduledDate: "2026-06-25",
    goalText: `Add SEO optimization and meta tags to shop-diary-apps:

1. Dynamic meta tags per page using Next.js Head component:
   - Login: "Shop Diary - Sign In to Your POS"
   - Dashboard: "Shop Diary - Dashboard" (dynamic: includes shop name)
   - Cashier: "Shop Diary - Point of Sale" (dynamic: includes shop name)
   - Items: "Items Management - {Shop Name}"
   - Orders: "Orders - {Shop Name}"
   - Analytics: "Analytics & Reports - {Shop Name}"
   - All other pages similarly

2. Open Graph tags: og:title, og:description, og:image (shop logo), og:url, og:type on all pages.

3. Twitter Card tags: twitter:card, twitter:title, twitter:description, twitter:image on all pages.

4. JSON-LD structured data:
   - Shop page: LocalBusiness schema
   - Items: Product schema with name, price, image
   - Use next/script for JSON-LD injection

5. Sitemap.xml: Generate dynamic sitemap at build time. Include all public pages.

6. Robots.txt: Allow all crawlers. Disallow /api/, /auth/. Allow /dashboard/ (behind auth anyway).

7. Canonical URLs: Add <link rel="canonical"> to all pages.

8. Social sharing previews: OG images should show shop logo + shop name. Test with Facebook Debugger and Twitter Card Validator.

9. Playwright tests: Visit each page, verify all meta tags are present and correct. Verify JSON-LD is valid.

Tech: Next.js 13.5 with Head component. Public pages limited (most behind auth).`
  },
  {
    day: 39,
    title: "Day 39 — Security Audit & Load Testing",
    branch: "day-39-security-load",
    scheduledDate: "2026-06-26",
    goalText: `Comprehensive security audit and load testing for shop-diary-apps:

1. OWASP Top 10 audit: Review each category (injection, broken auth, sensitive data exposure, XXE, broken access control, misconfig, XSS, deserialization, known vulns, logging). Document findings and fix.

2. SQL injection testing: Test all API endpoints with SQL injection payloads in inputs (name, email, search params). Verify Kysely parameterization prevents injection.

3. XSS testing: Test all input fields with script injection payloads. Verify output encoding in frontend. Test stored XSS (item names, descriptions, customer notes).

4. CSRF verification: Verify all mutation endpoints require valid CSRF token. Test cross-origin request rejection.

5. Authentication bypass: Test accessing protected routes without token. Test expired tokens. Test token tampering. Test accessing other shop's data (multi-tenant isolation).

6. Rate limiting validation: Verify rate limiting works on auth routes (10/min) and API routes (100/min). Test with rapid requests.

7. Load testing with k6 or Artillery:
   - 100 concurrent users
   - Mix: 60% browse items, 20% create orders, 10% view reports, 10% manage inventory
   - Run for 10 minutes
   - Measure: response time p50, p95, p99, error rate, throughput
   - API SLA: p95 < 500ms, p99 < 1s, error rate < 0.1%

8. Dependency audit: Run npm audit and Snyk. Fix all critical and high vulnerabilities.

9. Cloudflare WAF: Configure WAF rules. Block common attack patterns.

10. Playwright security regression suite: Automated tests for auth, CSRF, XSS, rate limiting.

Create scripts/load-test.js with k6/Artillery test scenarios.`
  },
  {
    day: 40,
    title: "Day 40 — Final QA, Deployment & Documentation",
    branch: "day-40-launch",
    scheduledDate: "2026-06-28",
    goalText: `Final QA, production deployment, and documentation for shop-diary-apps:

1. Complete Playwright regression: Run ALL E2E tests (checkout, analytics, inventory, orders, customers, discounts, staff, accessibility). All must pass 100%. Fix any failures.

2. Lighthouse audit: Run on all pages. Target: Performance > 90, Accessibility > 90, Best Practices > 90, SEO > 90. Document scores.

3. API documentation: Generate OpenAPI/Swagger spec for all API endpoints. Include: request/response schemas, authentication requirements, error codes, examples. Use swagger-jsdoc or manual YAML.

4. Deployment runbook: Document step-by-step production deployment process. Include: pre-deploy checklist, deploy commands, post-deploy verification, rollback procedure.

5. Database backup procedures: Document D1 backup process. Create automated backup script. Document restore procedure.

6. Monitoring verification: Verify Sentry is capturing errors. Verify /health endpoint is accessible. Verify Web Vitals are reporting. Check alert thresholds are configured.

7. Incident response playbook: Document common issues and resolution steps. Include: API down, database errors, high error rate, performance degradation.

8. Production deployment checklist:
   - All env vars set in Cloudflare
   - D1 production database migrated
   - API deployed via CI/CD
   - Web apps deployed via CI/CD
   - Health check returns 200
   - Smoke test passes (login, create order, view analytics)

9. Production deploy: Merge to main via CI/CD. Monitor deployment.

10. Post-deploy verification: Run health check, smoke test on production, verify monitoring, check Sentry for errors.

Create docs/ directory with: api-docs.yaml, deployment-runbook.md, incident-playbook.md, backup-restore.md.`
  }
];

async function seedEpics(port: number, dryRun: boolean): Promise<void> {
  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const epic of epics) {
    const payload = {
      title: epic.title,
      goalText: epic.goalText,
      targetDir: TARGET_DIR,
      targetBranch: epic.branch,
      scheduledDate: epic.scheduledDate,
    };

    if (dryRun) {
      console.log(`[DRY RUN] Day ${String(epic.day).padStart(2, "0")} | ${epic.scheduledDate} | ${epic.branch}`);
      created++;
      continue;
    }

    try {
      const res = await fetch(`${API_HOST}:${port}/api/epics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.text();
        console.error(`FAIL Day ${String(epic.day).padStart(2, "0")} | ${res.status} | ${body.slice(0, 120)}`);
        failed++;
        continue;
      }

      const data = await res.json() as { epic?: { id: string }; runId?: string | null };
      const runInfo = data.runId ? ` | run=${data.runId}` : " | scheduled";
      console.log(`  OK  Day ${String(epic.day).padStart(2, "0")} | ${epic.scheduledDate} | ${epic.branch} | epic=${data.epic?.id ?? "?"}${runInfo}`);
      created++;
    } catch (err) {
      console.error(`FAIL Day ${String(epic.day).padStart(2, "0")} | ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Done. Created: ${created} | Failed: ${failed} | Total: ${epics.length}`);
  if (dryRun) console.log("(dry run — no epics were actually created)");
  console.log(`${"=".repeat(60)}\n`);
}

// --- CLI ---
const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : DEFAULT_PORT;
const dryRun = args.includes("--dry-run");

console.log(`\nShop Diary V3 — 40-Day Production Readiness Seeder`);
console.log(`API: ${API_HOST}:${port} | Dry run: ${dryRun}`);
console.log(`Epics: ${epics.length} | Start: ${epics[0]?.scheduledDate} | End: ${epics[epics.length - 1]?.scheduledDate}`);
console.log(`${"=".repeat(60)}\n`);

seedEpics(port, dryRun);
