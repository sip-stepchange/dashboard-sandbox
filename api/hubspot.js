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
  try { return JSON.parse(val); } catch (e) { return val; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let payload;
  try { payload = verifyClient(req); } catch (e) { return res.status(e.status).json({ error: e.message }); }

  const slug = payload.slug;
  const hubspotRaw = await kv.get('client:' + slug + ':hubspot');
  if (!hubspotRaw) return res.status(401).json({ error: 'HubSpot not connected', action: 'connect_hubspot' });

  const hubspot = safeGet(hubspotRaw);
  const accessToken = hubspot.accessToken;

  const { endpoint, method = 'GET', body } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  const allowed = ['/crm/', '/contacts/', '/deals/', '/marketing/', '/email/'];
  if (!allowed.some(p => endpoint.startsWith(p))) {
    return res.status(403).json({ error: 'Endpoint not permitted' });
  }

  try {
    const apiRes = await fetch('https://api.hubapi.com' + endpoint, {
      method,
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await apiRes.json();
    if (!apiRes.ok) return res.status(apiRes.status).json({ error: data.message || 'HubSpot error' });
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'HubSpot request failed' });
  }
};
