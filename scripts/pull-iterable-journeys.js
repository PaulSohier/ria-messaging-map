// Pulls journeys + their triggered campaigns (+ template content) from Iterable,
// and writes a clean, PII-free JSON snapshot for the Messaging Hub to read.
//
// SAFETY MODEL — read this before changing scope:
//   - Only ever calls journey/campaign/template endpoints. Never calls anything
//     under /users, /lists, /campaigns/metrics, /events, or similar.
//   - JOURNEY_IDS is optional. Leave it blank to pull every journey (and every
//     standalone, non-journey campaign) for the selected environment — this
//     is a deliberate choice made per run (visible in the run log below), not
//     an accident. Set it to a comma-separated list to restrict a run to
//     specific journeys only, e.g. for a one-off check.
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
const REQUEST_DELAY_MS = 150;
const MAX_RETRIES = 6;

async function iterableGet(path) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { 'Api-Key': API_KEY },
    });

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

    const json = await res.json();
    await sleep(REQUEST_DELAY_MS);
    return json;
  }
  throw new Error(`Iterable API error on ${path}: still rate limited after ${MAX_RETRIES} retries.`);
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

async function withContent(campaigns) {
  const out = [];
  for (const c of campaigns) {
    const safeCampaign = pickSafeCampaign(c);
    const content = await fetchTemplateContent(safeCampaign.channel, safeCampaign.templateId);
    out.push({ ...safeCampaign, content });
  }
  return out;
}

async function main() {
  console.log(FULL_PULL
    ? 'FULL PULL: no JOURNEY_IDS given — pulling every journey and every standalone campaign for this environment.'
    : `RESTRICTED PULL: pulling ${JOURNEY_IDS.length} specific journey(s): ${JOURNEY_IDS.join(', ')}`);

  // Sequential on purpose, not Promise.all: fetching journeys and campaigns
  // at the same time doubles the request rate against the same rate limit
  // that /campaigns already hits on its own during a full pull.
  const allJourneys = await fetchAllJourneys();
  const allCampaigns = await fetchAllCampaigns();
  console.log(`Fetched ${allJourneys.length} journey(s) and ${allCampaigns.length} campaign(s) from the account.`);

  const journeysToProcess = FULL_PULL
    ? allJourneys
    : JOURNEY_IDS.map(id => {
        const journey = allJourneys.find(j => j.id === id);
        if (!journey) console.warn(`Journey ${id} not found — skipping.`);
        return journey;
      }).filter(Boolean);

  const results = [];

  for (const journey of journeysToProcess) {
    const matchingCampaigns = allCampaigns.filter(c => c.workflowId === journey.id);
    const campaignsWithContent = await withContent(matchingCampaigns);

    // Derive a journey-level category from whatever label appears most often
    // across its campaigns (e.g. "Transactional", "Growth", "Post-transactional").
    const labelCounts = {};
    campaignsWithContent.forEach(c => {
      (c.labels || []).forEach(l => { labelCounts[l] = (labelCounts[l] || 0) + 1; });
    });
    const category = Object.keys(labelCounts).sort((a, b) => labelCounts[b] - labelCounts[a])[0] || 'Uncategorized';

    results.push({
      ...pickSafeJourney(journey),
      category,
      campaigns: campaignsWithContent,
    });
  }

  // Campaigns not tied to any journey (e.g. one-off Blast sends) are only
  // ever collected on a full pull — a restricted, ID-based run stays scoped
  // to exactly the journeys asked for, nothing extra.
  let standaloneCampaigns = [];
  if (FULL_PULL) {
    const processedJourneyIds = new Set(journeysToProcess.map(j => j.id));
    const standaloneRaw = allCampaigns.filter(c => !c.workflowId || !processedJourneyIds.has(c.workflowId));
    standaloneCampaigns = await withContent(standaloneRaw);
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
