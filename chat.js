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

// Place ephemeral cache_control markers on:
//   1. the last tool definition (caches the full tools block)
//   2. the system text block (caches tools + system together)
//   3. the last content block of the last message (caches accumulated history)
// Each iteration's new end becomes the next iteration's read point; iter 2+
// reads ~80% of input from cache at ~0.1x price instead of full price.
function withPromptCaching({ model, max_tokens, system, messages, tools }) {
  const body = { model, max_tokens };

  if (tools && tools.length > 0) {
    body.tools = tools.map((t, i) =>
      i === tools.length - 1
        ? { ...t, cache_control: { type: 'ephemeral' } }
        : t
    );
  }

  if (system) {
    body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  }

  body.messages = messages.map((msg, i) => {
    if (i !== messages.length - 1) return msg;
    let content = msg.content;
    if (typeof content === 'string') {
      content = [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }];
    } else if (Array.isArray(content) && content.length > 0) {
      content = content.map((b, j) =>
        j === content.length - 1
          ? { ...b, cache_control: { type: 'ephemeral' } }
          : b
      );
    }
    return { ...msg, content };
  });

  return body;
}

const TOOLS = [
  {
    name: 'query_activecampaign',
    description: 'Query live ActiveCampaign data: email campaigns, contacts, lists, engagement statistics. Use when the user asks about email marketing performance, contact lists, open rates, click rates, or campaign comparisons.',
    input_schema: {
      type: 'object',
      properties: {
        endpoint: {
          type: 'string',
          description: 'ActiveCampaign API v3 path. Examples:\n- Recent campaigns: "/api/3/campaigns?orders[sdate]=DESC&limit=20"\n- Campaign detail with stats: "/api/3/campaigns/{id}"\n- All lists: "/api/3/lists?limit=50"\n- Contacts by score: "/api/3/contacts?orders[score]=DESC&limit=20"\n- Contact detail: "/api/3/contacts/{id}"\n\nKey stats fields on campaign objects: send_amt, uniqueopens, uniquelinkclicks, unsubscribes, hardbounces, softbounces.\nCompute rates client-side: open rate = uniqueopens/send_amt, click rate = uniquelinkclicks/send_amt.\nStatus codes: 5=sent, 1=scheduled, 0=draft, 6=archived.'
        }
      },
      required: ['endpoint']
    }
  },
  {
    name: 'query_hubspot',
    description: 'Query live HubSpot data: contacts, deals, email campaign statistics, marketing performance. Use this whenever the user asks about CRM data, email metrics, deal pipeline, leads, or anything that could come from HubSpot.',
    input_schema: {
      type: 'object',
      properties: {
        endpoint: {
          type: 'string',
          description: 'HubSpot API path starting with /crm/, /contacts/, /deals/, /marketing/, or /email/.\n\nWorking endpoints:\n- Contacts: "/crm/v3/objects/contacts?limit=10&properties=email,firstname,lastname,hs_lead_status,lifecyclestage"\n- Deals: "/crm/v3/objects/deals?limit=10&properties=dealname,amount,closedate,dealstage,hubspot_owner_id"\n- Email list (with campaign IDs): "/marketing/emails/2026-03?limit=10&isPublished=true&orderBy=-publishDate" — each result has a primaryEmailCampaignId field, plus name, subject, publishDate, type.\n- Email performance stats (per campaign): "/email/public/v1/campaigns/{primaryEmailCampaignId}" — returns counters.sent, counters.open, counters.click, counters.delivered.\n\nTo answer questions about email open/click/CTR performance: first list emails via /marketing/emails/2026-03, then call /email/public/v1/campaigns/{id} for the 3-5 most relevant emails. Do not loop over more than ~5 emails — each lookup is a separate tool call and the loop is capped.\n\nDo NOT use: /marketing/v3/emails/statistics, /marketing/v3/emails/statistics/list, /marketing/v3/campaigns/*/asset-metrics. These return 4xx/5xx errors with our scopes — stats live on the v1 campaign object only.'
        },
        method: { type: 'string', enum: ['GET', 'POST'], default: 'GET' },
        body: { type: 'object', description: 'Request body for POST requests only' }
      },
      required: ['endpoint']
    }
  },
  {
    name: 'query_ga4',
    description: 'Query live Google Analytics 4 data: sessions, users, traffic sources, page performance, conversions. Use this whenever the user asks about website traffic, channel performance, bounce rates, or anything analytics-related.',
    input_schema: {
      type: 'object',
      properties: {
        dimensions: {
          type: 'array',
          items: { type: 'string' },
          description: 'GA4 dimension names. Common: sessionSource, sessionMedium, sessionSourceMedium, deviceCategory, pagePath, country, city, eventName, landingPage'
        },
        metrics: {
          type: 'array',
          items: { type: 'string' },
          description: 'GA4 metric names. Common: sessions, totalUsers, newUsers, bounceRate, averageSessionDuration, screenPageViews, conversions, eventCount, engagedSessions, engagementRate'
        },
        dateRanges: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              startDate: { type: 'string', description: 'YYYY-MM-DD, today, yesterday, or NdaysAgo (e.g. 30daysAgo)' },
              endDate: { type: 'string', description: 'YYYY-MM-DD, today, yesterday, or NdaysAgo' }
            },
            required: ['startDate', 'endDate']
          },
          description: 'Date ranges. Defaults to last 30 days if omitted.'
        },
        limit: {
          type: 'integer',
          description: 'Max rows (default 10, max 50)'
        }
      },
      required: ['metrics']
    }
  }
];

async function callActiveCampaign(ac, input) {
  const ALLOWED = ['/api/3/contacts','/api/3/campaigns','/api/3/lists','/api/3/tags','/api/3/contactTags','/api/3/contactLists'];
  const path = (input.endpoint || '').split('?')[0];
  if (!ALLOWED.some(p => path === p || path.startsWith(p + '/'))) {
    return { error: 'Endpoint not permitted' };
  }
  try {
    const base = ac.apiUrl.replace(/\/+$/, '');
    const res = await fetch(base + input.endpoint, {
      headers: { 'Api-Token': ac.apiKey, 'Content-Type': 'application/json' }
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { raw: text.slice(0, 2000) }; }
  } catch (e) {
    return { error: 'ActiveCampaign request failed: ' + e.message };
  }
}

async function callHubspot(accessToken, input) {
  const { endpoint, method = 'GET', body } = input;
  const allowed = ['/crm/', '/contacts/', '/deals/', '/marketing/', '/email/'];
  if (!allowed.some(p => endpoint.startsWith(p))) {
    return { error: 'Endpoint not permitted. Must start with /crm/, /contacts/, /deals/, /marketing/, or /email/' };
  }
  try {
    const res = await fetch('https://api.hubapi.com' + endpoint, {
      method,
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json();
    if (!res.ok) return { error: data.message || 'HubSpot error', status: res.status };
    return data;
  } catch (e) {
    return { error: 'HubSpot request failed: ' + e.message };
  }
}

async function callGA4(ga4, input) {
  const { dimensions, metrics, dateRanges, limit = 10 } = input;
  const body = {
    dimensions: (dimensions || []).map(n => ({ name: n })),
    metrics: metrics.map(n => ({ name: n })),
    dateRanges: dateRanges || [{ startDate: '30daysAgo', endDate: 'today' }],
    limit: Math.min(limit || 10, 50)
  };
  try {
    const res = await fetch(
      `https://analyticsdata.googleapis.com/v1beta/properties/${ga4.propertyId}:runReport`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${ga4.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    );
    const data = await res.json();
    if (!res.ok) return { error: (data.error && data.error.message) || 'GA4 error' };
    return data;
  } catch (e) {
    return { error: 'GA4 request failed: ' + e.message };
  }
}

async function refreshGA4Token(ga4, slug) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: ga4.refreshToken,
      grant_type: 'refresh_token'
    })
  });
  const tokens = await r.json();
  if (!r.ok || tokens.error) throw new Error('GA4 token refresh failed');
  const updated = { ...ga4, accessToken: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
  await kv.set(`client:${slug}:ga4`, updated);
  return updated;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let payload;
  try { payload = verifyClient(req); } catch (e) { return res.status(e.status).json({ error: e.message }); }
  const slug = payload.slug;

  const [anthropicRaw, hubspotRaw, ga4Raw, acRaw] = await Promise.all([
    kv.get(`client:${slug}:anthropic`),
    kv.get(`client:${slug}:hubspot`),
    kv.get(`client:${slug}:ga4`),
    kv.get(`client:${slug}:activecampaign`)
  ]);

  if (!anthropicRaw) return res.status(401).json({ error: 'Anthropic key not configured', action: 'setup_anthropic' });
  const { apiKey } = safeGet(anthropicRaw);

  const hubspot = hubspotRaw ? safeGet(hubspotRaw) : null;
  const ac = acRaw ? safeGet(acRaw) : null;
  let ga4 = ga4Raw ? safeGet(ga4Raw) : null;

  if (ga4 && ga4.propertyId && Date.now() > (ga4.expiresAt || 0) - 60000) {
    try { ga4 = await refreshGA4Token(ga4, slug); } catch { ga4 = null; }
  }

  const { messages, system } = req.body;
  if (!messages) return res.status(400).json({ error: 'messages required' });

  const availableTools = TOOLS.filter(t =>
    (t.name === 'query_activecampaign' && ac?.apiKey && ac?.apiUrl) ||
    (t.name === 'query_hubspot' && hubspot?.accessToken) ||
    (t.name === 'query_ga4' && ga4?.propertyId && ga4?.accessToken)
  );

  let currentMessages = [...messages];
  const MAX_ITERATIONS = 5;
  const toolCallLog = [];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const reqBody = withPromptCaching({
      model: 'claude-sonnet-4-5',
      max_tokens: 2048,
      system,
      messages: currentMessages,
      tools: availableTools.length > 0 ? availableTools : undefined
    });

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(reqBody)
    });
    const data = await apiRes.json();

    if (!apiRes.ok) {
      if (apiRes.status === 401) return res.status(401).json({ error: 'Anthropic key invalid', action: 'setup_anthropic' });
      if (apiRes.status === 429) {
        return res.status(429).json({
          error: 'Claude is rate-limited right now. Wait a minute, then try a simpler or more specific question.',
          action: 'rate_limited'
        });
      }
      return res.status(apiRes.status).json({ error: (data.error && data.error.message) || 'Anthropic error' });
    }

    const u = data.usage || {};
    console.log(`[chat:${slug}] iter=${i} input=${u.input_tokens} cache_read=${u.cache_read_input_tokens || 0} cache_write=${u.cache_creation_input_tokens || 0} output=${u.output_tokens}`);

    const hasToolUse = data.content && data.content.some(b => b.type === 'tool_use');
    if (!hasToolUse) {
      data._toolLog = toolCallLog;
      return res.status(200).json(data);
    }

    currentMessages.push({ role: 'assistant', content: data.content });
    const toolResults = [];

    for (const block of data.content) {
      if (block.type !== 'tool_use') continue;
      let result;
      if (block.name === 'query_activecampaign' && ac?.apiKey) {
        result = await callActiveCampaign(ac, block.input);
      } else if (block.name === 'query_hubspot' && hubspot?.accessToken) {
        result = await callHubspot(hubspot.accessToken, block.input);
      } else if (block.name === 'query_ga4' && ga4?.accessToken) {
        result = await callGA4(ga4, block.input);
      } else {
        result = { error: 'Tool not available — connection may be missing' };
      }
      toolCallLog.push({
        iter: i,
        tool: block.name,
        input: block.input,
        ok: !result.error,
        error: result.error || null,
        resultPreview: result.error ? null : Object.keys(result).slice(0, 5)
      });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result).slice(0, 12000)
      });
    }

    currentMessages.push({ role: 'user', content: toolResults });
  }

  return res.status(200).json({
    content: [{ type: 'text', text: 'I hit the maximum number of steps trying to answer this. Try breaking it into a more specific question.' }],
    _toolLog: toolCallLog
  });
};
