# Stripe implementation plan

Business: <https://abtax.jp>
Service: Japanese tax and accounting services
Official Stripe planner guide: `iguide_61V5g51aIVSDy6Wka412QcCVCJjtj` (`accepted`)

## Selected official integration paths

- Payments: Stripe-hosted Checkout Sessions for browser-based, one-time or
  subscription payments. The first implemented LINE path uses subscription
  mode.
- Billing: fixed recurring Prices. Existing `usage_events` remain entitlement
  counters; they are not metered billing inputs.
- Invoicing: Invoicing API triggered by an approved engagement/business event,
  with Hosted Invoice Page and automatic advancement.
- Tax: Stripe Tax `automatic_tax` for Checkout and invoices. Configure the
  correct Product tax code and inclusive/exclusive tax behavior in Stripe
  before enabling the flow.
- Lifecycle: Stripe-hosted Customer Portal, Smart Retries, and webhook-driven
  local state.
- Reconciliation: verified and idempotent webhooks project Stripe state into
  PostgreSQL. Stripe remains the billing source of truth.

Official references:

- <https://docs.stripe.com/payments/accept-a-payment?payment-ui=checkout&ui=stripe-hosted>
- <https://docs.stripe.com/billing/quickstart>
- <https://docs.stripe.com/customer-management/integrate-customer-portal>
- <https://docs.stripe.com/invoicing/integration>
- <https://docs.stripe.com/invoicing/hosted-invoice-page>
- <https://docs.stripe.com/webhooks/signature>
- <https://docs.stripe.com/tax/checkout>

## Existing-system mapping

| Existing capability | Stripe relationship | Local authorization rule |
| --- | --- | --- |
| LINE Official Account AI answers | Billing subscription | `users` is updated by Stripe webhook; `usage_events` enforces the plan allowance |
| LINE WORKS tax-accountant consultation | Billing subscription | `tax_review` reservations remain transactional and idempotent |
| PostgreSQL membership ledger | Customer, Subscription, Price | Store opaque Stripe IDs only; do not store payment method or card data |
| PostgreSQL webhook ledger | Event | Unique `(provider, event_id)` and payload hash prevent duplicate/replayed processing |
| Professional engagements | Invoice, Invoice Item | Stable engagement ID in metadata; customer-visible service detail in line-item description |

The Stripe customer mapping is `users.stripe_customer_id`; subscription mapping
is `users.stripe_subscription_id`. `stripe_billing_objects` is a compact
reconciliation projection for Checkout Sessions and invoices.

When a linked Stripe subscription is active, past due, scheduled to cancel, or
suspended, later LINE membership webhooks do not overwrite that Stripe state.
Moving a customer back to LINE billing therefore requires an explicit,
auditable operator migration after the Stripe subscription is closed.

## Implemented code

- `lib/stripe/client.ts`: server-only SDK initialization and test-key guard.
- `lib/stripe/billing.ts`: hosted subscription/one-time Checkout, Customer
  Portal, and professional service invoice creation.
- `lib/stripe/webhooks.ts`: event-to-ledger projection.
- `app/api/stripe/webhook/route.ts`: raw-body signature verification, test-mode
  rejection of live events, event idempotency, and retry-safe failure status.
- `migrations/002_stripe_billing.sql`: Stripe IDs and billing-object projection.
- `app/billing/success` and `app/billing/cancel`: Checkout return pages.
- `app/billing/manage`: Customer Portal return page.
- LINE pricing inquiries create an `anshin` Checkout Session only when
  `STRIPE_BILLING_ENABLED=true`; the default is disabled.
- LINE cancellation inquiries create a short-lived, Stripe-hosted Customer
  Portal link for the Stripe Customer and Subscription mapped to that exact
  LINE user. The portal opens the subscription cancellation flow; cancellation
  is scheduled at the end of the paid period.

Handled webhook events:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`
- `invoice.voided`

## Required test-mode configuration

Apply `migrations/001_membership_billing.sql` and then
`migrations/002_stripe_billing.sql` to a disposable/test database.

Set these only in a secure server environment:

```text
STRIPE_BILLING_ENABLED=false
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ANSHIN=price_...
STRIPE_PRICE_PREMIUM=price_...
STRIPE_PORTAL_CONFIGURATION_ID=bpc_...
STRIPE_APP_BASE_URL=https://test-host.example
```

Run `pnpm run check:stripe` before migrations or starting the test flow. The
check prints only pass/missing status, rejects live-mode keys, and never prints
credential values.

In the Stripe sandbox:

1. Create Products and recurring Prices for active plans.
2. Set the Product tax codes and Price tax behavior (inclusive or exclusive)
   according to the approved Japanese pricing presentation.
3. Configure Tax registrations and the business origin address.
4. Configure the Customer Portal and Smart Retries.
5. Register the test webhook endpoint at `/api/stripe/webhook`.
6. Subscribe only to the handled event types above.

Keep `MEMBERSHIP_BILLING_ENABLED` and `STRIPE_BILLING_ENABLED` false until the
test migration, webhook replay tests, and business acceptance checks pass.

## Local and Sandbox verification (2026-07-23)

Completed without live-mode access, real customer data, production deployment,
or Git push:

- 56 unit/regression tests passed; ESLint and TypeScript checks passed.
- An isolated production build passed.
- PostgreSQL migrations were applied to the disposable local
  `apexbrain_test` database on port `55432`.
- A signed synthetic LINE pricing webhook created a Stripe Sandbox Checkout
  link, and duplicate delivery was suppressed.
- A signed synthetic LINE cancellation inquiry created an HTTPS
  `billing.stripe.com` Customer Portal link for the mapped synthetic member,
  and duplicate delivery was suppressed.
- The separate `GPT-san` LINE test channel completed an external
  device-to-Cloudflare-to-local webhook test. A real test message returned a
  Stripe Sandbox Checkout button, Checkout completed with a Stripe test card,
  and PostgreSQL projected the linked member to `anshin / active`.
- The same LINE test account opened the Stripe Customer Portal, scheduled
  cancellation at the period end, and received the follow-up
  cancellation-scheduled response. PostgreSQL projected the member to
  `cancel_at_period_end` while retaining the `anshin` entitlement through the
  current period.
- Signed synthetic `customer.subscription.updated` and
  `customer.subscription.deleted` events projected scheduled cancellation and
  completed cancellation into PostgreSQL correctly.
- The local return pages `/billing/success`, `/billing/cancel`, and
  `/billing/manage` returned HTTP 200 and were marked `noindex`.
- A Stripe CLI Sandbox listener and the local Next.js server were exercised
  successfully.

Issues found and corrected during the external test:

- The short natural-language request `料金を教えて` now routes to the fixed
  pricing response instead of the general AI path.
- Nullable Stripe identity lookup parameters no longer produce PostgreSQL
  parameter type ambiguity when one of Customer or Subscription ID is absent.
- Stripe Portal cancellations using an explicit `cancel_at` timestamp are
  treated as `cancel_at_period_end`, even when Stripe reports
  `cancel_at_period_end=false`.
- A failed original test event remains in the webhook audit ledger; a new
  signed verification event with the same Invoice content processed
  successfully after the fix.

Still required before production:

- Business approval of customer-facing wording, cancellation policy, refund
  handling, qualified-invoice requirements, and Stripe Tax registration.
- Explicit authorization for production secrets, production migration,
  deployment, real-customer changes, and Git push.
- Follow the approval gates, phased rollout, incident response, cancellation,
  refund, and reconciliation procedures in `STRIPE_PRODUCTION_RUNBOOK.md`.

## Acceptance and rollout gates

1. Unit, regression, lint, typecheck, and production build pass locally.
2. Stripe CLI or sandbox webhook tests cover success, failure, duplicate,
   out-of-order, cancellation, and renewal scenarios.
3. Test DB reconciliation shows Stripe Customer/Subscription/Invoice IDs map to
   the intended synthetic LINE users.
4. Confirm Japanese invoice wording, consumption-tax presentation, qualified
   invoice requirements, retention, and refund/credit-note operations with the
   responsible tax professional.
5. Obtain explicit approval before any live key, live-mode API call, production
   migration/deployment, real-customer mutation, or Git push.

## Explicitly not performed

- No Stripe live-mode writes or charges
- No production database migration
- No production deployment
- No real-customer data update
- No secret-value inspection or logging
- No Git push
