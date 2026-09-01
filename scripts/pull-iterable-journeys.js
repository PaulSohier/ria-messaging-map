// Pulls journeys + their triggered campaigns (+ template content) from Iterable,
// and writes a clean, PII-free JSON snapshot for the Messaging Hub to read.
//
// SAFETY MODEL — read this before changing scope:
//   - Only ever calls journey/campaign/template endpoints, plus (added Sep
//     2026, deliberately, per Paul) /campaigns/metrics for aggregate
//     per-campaign counts (sends, opens, clicks, unsubscribes). That's
//     account-level aggregate performance data, not PII — no individual
//     recipient is ever named or identifiable in it. Still never calls
//     anything under /users, /lists, /events, or similar.
//   - JOURNEY_IDS is optional. Leave it blank for a full pull, which (as of
//     Sep 2026, per Paul) is filtered down to enabled journeys under the
//     "Transactional" / "Transaction status" categories only — see
//     CATEGORY_FILTER / ENABLED_ONLY below — not literally every journey in
//     the account any more. Set JOURNEY_IDS to a comma-separated list to
//     restrict a run to specific journeys instead; an explicit list like
//     that always bypasses CATEGORY_FILTER/ENABLED_ONLY and is pulled
//     exactly as asked, disabled or not, any category.
//   - Journey IDs are account-specific: an ID that means one thing in Sandbox
//     can point at a completely different (or unrelated) journey in Ria
//     Digital Prod or Xe Digital Prod. Never reuse one environment's ID list
//     for another environment's run.
//   - Every object written to the output file is built field-by-field from an
//     explicit allowlist (see pickSafe* functions below). Nothing is ever
//     spread/passed through wholesale from the Iterable API response — new
//     fields Iterable adds later do NOT automatically appear in the output.
//   - This file is committed to the repo and published on GitHub Pages, i.e.
//     public. Treat every field added to an allowlist as something you are
//     comfortable with anyone on the internet reading. This applies to every
//     environment (Sandbox, Ria Digital Prod, Xe Digital Prod) equally — Prod
//     data gets no less scrutiny than Sandbox data.
//
// Run it once by hand (workflow_dispatch) for any new environment and inspect
// the output file closely before trusting it to run unattended on a schedule.

// Confirmed Sep 2026: Ria Digital Prod's Iterable account is on the same data
// center as Sandbox (app.iterable.com / api.iterable.com — the default "US"
// data center). If Xe Digital Prod turns out to be on a different data
// center (e.g. an app.eu.iterable.com URL), this will need to become a
// per-environment value instead of one constant.
const API_BASE = 'https://api.iterable.com/api';
const API_KEY = process.env.ITERABLE_API_KEY;
const OUTPUT_FILE = process.env.OUTPUT_FILE;
const SOURCE_LABEL = process.env.SOURCE_LABEL;
const JOURNEY_IDS = (process.env.JOURNEY_IDS || '')
  .split(',')
  .map(s => parseInt(s.trim(), 10))
  .filter(n => !Number.isNaN(n));
// Campaigns not tied to any journey (one-off Blast sends etc). Off by default:
// fetching their template content is the slowest part of a full pull and,
// per Paul (Sep 2026), the Hub doesn't need them right now, only journeys and
// what's attached to them. Turn on with INCLUDE_STANDALONE=true when needed.
const INCLUDE_STANDALONE = (process.env.INCLUDE_STANDALONE || 'false').toLowerCase() === 'true';

// Which journey categories to keep on a full pull (case-insensitive match
// against the same derived `category` — most common label among a journey's
// campaigns — the Hub already groups by). Per Paul (Sep 2026): only
// Transactional and Transaction status are needed right now, not the whole
// account. Comma-separated, blank = no category filtering (keep every
// category). Only applies when FULL_PULL; an explicit JOURNEY_IDS list is
// always honored as-is.
// Note: uses "!== undefined", not "||" — the workflow always sets this env
// var to SOMETHING (its own YAML default, or '' if Paul deliberately clears
// the field to mean "no filter, keep every category"). "||" would silently
// override an intentional blank back to the default, which defeats the point
// of being able to clear it.
const CATEGORY_FILTER = (process.env.CATEGORY_FILTER !== undefined ? process.env.CATEGORY_FILTER : 'Transactional,Transaction status')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
// Enabled journeys only, per Paul (Sep 2026) — skip disabled ones. Only
// applies when FULL_PULL; an explicit JOURNEY_IDS list is always honored
// as-is, enabled or not.
const ENABLED_ONLY = (process.env.ENABLED_ONLY || 'true').toLowerCase() === 'true';

if (!API_KEY) {
  console.error('Missing ITERABLE_API_KEY environment variable.');
  process.exit(1);
}
if (!OUTPUT_FILE) {
  console.error('Missing OUTPUT_FILE environment variable (e.g. data/iterable-journeys.json).');
  process.exit(1);
}
if (!SOURCE_LABEL) {
  console.error('Missing SOURCE_LABEL environment variable (e.g. iterable-sandbox).');
  process.exit(1);
}
const FULL_PULL = JOURNEY_IDS.length === 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// A full pull makes thousands of calls (campaign pages + one template lookup
// per unique template), which is enough to hit Iterable's rate limit even
// on a single well-behaved script. Confirmed Sep 2026 against Ria Digital
// Prod: plain pagination alone hit a 429 on page 6 of /campaigns. So every
// call goes through this retry wrapper, and a small fixed delay is added
// after each successful call too, to stay under the limit instead of just
// reacting to it.
//
// It also happened once that a run went quiet mid-page with no error and no
// new log line — most likely just the Actions log view lagging behind the
// real run, but a request that never gets a response (network stall, no
// timeout) would look identical: stuck forever with nothing printed. So
// every call now has its own timeout via AbortController, and a timeout
// counts as a retryable failure just like a 429, instead of hanging silently
// until GitHub's own job timeout eventually kills the whole run.
const REQUEST_DELAY_MS = 150;
const MAX_RETRIES = 6;
const REQUEST_TIMEOUT_MS = 30000;

// Shared retry/timeout wrapper, returns the raw Response so callers decide
// how to parse the body (most endpoints are JSON; /campaigns/metrics' raw
// response shape isn't confirmed the same way, see iterableGetMetricsRow).
async function iterableFetch(path) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        headers: { 'Api-Key': API_KEY },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (attempt === MAX_RETRIES) {
        throw new Error(`Iterable API error on ${path}: gave up after ${MAX_RETRIES} attempts (${err.message}).`);
      }
      const waitMs = Math.min(30000, 1000 * 2 ** attempt);
      console.warn(`Request to ${path} did not respond within ${REQUEST_TIMEOUT_MS / 1000}s (attempt ${attempt}/${MAX_RETRIES}: ${err.message}) — waiting ${Math.round(waitMs / 1000)}s before retrying.`);
      await sleep(waitMs);
      continue;
    }
    clearTimeout(timeout);

    if (res.status === 429) {
      const retryAfterHeader = res.headers.get('Retry-After');
      const waitMs = retryAfterHeader
        ? Math.max(1000, parseFloat(retryAfterHeader) * 1000)
        : Math.min(30000, 1000 * 2 ** attempt); // exponential backoff, capped at 30s
      console.warn(`Rate limited on ${path} (attempt ${attempt}/${MAX_RETRIES}) — waiting ${Math.round(waitMs / 1000)}s before retrying.`);
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      throw new Error(`Iterable API error ${res.status} on ${path}: ${await res.text()}`);
    }

    await sleep(REQUEST_DELAY_MS);
    return res;
  }
  throw new Error(`Iterable API error on ${path}: still failing after ${MAX_RETRIES} retries.`);
}

async function iterableGet(path) {
  const res = await iterableFetch(path);
  return res.json();
}

// campaigns/metrics: Iterable documents this as a CSV export, but exact raw
// shape isn't independently confirmed from this script (only via the
// Iterable MCP tool locally, which may already be parsing it). Handle both:
// try JSON first, fall back to a one-row CSV parse. If real runs show this
// coming back empty/wrong, that mismatch is the first thing to check.
async function iterableGetMetricsRow(path) {
  const res = await iterableFetch(path);
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    return (Array.isArray(json) ? json[0] : json) || null;
  } catch (e) {
    return parseCsvRow(text);
  }
}

function parseCsvRow(csvText) {
  const lines = String(csvText || '').trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const splitCsvLine = (line) => {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
        else if (ch === '"') { inQuotes = false; }
        else cur += ch;
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        out.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  };
  const headers = splitCsvLine(lines[0]);
  const values = splitCsvLine(lines[1]);
  const row = {};
  headers.forEach((h, i) => { row[h] = values[i]; });
  return row;
}

// --- Explicit allowlists. Add fields here deliberately, not by convenience. ---

function pickSafeJourney(j) {
  return {
    id: j.id,
    name: j.name,
    triggerEventNames: j.triggerEventNames || [],
    enabled: !!j.enabled,
    isArchived: !!j.isArchived,
  };
}

function pickSafeCampaign(c) {
  return {
    id: c.id,
    name: c.name,
    channel: c.messageMedium, // "Email" | "Push" | "InApp" | "SMS"
    templateId: c.templateId,
    labels: c.labels || [],
    campaignState: c.campaignState || null, // e.g. "Running" | "Draft" | "Archived" | "Aborted" | ...
  };
}

function pickSafeTemplateContent(medium, tpl) {
  if (!tpl) return null;
  if (medium === 'Email') {
    return {
      subject: tpl.subject || null,
      preview: stripHtml(tpl.html || tpl.plainText || '').slice(0, 240) || null,
      html: tpl.html || null,
    };
  }
  if (medium === 'Push') {
    return {
      title: tpl.title || null,
      message: tpl.message || null,
    };
  }
  if (medium === 'InApp') {
    const body = tpl.htmlContent || tpl.html || null;
    return {
      preview: stripHtml(body || '').slice(0, 240) || null,
      html: body || null,
    };
  }
  return null;
}

function decodeEntities(str) {
  const named = {
    nbsp: ' ', zwnj: '', zwj: '', amp: '&', lt: '<', gt: '>',
    quot: '"', apos: "'", '#39': "'",
  };
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z#0-9]+);/g, (m, name) => (name in named ? named[name] : m));
}

function stripHtml(html) {
  return decodeEntities(String(html))
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchAllJourneys() {
  const all = [];
  let page = 1;
  for (;;) {
    const data = await iterableGet(`/journeys?page=${page}&pageSize=50`);
    all.push(...(data.journeys || []));
    if (!data.nextPageUrl) break;
    page += 1;
  }
  return all;
}

async function fetchAllCampaigns() {
  // Real pagination, not a single capped call. Confirmed Sep 2026 against
  // Ria Digital Prod: a single pageSize=1000 call silently truncated a
  // 9,290-campaign account down to 1,000 with no error, so this loops using
  // the API's own nextPageUrl (same pattern as fetchAllJourneys) until it's
  // exhausted, and cross-checks against the API's own totalCampaignsCount.
  const all = [];
  let page = 1;
  let advertisedTotal = null;
  for (;;) {
    const data = await iterableGet(`/campaigns?pageSize=1000&page=${page}`);
    const batch = data.campaigns || [];
    all.push(...batch);
    if (advertisedTotal == null) {
      advertisedTotal = data.totalCampaignsCount ?? data.total ?? data.count ?? null;
    }
    console.log(`Campaigns page ${page}: got ${batch.length} (running total ${all.length}${advertisedTotal != null ? ` of ${advertisedTotal}` : ''}).`);
    if (!data.nextPageUrl) break;
    page += 1;
  }
  if (advertisedTotal != null && advertisedTotal !== all.length) {
    console.warn(`WARNING: fetched ${all.length} campaigns total, but the API reported totalCampaignsCount ${advertisedTotal} — mismatch, investigate before trusting this run.`);
  }
  return all;
}

// Real per-campaign metrics, added Sep 2026 per Paul (replaces the Hub's
// mock/placeholder numbers). Field names come straight from Iterable's
// metrics response for this account, sampled directly per channel — Email
// and Push confirmed against real campaigns; InApp/SMS field names below are
// a best guess following the same naming pattern and are NOT yet confirmed
// against a real InApp/SMS campaign in this account, first thing to check if
// those come back all-null.
const METRICS_FIELD_MAP = {
  Email: {
    sent: 'Total Email Sends',
    delivered: 'Unique Emails Delivered',
    opens: 'Unique Email Opens (filtered)',
    clicks: 'Unique Email Clicks (filtered)',
    unsubscribes: 'Unique Unsubscribes',
    bounced: 'Unique Emails Bounced',
  },
  Push: {
    sent: 'Total Pushes Sent',
    delivered: 'Unique Pushes Delivered',
    opens: 'Unique Pushes Opened',
    clicks: null, // pushes have no click concept
    unsubscribes: 'Unique Unsubscribes',
    bounced: 'Unique Pushes Bounced',
  },
  InApp: {
    sent: 'Total InApp Sends',
    delivered: 'Unique InApp Sends',
    opens: 'Unique InApp Opens',
    clicks: 'Unique InApp Clicks',
    unsubscribes: 'Unique Unsubscribes',
    bounced: null,
  },
  SMS: {
    sent: 'Total SMS Sends',
    delivered: 'Unique SMS Sends',
    opens: null, // SMS has no open concept
    clicks: 'Unique SMS Clicks',
    unsubscribes: 'Unique Unsubscribes',
    bounced: null,
  },
};

function toNumberOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function normalizeMetrics(channel, rawRow) {
  if (!rawRow) return null;
  const map = METRICS_FIELD_MAP[channel];
  if (!map) return null;
  const pick = key => (map[key] ? toNumberOrNull(rawRow[map[key]]) : null);
  return {
    sent: pick('sent'),
    delivered: pick('delivered'),
    opens: pick('opens'),
    clicks: pick('clicks'),
    unsubscribes: pick('unsubscribes'),
    bounced: pick('bounced'),
  };
}

function formatIterableDateTime(ms) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// "All time" per Paul (Sep 2026): from the campaign's own creation date up
// to right now. Iterable's metrics endpoint always needs an explicit range,
// there's no built-in "all time" shortcut, so this builds one per campaign.
async function fetchCampaignMetrics(rawCampaign) {
  if (!rawCampaign.createdAt) return null;
  const startDateTime = formatIterableDateTime(rawCampaign.createdAt);
  const endDateTime = formatIterableDateTime(Date.now());
  const path = `/campaigns/metrics?campaignId=${rawCampaign.id}&startDateTime=${encodeURIComponent(startDateTime)}&endDateTime=${encodeURIComponent(endDateTime)}`;
  let row;
  try {
    row = await iterableGetMetricsRow(path);
  } catch (err) {
    console.warn(`Could not fetch metrics for campaign ${rawCampaign.id}: ${err.message}`);
    return null;
  }
  return normalizeMetrics(rawCampaign.messageMedium, row);
}

// A full-account pull can have many campaigns sharing the same template, so
// cache template lookups by medium+id to cut down repeat API calls (matters
// more now than it did for a small, hand-picked journey list).
const templateCache = new Map();

async function fetchTemplateContent(medium, templateId) {
  if (!templateId) return null;
  const cacheKey = `${medium}:${templateId}`;
  if (templateCache.has(cacheKey)) return templateCache.get(cacheKey);

  const pathByMedium = {
    Email: `/templates/email/get?templateId=${templateId}`,
    Push: `/templates/push/get?templateId=${templateId}`,
    InApp: `/templates/inapp/get?templateId=${templateId}`,
  };
  const path = pathByMedium[medium];
  if (!path) {
    templateCache.set(cacheKey, null); // SMS and unknown mediums: no content lookup for now.
    return null;
  }
  let result;
  try {
    const tpl = await iterableGet(path);
    result = pickSafeTemplateContent(medium, tpl);
  } catch (err) {
    console.warn(`Could not fetch template ${templateId} (${medium}): ${err.message}`);
    result = null;
  }
  templateCache.set(cacheKey, result);
  return result;
}

// label/logEvery: this step used to run completely silently (thousands of
// individual template calls, one at a time, no output at all) which once
// looked exactly like a hung job when it wasn't. Now it prints progress.
async function withContent(campaigns, label, logEvery) {
  const out = [];
  let i = 0;
  for (const c of campaigns) {
    const safeCampaign = pickSafeCampaign(c);
    const content = await fetchTemplateContent(safeCampaign.channel, safeCampaign.templateId);
    const metrics = await fetchCampaignMetrics(c); // needs raw c.createdAt, not on safeCampaign
    out.push({ ...safeCampaign, content, metrics });
    i += 1;
    if (label && logEvery && (i % logEvery === 0 || i === campaigns.length)) {
      console.log(`${label}: fetched template content + metrics for ${i}/${campaigns.length} campaign(s).`);
    }
  }
  return out;
}

// Most-common-label category, computed from raw campaigns (labels are
// already present on the /campaigns list response, no content fetch
// needed) so this can run BEFORE the expensive per-campaign calls and
// decide whether a journey is even worth fetching content/metrics for.
function deriveCategory(campaignsForJourney) {
  const labelCounts = {};
  campaignsForJourney.forEach(c => {
    (c.labels || []).forEach(l => { labelCounts[l] = (labelCounts[l] || 0) + 1; });
  });
  return Object.keys(labelCounts).sort((a, b) => labelCounts[b] - labelCounts[a])[0] || 'Uncategorized';
}

async function main() {
  console.log(FULL_PULL
    ? `FULL PULL: no JOURNEY_IDS given — pulling every ${ENABLED_ONLY ? 'enabled ' : ''}journey${CATEGORY_FILTER.length ? ` under: ${CATEGORY_FILTER.join(', ')}` : ' (every category)'} for this environment.`
    : `RESTRICTED PULL: pulling ${JOURNEY_IDS.length} specific journey(s), exactly as listed (category/enabled filters do not apply): ${JOURNEY_IDS.join(', ')}`);

  // Sequential on purpose, not Promise.all: fetching journeys and campaigns
  // at the same time doubles the request rate against the same rate limit
  // that /campaigns already hits on its own during a full pull.
  const allJourneys = await fetchAllJourneys();
  const allCampaigns = await fetchAllCampaigns();
  console.log(`Fetched ${allJourneys.length} journey(s) and ${allCampaigns.length} campaign(s) from the account.`);

  const candidateJourneys = FULL_PULL
    ? allJourneys
    : JOURNEY_IDS.map(id => {
        const journey = allJourneys.find(j => j.id === id);
        if (!journey) console.warn(`Journey ${id} not found — skipping.`);
        return journey;
      }).filter(Boolean);

  const results = [];
  let skippedDisabled = 0;
  let skippedCategory = 0;

  for (let idx = 0; idx < candidateJourneys.length; idx += 1) {
    const journey = candidateJourneys[idx];
    const matchingCampaigns = allCampaigns.filter(c => c.workflowId === journey.id);
    const category = deriveCategory(matchingCampaigns);

    if (FULL_PULL && ENABLED_ONLY && !journey.enabled) {
      skippedDisabled += 1;
      continue;
    }
    if (FULL_PULL && CATEGORY_FILTER.length && !CATEGORY_FILTER.includes(category.toLowerCase())) {
      skippedCategory += 1;
      continue;
    }

    const campaignsWithContent = await withContent(matchingCampaigns);
    results.push({
      ...pickSafeJourney(journey),
      category,
      campaigns: campaignsWithContent,
    });

    if ((idx + 1) % 50 === 0 || idx + 1 === candidateJourneys.length) {
      console.log(`Journeys: checked ${idx + 1}/${candidateJourneys.length} (${results.length} kept, ${skippedDisabled} skipped disabled, ${skippedCategory} skipped wrong category so far)...`);
    }
  }
  if (FULL_PULL) {
    console.log(`Category/enabled filtering: kept ${results.length}, skipped ${skippedDisabled} disabled, skipped ${skippedCategory} outside ${CATEGORY_FILTER.join(', ') || '(no filter)'}.`);
  }

  // Campaigns not tied to ANY journey at all (e.g. one-off Blast sends) —
  // checked against every candidate journey, not just the ones kept after
  // category/enabled filtering, so a campaign belonging to a filtered-out
  // journey (e.g. a "Lifecycle" journey) is never mislabeled as standalone.
  // Only ever collected on a full pull — a restricted, ID-based run stays
  // scoped to exactly the journeys asked for, nothing extra. Also gated on
  // INCLUDE_STANDALONE: this is the single biggest chunk of a full pull's
  // runtime (potentially thousands of individual template calls) and isn't
  // needed by the Hub right now, so it's skipped by default.
  let standaloneCampaigns = [];
  if (FULL_PULL) {
    const allJourneyIds = new Set(candidateJourneys.map(j => j.id));
    const standaloneRaw = allCampaigns.filter(c => !c.workflowId || !allJourneyIds.has(c.workflowId));
    if (INCLUDE_STANDALONE) {
      console.log(`Fetching template content for ${standaloneRaw.length} standalone (non-journey) campaign(s)...`);
      standaloneCampaigns = await withContent(standaloneRaw, 'Standalone campaigns', 100);
    } else {
      console.log(`Skipping ${standaloneRaw.length} standalone (non-journey) campaign(s) — INCLUDE_STANDALONE is off.`);
    }
  }

  const output = {
    source: SOURCE_LABEL,
    pulledAt: new Date().toISOString(),
    journeys: results,
    standaloneCampaigns,
  };

  const fs = await import('fs');
  const path = await import('path');
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`Wrote ${OUTPUT_FILE} with ${results.length} journey(s) and ${standaloneCampaigns.length} standalone campaign(s).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
