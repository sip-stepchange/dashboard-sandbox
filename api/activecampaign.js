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

const ALLOWED = [
  '/api/3/users/me',
  '/api/3/contacts',
  '/api/3/deals',
  '/api/3/dealStages',
  '/api/3/campaigns',
  '/api/3/lists',
  '/api/3/tags',
  '/api/3/contactTags',
  '/api/3/contactLists',
  '/api/3/contactCustomFields',
  '/api/3/activities',
  '/api/3/fields',
];

const ALLOWED_V1_ACTIONS = [
  'campaign_report_open_list',
  'campaign_report_link_list',
  'campaign_report_bounce_list',
  'campaign_report_unsubscription_list',
];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let payload;
  try { payload = verifyClient(req); } catch (e) { return res.status(e.status).json({ error: e.message }); }

  const slug = payload.slug;
  const acRaw = await kv.get('client:' + slug + ':activecampaign');
  if (!acRaw) return res.status(401).json({ error: 'ActiveCampaign not connected', action: 'connect_activecampaign' });

  const ac = safeGet(acRaw);
  const apiUrl = ac && ac.apiUrl;
  const apiKey = ac && ac.apiKey;
  if (!apiUrl || !apiKey) return res.status(500).json({ error: 'ActiveCampaign credentials malformed' });

  const { endpoint, method = 'GET', body, v1action, v1params = {} } = req.body || {};
  const base = apiUrl.replace(/\/+$/, '');

  // V1 API path — used for campaign report contact lists
  if (v1action) {
    if (!ALLOWED_V1_ACTIONS.includes(v1action)) {
      return res.status(403).json({ error: 'V1 action not permitted' });
    }
    try {
      const qs = new URLSearchParams({ api_action: v1action, api_key: apiKey, api_output: 'json', ...v1params });
      const v1Res = await fetch(`${base}/admin/api.php?${qs}`);
      const text  = await v1Res.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
      if (!v1Res.ok) {
        return res.status(v1Res.status).json({ error: 'ActiveCampaign v1 error', detail: data });
      }
      return res.status(200).json(data);
    } catch (err) {
      console.error('ActiveCampaign v1 request failed:', err && err.message);
      return res.status(500).json({ error: 'ActiveCampaign v1 request failed' });
    }
  }

  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });

  const path = endpoint.split('?')[0];
  if (!ALLOWED.some(p => path === p || path.startsWith(p + '/'))) {
    return res.status(403).json({ error: 'Endpoint not permitted' });
  }

  try {
    const apiRes = await fetch(base + endpoint, {
      method,
      headers: { 'Api-Token': apiKey, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await apiRes.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
    if (!apiRes.ok) {
      const msg = data.message || (data.errors && data.errors[0] && data.errors[0].title) || 'ActiveCampaign error';
      return res.status(apiRes.status).json({ error: msg, detail: data });
    }
    return res.status(200).json(data);
  } catch (err) {
    console.error('ActiveCampaign request failed:', err && err.message);
    return res.status(500).json({ error: 'ActiveCampaign request failed' });
  }
};
