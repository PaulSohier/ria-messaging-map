// Pulls journeys + their triggered campaigns (+ template content) from Iterable,
// and writes a clean, PII-free JSON snapshot for the Messaging Hub to read.
//
// SAFETY MODEL — read this before changing scope:
//   - Only ever calls journey/campaign/template endpoints. Never calls anything
//     under /users, /lists, /campaigns/metrics, /events, or similar.
//   - Only pulls journeys whose ID is explicitly listed in JOURNEY_IDS below
//     (or passed via the JOURNEY_IDS env var). This is intentional — it is an
//     allowlist, not "pull everything." Widening scope is a deliberate decision,
//     not a side effect of adding more journey IDs.
//   - Every object written to the output file is built field-by-field from an
//     explicit allowlist (see pickSafe* functions below). Nothing is ever
//     spread/passed through wholesale from the Iterable API response — new
//     fields Iterable adds later do NOT automatically appear in the output.
//   - This file is committed to the repo and published on GitHub Pages, i.e.
//     public. Treat every field added to an allowlist as something you are
//     comfortable with anyone on the internet reading.
//
// This script is UNTESTED against the real Iterable API — the account running
// it has no test credentials. Run it once by hand (workflow_dispatch) and
// inspect data/iterable-journeys.json closely before trusting it to run
// unattended on a schedule.

const API_BASE = 'https://api.iterable.com/api';
const API_KEY = process.env.ITERABLE_API_KEY;
const JOURNEY_IDS = (process.env.JOURNEY_IDS || '226142,277059,277060,277719,277720,283031,283032,283501,283503,285081,348886,348888,348889,361552,380903,395123,397134,420239,432250,432249,432248,432247,432241,432245,454374,491753,492899,492898,492896,498496,591526,574376,573754,573751,573762,574394,573711,574392,574378,573710,574380,658960,658958,576402,592260,639865,687714,687711,687710,687709,769755,890935,81281,286934,287009,287065,287070,287075,287084,287085,287097,361050,976148,976178')
  .split(',')
  .map(s => parseInt(s.trim(), 10))
  .filter(n => !Number.isNaN(n));

if (!API_KEY) {
  console.error('Missing ITERABLE_API_KEY environment variable.');
  process.exit(1);
}

async function iterableGet(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Api-Key': API_KEY },
  });
  if (!res.ok) {
    throw new Error(`Iterable API error ${res.status} on ${path}: ${await res.text()}`);
  }
  return res.json();
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
  // 1000 is the documented max page size; the Sandbox has ~700 campaigns
  // total as of this writing, so one page covers it. If that grows past
  // 1000, this needs real pagination added.
  const data = await iterableGet('/campaigns?pageSize=1000');
  return data.campaigns || [];
}

async function fetchTemplateContent(medium, templateId) {
  if (!templateId) return null;
  const pathByMedium = {
    Email: `/templates/email/get?templateId=${templateId}`,
    Push: `/templates/push/get?templateId=${templateId}`,
    InApp: `/templates/inapp/get?templateId=${templateId}`,
  };
  const path = pathByMedium[medium];
  if (!path) return null; // SMS and unknown mediums: no content lookup for now.
  try {
    const tpl = await iterableGet(path);
    return pickSafeTemplateContent(medium, tpl);
  } catch (err) {
    console.warn(`Could not fetch template ${templateId} (${medium}): ${err.message}`);
    return null;
  }
}

async function main() {
  console.log(`Pulling journeys: ${JOURNEY_IDS.join(', ')}`);

  const [allJourneys, allCampaigns] = await Promise.all([
    fetchAllJourneys(),
    fetchAllCampaigns(),
  ]);

  const results = [];

  for (const journeyId of JOURNEY_IDS) {
    const journey = allJourneys.find(j => j.id === journeyId);
    if (!journey) {
      console.warn(`Journey ${journeyId} not found — skipping.`);
      continue;
    }

    const matchingCampaigns = allCampaigns.filter(c => c.workflowId === journeyId);
    const campaignsWithContent = [];

    for (const c of matchingCampaigns) {
      const safeCampaign = pickSafeCampaign(c);
      const content = await fetchTemplateContent(safeCampaign.channel, safeCampaign.templateId);
      campaignsWithContent.push({ ...safeCampaign, content });
    }

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

  const output = {
    source: 'iterable-sandbox',
    pulledAt: new Date().toISOString(),
    journeys: results,
  };

  const fs = await import('fs');
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/iterable-journeys.json', JSON.stringify(output, null, 2));
  console.log(`Wrote data/iterable-journeys.json with ${results.length} journey(s).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
