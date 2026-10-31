'use strict';
// Wow Inflatables public MCP server — READ-ONLY, DRAFT. Zero dependencies, zero outbound network calls.
// Serves only owner-approved mcp/public-content.json. No reservations, payments, Square, or customer data.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BOOK_URL = 'https://www.wowinflatables.biz/book';
const AVAIL_TEXT = 'Check dates and book at https://www.wowinflatables.biz/book';
const LATEST = '2026-07-28';
const LEGACY = ['2025-11-25', '2025-06-18'];
const SUPPORTED = [LATEST, ...LEGACY];
const SERVER_INFO = { name: 'wowinflatables-info', title: 'Wow Inflatables (public info)', version: '0.1.0', websiteUrl: 'https://www.wowinflatables.biz' };
const ALLOWED_ORIGINS = new Set(); // none initially
const CATS = ['bounce', 'combo', 'water slide', 'obstacle', 'other'];
const ENV_ALLOWLIST = ['MCP_ENABLED', 'MCP_TOOLS_DISABLED', 'PORT', 'NODE_ENV', 'PATH', 'HOME', 'TZ'];

const CONTENT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mcp', 'public-content.json'), 'utf8'));

function clean(s, cap) {
  return String(s).replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, cap);
}
function withBook(o) { return { ...o, book_url: BOOK_URL }; }
const unitSummary = (u) => {
  const o = { id: u.id, name: clean(u.name, 120), category: u.category, page_url: u.page_url };
  if (u.published_price) o.published_price = u.published_price;
  return o;
};
const unitFull = (u) => {
  const o = unitSummary(u);
  o.description = clean(u.description, 500);
  if (u.dimensions) o.dimensions = clean(u.dimensions, 120);
  if (u.image_url) o.image_url = u.image_url;
  o.availability = AVAIL_TEXT;
  return o;
};
const SAFE = /^[A-Za-z0-9 .,'&-]+$/;
class InvalidParams extends Error {}
function args(a, allowed) {
  a = a || {};
  if (typeof a !== 'object' || Array.isArray(a)) throw new InvalidParams('arguments must be an object');
  for (const k of Object.keys(a)) if (!allowed.includes(k)) throw new InvalidParams('unknown argument');
  return a;
}
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const TOOLS = {
  get_business_info: {
    description: 'Public business info for Wow Inflatables (name, website, fleet size, service area headline, booking link).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(a) { args(a, []); const b = CONTENT.business;
      const o = { name: b.name, website: b.website, fleet: b.fleet, service_area_headline: CONTENT.service_area.headline, as_of: b.as_of };
      if (b.public_phone) o.public_phone = b.public_phone;
      return withBook(o); },
  },
  list_units: {
    description: 'List published rental units with category, page link, and published base daily price when printed on the site.',
    inputSchema: { type: 'object', properties: { category: { type: 'string', enum: CATS }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false },
    run(a) { a = args(a, ['category', 'limit']);
      if (a.category !== undefined && !CATS.includes(a.category)) throw new InvalidParams('bad category');
      const lim = a.limit === undefined ? 50 : a.limit;
      if (!Number.isInteger(lim) || lim < 1 || lim > 50) throw new InvalidParams('bad limit');
      const units = CONTENT.units.filter((u) => !a.category || u.category === a.category).slice(0, lim).map(unitSummary);
      return withBook({ units, availability: AVAIL_TEXT }); },
  },
  get_unit: {
    description: 'Get one published rental unit by its id (slug).',
    inputSchema: { type: 'object', properties: { id: { type: 'string', pattern: '^[a-z0-9-]{1,60}$' } }, required: ['id'], additionalProperties: false },
    run(a) { a = args(a, ['id']);
      if (typeof a.id !== 'string' || !/^[a-z0-9-]{1,60}$/.test(a.id)) throw new InvalidParams('bad id');
      const u = CONTENT.units.find((x) => x.id === a.id);
      if (!u) return withBook({ found: false, message: 'Unit not found. See https://www.wowinflatables.biz/rentals or ' + AVAIL_TEXT });
      return withBook(unitFull(u)); },
  },
  get_service_area: {
    description: 'Published service area. Optionally pass a city to see whether it is a listed service city.',
    inputSchema: { type: 'object', properties: { city: { type: 'string', maxLength: 60 } }, additionalProperties: false },
    run(a) { a = args(a, ['city']); const sa = CONTENT.service_area;
      const full = { headline: sa.headline, home_base: sa.home_base, cities: sa.cities, counties: sa.counties, notes: sa.notes };
      if (a.city === undefined) return withBook(full);
      if (typeof a.city !== 'string' || a.city.length > 60 || !SAFE.test(a.city)) throw new InvalidParams('bad city');
      const norm = (s) => s.toLowerCase().replace(/,?\s*(ga|georgia)$/, '').trim();
      const hit = sa.cities.some((c) => norm(c) === norm(a.city));
      return withBook(hit ? { served: true, city: sa.cities.find((c) => norm(c) === norm(a.city)), notes: sa.notes }
        : { served: 'ask', message: 'Not on our published list. Contact us or enter your full event address at https://www.wowinflatables.biz/book to confirm coverage.' }); },
  },
  search_faq: {
    description: 'Keyword search over the published Wow Inflatables FAQ. Returns up to 5 answers word-for-word.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 100 } }, required: ['query'], additionalProperties: false },
    run(a) { a = args(a, ['query']);
      if (typeof a.query !== 'string' || a.query.length < 1 || a.query.length > 100) throw new InvalidParams('bad query');
      const words = a.query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
      const results = CONTENT.faq.map((f) => {
        const hay = (f.question + ' ' + f.answer).toLowerCase();
        return { f, score: words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0) };
      }).filter((r) => r.score > 0).sort((x, y) => y.score - x.score).slice(0, 5)
        .map(({ f }) => ({ question: clean(f.question, 300), answer: clean(f.answer, 1000), page_url: f.page_url }));
      return withBook({ results }); },
  },
  get_booking_link: {
    description: 'The only Wow Inflatables booking link.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(a) { args(a, []); return { url: BOOK_URL }; },
  },
};

function disabledTools() { return new Set((process.env.MCP_TOOLS_DISABLED || '').split(',').map((s) => s.trim()).filter(Boolean)); }
function toolList() {
  const off = disabledTools();
  return Object.entries(TOOLS).filter(([n]) => !off.has(n)).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema, annotations: RO }));
}
function callTool(name, a) {
  const t = TOOLS[name];
  if (!t || disabledTools().has(name)) throw new InvalidParams('unknown tool');
  const out = t.run(a);
  return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out, isError: false };
}
function resources() { return [{ uri: 'wow://public-content', name: 'public-content', mimeType: 'application/json', description: 'Owner-approved public content' }]; }

function handle(msg, version) {
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: '2.0', id, result: version === LATEST ? { resultType: 'complete', ...result } : result });
  const err = (code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });
  try {
    switch (method) {
      case 'server/discover':
        return ok({ supportedVersions: SUPPORTED, serverInfo: SERVER_INFO, capabilities: { tools: {}, resources: {} }, instructions: 'Read-only public info. Book only at ' + BOOK_URL });
      case 'initialize': {
        const v = LEGACY.includes(params?.protocolVersion) ? params.protocolVersion : LEGACY[0];
        return ok({ protocolVersion: v, serverInfo: SERVER_INFO, capabilities: { tools: {}, resources: {} }, instructions: 'Read-only public info. Book only at ' + BOOK_URL });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: toolList() });
      case 'tools/call': return ok(callTool(params?.name, params?.arguments));
      case 'resources/list': return ok({ resources: resources() });
      case 'resources/read':
        if (params?.uri !== 'wow://public-content') throw new InvalidParams('unknown resource');
        return ok({ contents: [{ uri: 'wow://public-content', mimeType: 'application/json', text: JSON.stringify({ business: TOOLS.get_business_info.run({}), service_area: TOOLS.get_service_area.run({}), units: CONTENT.units.map(unitFull) }) }] });
      case 'prompts/list': return ok({ prompts: [] });
      default: return err(-32601, 'Method not found');
    }
  } catch (e) {
    if (e instanceof InvalidParams) return err(-32602, 'Invalid params');
    return err(-32603, 'Internal error');
  }
}

// rate limit: 30/min per hashed IP, 300/min global
const SALT = crypto.randomBytes(16).toString('hex');
function makeLimiter() { const hits = new Map(); let globalHits = []; return function limited(ip) {
  const now = Date.now(); const k = crypto.createHash('sha256').update(SALT + ip).digest('hex').slice(0, 16);
  const arr = (hits.get(k) || []).filter((t) => now - t < 60000); globalHits = globalHits.filter((t) => now - t < 60000);
  if (arr.length >= 30 || globalHits.length >= 300) { hits.set(k, arr); return true; }
  arr.push(now); hits.set(k, arr); globalHits.push(now); return false;
}; }
function log(o) { process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n'); } // never args/IP/headers

function send(res, status, body, extra) {
  const h = { 'Cache-Control': 'no-store', ...extra };
  if (body === undefined) { res.writeHead(status, h); return res.end(); }
  const s = JSON.stringify(body);
  if (Buffer.byteLength(s) > 65536) return send(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Response too large' } });
  res.writeHead(status, { 'Content-Type': 'application/json', ...h }); res.end(s);
}

function selfOrigin(req) {
  const xf = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = xf === 'http' || xf === 'https' ? xf : 'https';
  const host = String(req.headers.host || '').trim();
  if (!/^[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(host)) return 'https://wow-inflatables-mcp.onrender.com';
  return proto + '://' + host;
}

function createServer() {
  const limited = makeLimiter();
  return http.createServer((req, res) => {
    const t0 = Date.now(); const url = req.url.split('?')[0];
    const enabled = process.env.MCP_ENABLED === 'true';
    if (url === '/.well-known/mcp.json') {
      if (!enabled) return send(res, 404);
      return send(res, 200, { name: SERVER_INFO.name, url: selfOrigin(req) + '/mcp', transport: 'streamable-http', readOnly: true });
    }
    if (url !== '/mcp') return send(res, 404);
    if (!enabled) return send(res, 503);
    const origin = req.headers.origin;
    if (origin !== undefined && !ALLOWED_ORIGINS.has(origin)) return send(res, 403);
    if (req.method === 'OPTIONS') return send(res, 204, undefined, { Allow: 'POST, OPTIONS' });
    if (req.method !== 'POST') return send(res, 405, undefined, { Allow: 'POST, OPTIONS' });
    if (limited(req.socket.remoteAddress || '')) return send(res, 429, undefined, { 'Retry-After': '60' });
    let size = 0; const chunks = []; let aborted = false;
    req.setTimeout(5000, () => { aborted = true; send(res, 408); req.destroy(); });
    req.on('data', (c) => { size += c.length; if (size > 8192 && !aborted) { aborted = true; send(res, 413); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (aborted) return;
      let msg; try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      const hdr = req.headers['mcp-protocol-version'];
      const metaV = msg.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
      let version;
      if (msg.method === 'initialize') version = msg.params?.protocolVersion;
      else version = hdr || metaV || (msg.method === 'server/discover' ? LATEST : LEGACY[0]);
      if (hdr && metaV && hdr !== metaV) return send(res, 400, { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32600, message: 'HeaderMismatch' } });
      if (hdr && !SUPPORTED.includes(hdr)) return send(res, 400, { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32600, message: 'UnsupportedProtocolVersionError', data: { supported: SUPPORTED } } });
      if (msg.id === undefined) { send(res, 202); return log({ method: msg.method, status: 202, ms: Date.now() - t0 }); } // notification
      const out = handle(msg, version);
      send(res, 200, out);
      log({ method: msg.method, tool: msg.method === 'tools/call' ? (TOOLS[msg.params?.name] ? msg.params.name : 'unknown') : undefined, status: out.error ? out.error.code : 200, ms: Date.now() - t0 });
    });
  });
}

module.exports = { createServer, handle, TOOLS, BOOK_URL, ENV_ALLOWLIST, CONTENT };
if (require.main === module) {
  const port = Number(process.env.PORT) || 8787;
  createServer().listen(port, '0.0.0.0', () => log({ msg: 'listening', port, enabled: process.env.MCP_ENABLED === 'true' }));
}
