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
  const anthropicRaw = await kv.get(`client:${payload.slug}:anthropic`);
  if (!anthropicRaw) return res.status(401).json({ error: 'Anthropic key not configured', action: 'setup_anthropic' });
  const { apiKey } = safeGet(anthropicRaw);
  const { messages, system, model, max_tokens } = req.body;
  if (!messages) return res.status(400).json({ error: 'messages required' });
  const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: model || 'claude-sonnet-4-20250514', max_tokens: max_tokens || 1024, system, messages }),
  });
  const data = await apiRes.json();
  if (!apiRes.ok) {
    if (apiRes.status === 401) return res.status(401).json({ error: 'Anthropic key invalid', action: 'setup_anthropic' });
    return res.status(apiRes.status).json({ error: (data.error && data.error.message) || 'Anthropic error' });
  }
  return res.status(200).json(data);
};
