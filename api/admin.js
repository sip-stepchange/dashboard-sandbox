const { Redis } = require('@upstash/redis');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

function signAdminToken() {
  return jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '24h' });
}

function verifyAdmin(req) {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!token) throw { status: 401, message: 'No token provided' };
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== 'admin') throw { status: 403, message: 'Forbidden' };
    return payload;
  } catch (e) { if (e.status) throw e; throw { status: 401, message: 'Invalid or expired token' }; }
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 30);
}

// Helper: Upstash returns objects directly, no JSON.parse needed
function safeGet(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return val; }
}

module.exports = async function handler(req, res) {
  const action = req.query.action;
  try {

    // ── LOGIN ──
    if (action === 'login') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { password } = req.body;
      if (!password) return res.status(400).json({ error: 'Password required' });
      if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
      return res.status(200).json({ token: signAdminToken() });
    }

    // ── CREATE CLIENT ──
    if (action === 'create-client') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      try { verifyAdmin(req); } catch (e) { return res.status(e.status).json({ error: e.message }); }
      const { name, slug: rawSlug, password } = req.body;
      if (!name || !rawSlug || !password) return res.status(400).json({ error: 'name, slug, and password are required' });
      const slug = slugify(rawSlug);
      const reserved = ['admin', 'api', 'auth', 'setup', 'login', 'logout', 'static', '_next'];
      if (reserved.includes(slug)) return res.status(400).json({ error: `"${slug}" is reserved` });
      const existing = await kv.get(`client:${slug}:config`);
      if (existing) return res.status(409).json({ error: `Slug "${slug}" already exists` });
      const passwordHash = await bcrypt.hash(password, 10);
      const config = { name, slug, passwordHash, createdAt: new Date().toISOString() };
      // Store as object — Upstash handles serialization
      await kv.set(`client:${slug}:config`, config);
      const rawIndex = await kv.get('clients:index');
      const slugList = Array.isArray(rawIndex) ? rawIndex : (rawIndex ? safeGet(rawIndex) : []);
      const list = Array.isArray(slugList) ? slugList : [];
      if (!list.includes(slug)) { list.push(slug); await kv.set('clients:index', list); }
      return res.status(200).json({ success: true, slug, name, url: `${process.env.APP_URL}/${slug}` });
    }

    // ── LIST CLIENTS ──
    if (action === 'list-clients') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      try { verifyAdmin(req); } catch (e) { return res.status(e.status).json({ error: e.message }); }
      const rawIndex = await kv.get('clients:index');
      const slugList = Array.isArray(rawIndex) ? rawIndex : (rawIndex ? safeGet(rawIndex) : []);
      const list = Array.isArray(slugList) ? slugList : [];
      if (list.length === 0) return res.status(200).json({ clients: [] });
      const clients = await Promise.all(list.map(async (slug) => {
        const [config, anthropic, hubspot, activecampaign, ga4] = await Promise.all([
          kv.get(`client:${slug}:config`),
          kv.get(`client:${slug}:anthropic`),
          kv.get(`client:${slug}:hubspot`),
          kv.get(`client:${slug}:activecampaign`),
          kv.get(`client:${slug}:ga4`),
        ]);
        if (!config) return null;
        const c = safeGet(config);
        return { name: c.name, slug: c.slug, createdAt: c.createdAt, hasAnthropic: !!anthropic, hasHubspot: !!hubspot, hasActiveCampaign: !!activecampaign, hasGa4: !!ga4 };
      }));
      return res.status(200).json({ clients: clients.filter(Boolean).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
    }

    // ── DELETE CLIENT ──
    if (action === 'delete-client') {
      if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
      try { verifyAdmin(req); } catch (e) { return res.status(e.status).json({ error: e.message }); }
      const { slug } = req.query;
      if (!slug) return res.status(400).json({ error: 'slug required' });
      await Promise.all([kv.del(`client:${slug}:config`), kv.del(`client:${slug}:anthropic`), kv.del(`client:${slug}:hubspot`), kv.del(`client:${slug}:activecampaign`), kv.del(`client:${slug}:ga4`)]);
      const rawIndex = await kv.get('clients:index');
      const list = Array.isArray(rawIndex) ? rawIndex : safeGet(rawIndex) || [];
      await kv.set('clients:index', list.filter(s => s !== slug));
      return res.status(200).json({ success: true });
    }

    return res.status(404).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('Admin handler error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
