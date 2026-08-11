# Step Change Snapshot — Multi-Client System

One codebase, one Vercel deployment, unlimited clients.

## Architecture

```
snapshot.stepchange.com/
├── /admin                    → Admin panel (password protected)
├── /admin/index.html         → Admin UI
├── /{slug}                   → Client dashboard (e.g. /azura)
├── /{slug}/setup             → Client setup wizard
│
├── /api/admin/
│   ├── login.js              → Admin password → JWT
│   ├── create-client.js      → Create new client in KV
│   ├── list-clients.js       → List all clients + connection status
│   └── delete-client.js      → Remove a client
│
├── /api/auth/
│   ├── client-login.js       → Client password → JWT
│   ├── status.js             → Connection status for a client
│   ├── save-anthropic-key.js → Store client's Anthropic key in KV
│   ├── set-ga4-property.js   → Set/update GA4 property ID
│   ├── google.js             → Start Google OAuth
│   ├── google/callback.js    → Handle Google OAuth callback
│   ├── hubspot.js            → Start HubSpot OAuth
│   └── hubspot/callback.js   → Handle HubSpot OAuth callback
│
├── /api/ga4.js               → GA4 proxy (reads tokens from KV)
├── /api/hubspot.js           → HubSpot proxy (reads tokens from KV)
└── /api/claude.js            → Claude proxy (reads key from KV)
```

## KV Data Structure

```
admin:magic-link:{token}      → (not used — password auth instead)
clients:index                 → JSON array of all slugs
client:{slug}:config          → { name, slug, passwordHash, createdAt }
client:{slug}:anthropic       → { apiKey }
client:{slug}:hubspot         → { accessToken, refreshToken, expiresAt }
client:{slug}:activecampaign  → { apiUrl, apiKey }
client:{slug}:servicetitan    → { appKey, clientId, clientSecret, tenant, accessToken, tokenExpiresAt }
client:{slug}:ga4             → { accessToken, refreshToken, expiresAt, propertyId, availableProperties }
```

**CRM is mutually exclusive per client** — a client connects HubSpot *or* ActiveCampaign *or* ServiceTitan, not more than one. Disconnect the current CRM before switching.

## Setup Instructions

### 1. Vercel KV

In your Vercel dashboard:
- Go to **Storage** → **Create** → **KV**
- Connect it to your project
- KV env vars are injected automatically

### 2. Environment Variables

Copy `.env.example` and set all values in Vercel → Project Settings → Environment Variables.

Required:
- `ADMIN_PASSWORD` — your admin panel password
- `JWT_SECRET` — 64-char hex string (run `openssl rand -hex 32`)
- `APP_URL` — your full deployment URL
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
- `HUBSPOT_CLIENT_ID` / `HUBSPOT_CLIENT_SECRET`

### 3. Google Cloud OAuth App

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create/select a project
3. Enable **Google Analytics Data API** and **Google Analytics Admin API**
4. Go to **APIs & Services → Credentials → Create OAuth client ID**
5. Type: **Web application**
6. Authorised redirect URI: `https://snapshot.stepchange.com/api/auth/google/callback`
7. Copy Client ID and Secret to env vars

### 4. HubSpot OAuth App

1. Go to [app.hubspot.com/developer](https://app.hubspot.com/developer)
2. Create a new **Public App**
3. Under **Auth**, set redirect URL: `https://snapshot.stepchange.com/api/auth/hubspot/callback`
4. Scopes: `crm.objects.deals.read`, `crm.objects.contacts.read`, `crm.objects.companies.read`
5. Copy Client ID and Secret to env vars

### 5b. ServiceTitan (optional third CRM)

ServiceTitan is connected per-client from the setup wizard (no global OAuth app or
env vars required for production). Each client enters four credentials:

1. In the [ServiceTitan Developer Portal](https://developer.servicetitan.io/) → **My Apps**, create an app, add the client's **Tenant ID**, and choose read scopes (JPM, CRM, Sales, Settings, Marketing). Saving generates the **App Key** (`ak1...`).
2. The client's ServiceTitan admin (with "Manage API Application Access") generates the app's **Client ID** and **Client Secret** for their tenant.
3. In the dashboard setup wizard, pick the **ServiceTitan** CRM tab and enter App Key, Tenant ID, Client ID, Client Secret.

Auth uses the OAuth 2.0 client-credentials flow; the `/api/servicetitan` proxy fetches
and caches an access token (tokens expire every 900s) and adds the `Authorization: Bearer`
and `ST-App-Key` headers on every call. Base URL: `https://api.servicetitan.io`.

Optional env vars (only for the ServiceTitan **integration/sandbox** environment):
- `ST_AUTH_URL` — defaults to `https://auth.servicetitan.io/connect/token`
- `ST_API_BASE` — defaults to `https://api.servicetitan.io`

> ⚠️ **Verify field mappings before trusting the numbers.** The dashboard maps ServiceTitan
> jobs → deals and customers → contacts, and reads fields (`total`, `jobStatus`,
> `businessUnitId`, `campaignId`, `soldOn`, etc.) defensively. Confirm these against a real
> tenant's `/jpm/v2/tenant/{tenant}/jobs` and `/sales/v2/tenant/{tenant}/estimates`
> responses; unmatched fields degrade to "—" rather than erroring. ServiceTitan has no
> email-marketing data, so the Email Performance cards show "n/a" and a "ServiceTitan Metrics"
> section (jobs, avg job value, estimate→sold rate, revenue by business unit, lead source) is
> shown instead.

### 5. Deploy

```bash
vercel --prod
```

## Adding a New Client

1. Visit `https://snapshot.stepchange.com/admin`
2. Log in with your admin password
3. Enter client name + password, click **Add client**
4. Copy the generated URL and share it with the client

The client then visits their URL, enters the password, and follows the setup wizard to connect:
- Their Anthropic API key
- HubSpot (OAuth popup)
- Google Analytics (OAuth popup)

## Token Refresh

All OAuth tokens are automatically refreshed when they expire. If a refresh fails (e.g. client revoked access), the dashboard will show a "reconnect" prompt.

## Integrating Your Existing Dashboard

In `index.html`:
1. Add your existing CSS inside the `/* YOUR EXISTING DASHBOARD STYLES GO HERE */` section
2. Replace the `<!-- YOUR EXISTING DASHBOARD CONTENT GOES HERE -->` section with your dashboard HTML
3. In the `loadDashboardData()` function, add your existing data-loading logic

All API calls must include the auth header:
```javascript
headers: { Authorization: `Bearer ${token}` }
```

The `slug` and `token` variables are available globally in `index.html`.

## Future Enhancements (flagged, not built)

- **Claude tool use** — Claude chat can call `/api/hubspot` and `/api/ga4` as tools during conversation for deeper queries beyond summary metrics
- **Admin dashboard** — view all connected clients, token expiry dates, usage stats
- **Token expiry alerts** — notify admin when a client's tokens are nearing expiry

---

## Multi-CRM channel layer + Social (branch: `feature/multi-crm-channels-social`)

The tabbed channel view built for ServiceTitan now runs for **every** CRM.

### What is shared

- **Tab bar**: Executive Overview, one tab per channel with data, then **Social**.
- **Social is always present**, for every client, regardless of what is connected —
  the same rule as Executive Overview. Channel tabs still appear only when that
  channel has data.
- Every channel tab shows **Subscription cost** and **Campaigns running**.

### What differs per CRM (deliberately)

| | ServiceTitan | HubSpot | ActiveCampaign |
|---|---|---|---|
| Existing sections | replaced by its own KPI row (unchanged) | **all kept** | **all kept** |
| Channel source | campaign category → `ST_CHANNEL_MAP` | `hs_analytics_source` | none available |
| KPI 2/3 labels | Booked Jobs / Total Sales | Deals Created / Deals Won | Deals Created / Deals Won |
| Business Unit + job tables | shown | hidden | hidden |
| Chart label | Jobs by Channel | Deals by Channel | Deals by Channel |

No existing dashboard loses a section. ServiceTitan behaviour is unchanged.

### HubSpot channel attribution

- Leads come from `hs_analytics_source` on each contact.
- HubSpot does not publish the internal enum strings for that property, only the
  UI labels. `HS_SOURCE_CHANNEL_MAP` covers the widely-observed values *and* the
  labels; anything unrecognised is Title-Cased into its own visible channel
  rather than being swallowed into "Other". An unanticipated value therefore
  shows up on screen, correctly named, instead of disappearing.
- Deals have no source property, so a deal is attributed through its associated
  contact via `/crm/v4/associations/deals/contacts/batch/read`. If that call
  fails or the token lacks the scope, deal KPIs read
  "Metric not tracked by HubSpot" rather than a misleading `0`.
- `hs_analytics_source_data_1` (Traffic Source Drill-Down 1) is fetched so the
  Social tab can split LinkedIn from Facebook from Instagram.

### ActiveCampaign

ActiveCampaign's Attribution feature is an in-app report; no documented v3 API
endpoint exposes touchpoint data. Contacts are therefore grouped as
**Unattributed** rather than assigned to a channel we cannot evidence. The email
campaigns AC does return populate the Mass eDM channel, with opens standing in
for impressions and leads marked not-tracked.

### Social platforms

Eight blocks, always rendered, each with its own connect state:

| Block | API status (verified Aug 2026) |
|---|---|
| LinkedIn – Company Page | `organizationalEntityFollowerStatistics`, scope `rw_organization_admin`. Development tier is capped at 500 calls/app/24h. |
| LinkedIn – Ads | `adAnalytics`, scope `r_ads_reporting`. Read access is unlimited at the default Development tier. |
| LinkedIn – Personal profile | `memberCreatorPostAnalytics`, scope `r_member_postAnalytics`. Authenticated member's own posts only. |
| LinkedIn – Sales Navigator | **Not retrievable.** `r_sales_nav_analytics` is restricted to approved SNAP partners. Manual cost/seats only. |
| Meta – Facebook Ads | Marketing API insights, `ads_read`, `publisher_platform=facebook`. |
| Meta – Instagram Ads | Marketing API insights, `ads_read`, `publisher_platform=instagram`. |
| Meta – Facebook Page | Pages API insights. Several metrics deprecated 2024–2026. |
| Meta – Instagram organic | Instagram Platform insights. `impressions` deprecated; `views` replaces it. |

Meta note: running **other people's** ad accounts requires Full Access (formerly
Advanced Access) via App Review. The default Limited tier is documented as not
for production advertisers.

### Empty-state wording

One template, filled with the actual platform name:

- `msgNotConnected(platform)` → "LinkedIn – Ads not connected", "GA4 not connected"
- `msgNotTracked(platform)` → "Metric not tracked by ServiceTitan"

### Subscription cost

Manual entry only, in `/{slug}/setup` → **Channel costs**. Labelled on the
dashboard as *"Requires manual input due to data security restrictions."* No
advertising, CRM or social platform exposes a client's own billing or contract
price through its reporting API.

### New KV keys

```
client:{slug}:channelconfig   → { costs:{}, campaigns:{}, currency, salesNavigator:{enabled,seats}, updatedAt }
client:{slug}:linkedin        → (next pass) { organizationId, adAccountId, memberAnalytics, tokens… }
client:{slug}:meta            → (next pass) { adAccountId, pageId, igUserId, tokens… }
```

### New auth actions

- `GET  /api/auth?action=load-channel-config`
- `POST /api/auth?action=save-channel-config`
- `action=status` now also returns a `social` object with per-platform connect state.

### Still to come (next pass)

Live LinkedIn and Meta proxies (`/api/linkedin`, `/api/meta`) plus their OAuth
wiring. Blocked on LinkedIn API approval and Meta App Review, not on this code.
Server-side response caching in KV is recommended before LinkedIn goes live, to
stay inside the 500-call Development-tier ceiling.
