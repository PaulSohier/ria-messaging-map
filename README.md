# Ria Money Transfer — Customer Messaging Map V3.0
Internal dashboard mapping all customer-facing messages across channels, intents, and markets.

## What is this?
A single-file interactive dashboard that centralises all messaging intelligence for Ria B&M and Digital customers. Built for the CX team to understand what messages are sent, when, to whom, and at what cost.

## What's inside

**Tab 1 — Message Flow Map**
Visual diagram of message routes. Filter by trigger event and country to see which regions receive a message, through which channel, and to whom.

**Tab 2 — Messages Library**
The full message library. Browse all live templates by intent and audience. Click any card to read the full message content.

**Tab 3 — Customer Journeys**
The six main customer scenarios (Order Confirmed, Order Pickup, Pickup Reminders, Cancelled & Refund, Legal Hold, Transfer Resent), with the messaging attached to each step.

**Tab 4 — SMS Cost Calculator**
Country-level SMS cost projection based on 2025 order volumes and current Clickatell telco rates.

**Tab 5 — Twilio SMS Calculator**
Same cost model as Tab 4, using Twilio's contracted rates (Order Form 00142240.0, effective Aug 1, 2025) instead of Clickatell's. Built to estimate the cost of sending B&M SMS through Iterable, which routes via Twilio. Covers only the 55 countries priced in the current Twilio contract — other countries fall back to Twilio's public rate card (twilio.com/pricing), which is not reflected in this tab. US and Canada rates exclude an additional, unquantified carrier-fee surcharge (twilio.com/sms/pricing). A subset of priced countries have no order-volume data on file and require manual entry.

**Tab 6 — Global Deployment Cost**
Executive view of projected SMS spend across all 139 markets. Sortable by any column. Filter by region or individual country.

## Data sources
- **B&M messaging templates** — Clickatell
- **Digital messaging templates** — Ria Iterable (global) and MY Wallet platform (Malaysia)
- **Order volumes** — Power BI, all B&M markets, 2025
- **SMS costs (Clickatell)** — current contracted telco rates
- **SMS costs (Twilio)** — Twilio Order Form 00142240.0, Exhibit A rate schedule, effective Aug 1, 2025
- **Clickatell billing** — 2025 invoices

## Live data connection (V2.0+)
The dashboard is connected to a Google Sheet as its live data source. All message templates are stored in the sheet across two tabs — **B&M** and **Digital** — following the same column structure as the Ria transactional message library, with one additional column: **Intent**.

When a new message is added to the library, copy the row into the relevant sheet tab, fill in the Intent column, and the dashboard will reflect the update on next refresh. No file replacement needed.

Sheet structure mirrors the library exactly:
`Product type | Channel | Event that triggers the message send | Message template title | Message | Subject | Language | Send system | Message recipient | From address | Format type | Service | Payment method | Country to | B&M email message incl. HTML | MessageID | Event ID | Agent Company | Intent`

Note: the SMS cost calculators (Tabs 4 and 5) and the Global Deployment Cost tab (Tab 6) are **not** sheet-fed — country rates, order volumes, and US participation rates are hardcoded in `index.html`. Updating a rate in either calculator requires a code edit and a new push, not a sheet update.

## How to update the dashboard interface
Replace `index.html` in this repository with the new version. The URL stays the same.

## Owner
CX Team — Ria Money Transfer
Built and maintained by Paul
