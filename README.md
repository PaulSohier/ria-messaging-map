# Messaging Hub V4.4.1.2

Internal dashboard mapping all customer-facing messages across channels, intents, and markets — plus the cost modeling behind them.

## What is this?

A single-file interactive dashboard that centralises all messaging intelligence and cost modeling for Ria B&M and Digital customers. Built for the CX team to understand what messages are sent, when, to whom, at what cost, and why the numbers say what they say.

## What's inside

Navigation is grouped into three sections in the left sidebar:

### Explore

**Message Flow Map**
Visual diagram of message routes. Filter by trigger event and country to see which regions receive a message, through which channel, and to whom. Renders progressively as you scroll (only builds the routes currently in view, not all of them at once), and the URL updates as you filter — copy the link to share the exact view you're looking at.

**Messages Library**
The full message library. Browse all live templates by intent and audience. Click any card to read the full message content. Every card also has a 🔗 share icon — click it to copy a link straight to that specific message, so anyone who opens it lands on that exact card, already expanded, without needing to be walked through which filters to click.

**Customer Journeys**
The six main customer scenarios (Order Confirmed, Order Pickup, Pickup Reminders, Cancelled & Refund, Legal Hold, Transfer Resent), with the messaging attached to each step. Each message is cross-matched against the live sheet by title, so anything not marked Live there won't show here either.

### Cost Modeling

**SMS Cost Calculator**
Country-level SMS cost projection based on 2025 order volumes and current Clickatell telco rates. Includes an SMS opt-in scenario slider — models what cost looks like if the share of customers opted in to SMS changes, using today's real US opt-in rate (≈26%) as the baseline.

**Twilio SMS Calculator**
Same cost model, using Twilio's contracted rates (Order Form 00142240.0, effective Aug 1, 2025) instead of Clickatell's. Built to estimate the cost of sending B&M SMS through Iterable, which routes via Twilio. Covers only the 57 countries priced in the current Twilio contract — other countries fall back to Twilio's public rate card (twilio.com/pricing), which is not reflected in this tab. US and Canada rates exclude an additional, unquantified carrier-fee surcharge (twilio.com/sms/pricing). 11 priced countries have no order-volume data on file and require manual entry.

**Global Deployment Cost**
Executive view of projected SMS spend across all 139 markets, using Clickatell rates. Sortable by any column. Filter by region or individual country.

**Global Deployment Twilio**
Same view, using Twilio's rate card. Covers 46 markets — the subset of the 57 Twilio-priced countries that also have order-volume data on file. The 11 without order data are listed in-tab rather than estimated.

### Methodology

**How We Calculate This**
A plain-language breakdown of the three cost concepts used throughout the tool (actual cost, cost at full scale, cost at an opt-in scenario), the participation-rate proxy model, what "Live" means and how it's enforced, and every data source behind the numbers.

## Data sources

- **B&M messaging templates** — Clickatell
- **Digital messaging templates** — Ria Iterable (global) and MY Wallet platform (Malaysia)
- **Order volumes** — Power BI, all B&M markets, 2025
- **SMS costs (Clickatell)** — current contracted telco rates
- **SMS costs (Twilio)** — Twilio Order Form 00142240.0, Exhibit A rate schedule, effective Aug 1, 2025
- **Clickatell billing** — 2025 invoices
- **SMS opt-in data** — US opt-in counts by channel (email/SMS/WhatsApp), used as the opt-in baseline

## Live data connection

The dashboard is connected to a Google Sheet as its live data source. All message templates are stored in the sheet across two tabs — **B&M** and **Digital** — following the same column structure as the Ria transactional message library, with two additional columns: **Intent** and **Live**.

Only rows marked **Live = Yes** are ever pulled into the dashboard — that filter happens server-side, via a Google Sheets query, so non-live rows are never even downloaded, not just hidden after the fact. This applies to Message Flow Map, Messages Library, and (via title cross-match) Customer Journeys.

When a new message is added to the library, copy the row into the relevant sheet tab, fill in the Intent column, mark Live as needed, and the dashboard will reflect the update on next refresh. No file replacement needed.

Sheet structure mirrors the library exactly:

`Product type | Channel | Event that triggers the message send | Message template title | Message | Subject | Language | Send system | Message recipient | From address | Format type | Service | Payment method | Country to | B&M email message incl. HTML | MessageID | Event ID | Agent Company | Intent | Live`

**Note:** the SMS cost calculators and both Global Deployment Cost tabs are **not** sheet-fed — country rates, order volumes, and US participation rates are hardcoded in `index.html`. Updating a rate in any of these requires a code edit and a new push, not a sheet update.

**Note on message links:** the sheet's `MessageID` column is currently blank on every row, so per-message share links are built from a combination of title, region, channel, event, recipient, agent, and service instead. That's unique for the large majority of messages — a small number of genuine exact-duplicate rows in the sheet share a link, which is harmless since they show identical content either way. Populating `MessageID` for real would make this fully precise.

## First-time / returning users

The dashboard shows a one-time welcome message to first-time visitors. Returning users get a callout whenever something worth knowing has shipped since their last visit — a fuller "what's new" recap if they're coming from before the V4 redesign, or a lighter single-feature spotlight for smaller additions (e.g. the message share-link). Nothing repeats once dismissed for that version — this is tracked per-browser via local storage, keyed to the app version.

## Opt-in rates (new — Aug 2026)

The **Opt-in rates** tab reads `data/optin-daily.json`, one entry per day (global figures — always complete — plus a per-country breakdown). It's designed to be filled in one of two ways:

1. **Automated (goal state):** `scripts/pull-optin-data.js`, run daily by `.github/workflows/pull-optin-data.yml`, calls the Power BI **Execute Queries** REST API against the dataset behind the Opt-in report and appends a new snapshot automatically — no manual capture. **Not live yet** — it needs Power BI access set up first (see checklist below), and it's untested against the real API since there are no credentials on file. Run it once by hand via `workflow_dispatch` and check `data/optin-daily.json` closely before trusting the schedule.
2. **Manual fallback:** screenshot the Opt-in PowerBI dashboard (header tiles at minimum, full country table if there's time), paste into a Claude chat, and ask it to append a new entry to `data/optin-daily.json` following the existing shape.

### Setup checklist to go live with the automated pull

Needs someone with Power BI tenant-admin rights (likely IT/data team, not Care/CX):

- [ ] Register a Microsoft Entra (Azure AD) app for this integration — note its **App ID**.
- [ ] Create a Microsoft Entra **security group**, add the app as a member.
- [ ] Add that app as a member (Viewer is enough) of the Power BI **workspace** containing the Opt-in dataset.
- [ ] In the Power BI Admin Portal → Tenant settings → Integration settings, enable **"Dataset Execute Queries REST API"**, scoped to the security group above.
- [ ] Get the **Dataset ID** behind the Opt-in report (Workspace → dataset settings, or the `Get Datasets` API).
- [ ] Confirm the real table/measure names behind the report's visual (Power BI Desktop → Performance Analyzer → copy query, or DAX Studio) and update `POWERBI_DAX_QUERY` if the placeholder in `pull-optin-data.js` doesn't match — it's a best-guess from the screenshot, not confirmed against the actual model.
- [ ] Add repo secrets: `POWERBI_TENANT_ID`, `POWERBI_CLIENT_ID`, `POWERBI_CLIENT_SECRET`, `POWERBI_DATASET_ID`, and optionally `POWERBI_DAX_QUERY` if it needs to differ from the script's default.
- [ ] Run the workflow manually (`workflow_dispatch`) and check the committed `data/optin-daily.json` before relying on the daily schedule.

**Note:** this is the same technical shape as **CGD-5905** ("PowerBI | B&M Messaging Cost, Delivery & Activation Tracking"), which was scoped and then cancelled. Worth checking why before assuming this smaller version clears the same access/security bar.

## How to update the dashboard interface

Replace `index.html` in this repository with the new version. The URL stays the same.

## Owner

CX Team — Ria Money Transfer
Built and maintained by Paul
