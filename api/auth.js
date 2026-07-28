const { Redis } = require('@upstash/redis');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

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
  if (val === null || val === undefined) return null;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch (e) { return val; }
}

function redirectWithStatus(res, slug, service, status, detail) {
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  const params = new URLSearchParams({ connected: service, status });
  if (detail) params.set('detail', detail);
  return res.redirect(base + '/' + slug + '/setup?' + params.toString());
}

module.exports = async function handler(req, res) {
  const action = req.query.action;
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  try {

    if (action === 'client-login') {
      const { slug, password } = req.body;
      if (!slug || !password) return res.status(400).json({ error: 'slug and password required' });
      const raw = await kv.get('client:' + slug + ':config');
      if (!raw) return res.status(401).json({ error: 'Invalid credentials' });
      const config = safeGet(raw);
      const valid = await bcrypt.compare(password, config.passwordHash);
      if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
      const token = jwt.sign({ role: 'client', slug, name: config.name }, process.env.JWT_SECRET, { expiresIn: '7d' });
      return res.status(200).json({ token, name: config.name, slug });
    }

    if (action === 'status') {
      let payload;
      try { payload = verifyClient(req); } catch (e) { return res.status(e.status).json({ error: e.message }); }
      const slug = payload.slug;
      const anthropic = await kv.get('client:' + slug + ':anthropic');
      const hubspot = await kv.get('client:' + slug + ':hubspot');
      const activecampaign = await kv.get('client:' + slug + ':activecampaign');
      const ga4Raw = await kv.get('client:' + slug + ':ga4');
      const ga4 = ga4Raw ? safeGet(ga4Raw) : null;
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      return res.status(200).json({
        anthropic: { connected: !!anthropic },
        hubspot: { connected: !!hubspot },
        activecampaign: (() => {
          const creds = activecampaign ? safeGet(activecampaign) : null;
          const appUrl = creds?.apiUrl
            ? creds.apiUrl.replace(/\.api-[a-z0-9]+\.com.*$/, '.activehosted.com').replace(/\/+$/, '')
            : null;
          return { connected: !!activecampaign, appUrl };
        })(),
        ga4: { connected: !!ga4Raw, propertySet: !!(ga4 && ga4.propertyId), availableProperties: (ga4 && ga4.availableProperties) || [], propertyId: (ga4 && ga4.propertyId) || null },
      });
    }

    if (action === 'load-prefs') {
      let payload;
      try { payload = verifyClient(req); } catch (e) { return res.status(e.status).json({ error: e.message }); }
      const raw = await kv.get('client:' + payload.slug + ':prefs');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      return res.status(200).json(safeGet(raw) || {});
    }

    if (action === 'save-prefs') {
      let payload;
      try { payload = verifyClient(req); } catch (e) { return res.status(e.status).json({ error: e.message }); }
      const prefs = req.body;
      if (!prefs || typeof prefs !== 'object') return res.status(400).json({ error: 'Invalid prefs' });
      await kv.set('client:' + payload.slug + ':prefs', prefs);
      return res.status(200).json({ success: true });
    }

    if (action === 'save-anthropic-key') {
      let payload;
      try { payload = verifyClient(req); } catch (e) { return res.status(e.status).json({ error: e.message }); }
      const { apiKey } = req.body;
      if (!apiKey || !apiKey.startsWith('sk-ant-')) return res.status(400).json({ error: 'Invalid Anthropic API key format' });
      await kv.set('client:' + payload.slug + ':anthropic', { apiKey });
      return res.status(200).json({ success: true });
    }

    if (action === 'save-hubspot-token') {
      let payload;
      try { payload = verifyClient(req); } catch (e) { return res.status(e.status).json({ error: e.message }); }
      const { token } = req.body;
      if (!token) return res.status(400).json({ error: 'Token is required' });
      const existingAc = await kv.get('client:' + payload.slug + ':activecampaign');
      if (existingAc) return res.status(409).json({ error: 'ActiveCampaign is already connected. Disconnect it first to switch CRMs.' });
      try {
        const testRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts?limit=1', {
          headers: { Authorization: 'Bearer ' + token }
        });
        if (testRes.status === 401) return res.status(400).json({ error: 'Invalid HubSpot token — please check and try again' });
      } catch (e) { console.warn('Could not validate HubSpot token:', e.message); }
      await kv.set('client:' + payload.slug + ':hubspot', { accessToken: token, type: 'private_app' });
      return res.status(200).json({ success: true });
    }

    if (action === 'save-activecampaign-token') {
      let payload;
      try { payload = verifyClient(req); } catch (e) { return res.status(e.status).json({ error: e.message }); }
      const { apiUrl, apiKey } = req.body || {};
      if (!apiUrl || !apiKey) return res.status(400).json({ error: 'API URL and API key are required' });
      const existingHs = await kv.get('client:' + payload.slug + ':hubspot');
      if (existingHs) return res.status(409).json({ error: 'HubSpot is already connected. Disconnect it first to switch CRMs.' });
      let cleanUrl = String(apiUrl).trim().replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(cleanUrl)) cleanUrl = 'https://' + cleanUrl;
      try {
        const testRes = await fetch(cleanUrl + '/api/3/users/me', {
          headers: { 'Api-Token': apiKey }
        });
        if (testRes.status === 401 || testRes.status === 403) {
          return res.status(400).json({ error: 'Invalid ActiveCampaign credentials — please check the URL and API key' });
        }
        if (!testRes.ok) {
          return res.status(400).json({ error: 'Could not reach ActiveCampaign (HTTP ' + testRes.status + ')' });
        }
      } catch (e) {
        console.warn('Could not validate ActiveCampaign credentials:', e.message);
        return res.status(400).json({ error: 'Could not connect to ActiveCampaign at that URL' });
      }
      await kv.set('client:' + payload.slug + ':activecampaign', { apiUrl: cleanUrl, apiKey });
      return res.status(200).json({ success: true });
    }

    if (action === 'disconnect-crm') {
      let payload;
      try { payload = verifyClient(req); } catch (e) { return res.status(e.status).json({ error: e.message }); }
      const { which } = req.body || {};
      if (which !== 'hubspot' && which !== 'activecampaign') return res.status(400).json({ error: 'which must be hubspot or activecampaign' });
      await kv.del('client:' + payload.slug + ':' + which);
      return res.status(200).json({ success: true });
    }

    if (action === 'set-ga4-property') {
      let payload;
      try { payload = verifyClient(req); } catch (e) { return res.status(e.status).json({ error: e.message }); }
      const { propertyId } = req.body;
      if (!propertyId) return res.status(400).json({ error: 'propertyId required' });
      const ga4Raw = await kv.get('client:' + payload.slug + ':ga4');
      if (!ga4Raw) return res.status(404).json({ error: 'GA4 not connected' });
      const ga4 = safeGet(ga4Raw);
      ga4.propertyId = String(propertyId).replace('properties/', '');
      await kv.set('client:' + payload.slug + ':ga4', ga4);
      return res.status(200).json({ success: true, propertyId: ga4.propertyId });
    }

    if (action === 'google-start') {
      const { slug } = req.query;
      if (!slug) return res.status(400).send('Missing slug');
      const params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: base + '/api/auth?action=google-callback',
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/analytics.readonly',
        access_type: 'offline', prompt: 'consent', state: slug
      });
      return res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
    }

    if (action === 'google-callback') {
      const { code, state: slug, error } = req.query;
      if (error) return redirectWithStatus(res, slug, 'ga4', 'error', error);
      if (!code || !slug) return res.status(400).send('Missing code or state');
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: base + '/api/auth?action=google-callback', grant_type: 'authorization_code' })
      });
      const tokens = await tokenRes.json();
      if (!tokenRes.ok || tokens.error) return redirectWithStatus(res, slug, 'ga4', 'error', 'token_exchange_failed');
      if (!tokens.refresh_token) return redirectWithStatus(res, slug, 'ga4', 'error', 'no_refresh_token');
      let propertyId = null, availableProperties = [];
      try {
        const propRes = await fetch('https://analyticsadmin.googleapis.com/v1beta/properties?filter=parent:accounts/-&pageSize=200', { headers: { Authorization: 'Bearer ' + tokens.access_token } });
        const propData = await propRes.json();
        const properties = propData.properties || [];
        if (properties.length === 1) propertyId = properties[0].name.replace('properties/', '');
        availableProperties = properties.map(function(p) { return { id: p.name.replace('properties/', ''), displayName: p.displayName }; });
      } catch (e) { console.warn('Property discovery failed:', e.message); }
      await kv.set('client:' + slug + ':ga4', { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000, propertyId: propertyId, availableProperties: availableProperties });
      return redirectWithStatus(res, slug, 'ga4', 'success');
    }

    return res.status(404).json({ error: 'Unknown action: ' + action });
  } catch (err) {
    console.error('Auth handler error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
