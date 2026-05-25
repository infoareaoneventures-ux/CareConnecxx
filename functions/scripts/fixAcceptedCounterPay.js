/**
 * One-time script: fix shiftHours docs where accept_counter stored only base pay.
 * Run with: node functions/scripts/fixAcceptedCounterPay.js
 * Uses the firebase-tools OAuth access token via Firestore REST API.
 */
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

const PROJECT = 'careconnex-d4c8b';
const BASE    = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

// ── Auth ────────────────────────────────────────────────────────────────────
function getAccessToken() {
  const cfgPath = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
  if (!fs.existsSync(cfgPath)) throw new Error('Firebase CLI not logged in');
  const t = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).tokens;
  if (!t || !t.access_token) throw new Error('No access token in firebase-tools config');
  return t.access_token;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function request(method, url, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const urlObj  = new URL(url);
    const opts    = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Firestore REST value helpers
function fsVal(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string')  return { stringValue: v };
  if (typeof v === 'number')  return { doubleValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (Array.isArray(v))       return { arrayValue: { values: v.map(fsVal) } };
  if (typeof v === 'object')  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, val]) => [k, fsVal(val)])) } };
  return { stringValue: String(v) };
}
function fromFsVal(v) {
  if (!v) return null;
  if ('nullValue'    in v) return null;
  if ('stringValue'  in v) return v.stringValue;
  if ('doubleValue'  in v) return v.doubleValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('arrayValue'   in v) return (v.arrayValue.values || []).map(fromFsVal);
  if ('mapValue'     in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, val]) => [k, fromFsVal(val)]));
  return null;
}
function docToObj(doc) {
  return Object.fromEntries(Object.entries(doc.fields || {}).map(([k, v]) => [k, fromFsVal(v)]));
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  const token = getAccessToken();

  // Structured query for status=approved, resolvedBy=client
  const queryUrl = `${BASE}:runQuery`;
  const query = {
    structuredQuery: {
      from: [{ collectionId: 'shiftHours' }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            { fieldFilter: { field: { fieldPath: 'status' },     op: 'EQUAL', value: { stringValue: 'approved' } } },
            { fieldFilter: { field: { fieldPath: 'resolvedBy' }, op: 'EQUAL', value: { stringValue: 'client'   } } },
          ],
        },
      },
    },
  };

  const qRes = await request('POST', queryUrl, token, query);
  if (qRes.status !== 200) { console.error('Query failed:', qRes.status, JSON.stringify(qRes.body).slice(0, 300)); process.exit(1); }

  const docs = (qRes.body || []).filter(r => r.document);
  console.log(`Found ${docs.length} client-accepted docs`);

  let fixed = 0, skipped = 0, errors = 0;

  for (const { document } of docs) {
    const docName = document.name; // full resource path
    const docId   = docName.split('/').pop();
    const s       = docToObj(document);

    if (!s.counterTotalHours) { skipped++; continue; }

    const safeLineItems  = Array.isArray(s.counterLineItems) ? s.counterLineItems : [];
    const lineItemsTotal = Math.round(safeLineItems.reduce((sum, li) => sum + (Number(li.amount) || 0), 0) * 100) / 100;
    const counterBasePay = Math.round(s.counterTotalHours * s.payRate * 100) / 100;
    const correctGross   = s.counterGrossPay ?? Math.round((counterBasePay + lineItemsTotal) * 100) / 100;

    // Skip if already correct and no line items to add
    if (Math.abs((s.grossPay ?? 0) - correctGross) < 0.02 && safeLineItems.length === 0) { skipped++; continue; }

    // Fix accepted entry in correctionHistory
    const history     = Array.isArray(s.correctionHistory) ? s.correctionHistory : [];
    const fixedHistory = history.map(e =>
      e.action !== 'accepted' ? e
        : { ...e, lineItems: safeLineItems, lineItemsTotal, basePay: counterBasePay, grossPay: correctGross }
    );

    const updateFields = {
      lineItems:         fsVal(safeLineItems),
      lineItemsTotal:    fsVal(lineItemsTotal),
      basePay:           fsVal(counterBasePay),
      grossPay:          fsVal(correctGross),
      correctionHistory: fsVal(fixedHistory),
      updatedAt:         fsVal(new Date().toISOString()),
    };
    const updateMask = Object.keys(updateFields).map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');
    const patchUrl   = `https://firestore.googleapis.com/v1/${docName}?${updateMask}`;

    const pRes = await request('PATCH', patchUrl, token, { fields: updateFields });
    if (pRes.status >= 200 && pRes.status < 300) {
      console.log(`  ✓ ${docId}  $${(s.grossPay ?? 0).toFixed(2)} → $${correctGross.toFixed(2)}`);
      fixed++;
    } else {
      console.error(`  ✗ ${docId}: ${pRes.status} ${JSON.stringify(pRes.body).slice(0,200)}`);
      errors++;
    }
  }

  console.log(`\nDone — fixed: ${fixed}, skipped: ${skipped}, errors: ${errors}`);
  process.exit(errors > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
