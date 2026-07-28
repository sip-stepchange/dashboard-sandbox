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
client:{slug}:ga4             → { accessToken, refreshToken, expiresAt, propertyId, availableProperties }
```

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
