const { Redis } = require('@upstash/redis');
const jwt = require('jsonwebtoken');

const kv = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

function verifyClient(req) {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!token) throw { status: 401, message: 'No token' };
  try {
    const p = jwt.verify(token, process.env.JWT_SECRET);
    if (p.role !== 'client') throw { status: 403, message: 'Forbidden' };
    return p;
  } catch (e) { if (e.status) throw e; throw { status: 401, message: 'Invalid token' }; }
}

function safeGet(val) {
  if (!val) return null;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return val; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let payload;
  try { payload = verifyClient(req); } catch (e) { return res.status(e.status).json({ error: e.message }); }
  const slug = payload.slug;
  const ga4Raw = await kv.get(`client:${slug}:ga4`);
  if (!ga4Raw) return res.status(401).json({ error: 'GA4 not connected', action: 'connect_ga4' });
  let ga4 = safeGet(ga4Raw);
  if (!ga4.propertyId) return res.status(400).json({ error: 'GA4 property not selected', action: 'select_property', availableProperties: ga4.availableProperties || [] });
  if (Date.now() > ga4.expiresAt - 60000) {
    try {
      const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: ga4.refreshToken, grant_type: 'refresh_token' }) });
      const tokens = await r.json();
      if (r.ok && !tokens.error) { ga4 = { ...ga4, accessToken: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 }; await kv.set(`client:${slug}:ga4`, ga4); }
      else return res.status(401).json({ error: 'GA4 token refresh failed', action: 'connect_ga4' });
    } catch { return res.status(401).json({ error: 'GA4 token refresh failed', action: 'connect_ga4' }); }
  }
  const { endpoint, body } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  const apiRes = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${ga4.propertyId}${endpoint}`, { method: 'POST', headers: { Authorization: `Bearer ${ga4.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await apiRes.json();
  if (!apiRes.ok) return res.status(apiRes.status).json({ error: (data.error && data.error.message) || 'GA4 error' });
  return res.status(200).json(data);
};
