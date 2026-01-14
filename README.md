# Bullhorn <> HubSpot Resume Sync

Utilities for syncing resumes between Bullhorn and HubSpot.

## Bullhorn local OAuth

Use this when you need a Bullhorn refresh token during local development.

1) Follow the setup in `BULLHORN_OAUTH_LOCAL.md`.
2) Run the helper:

```bash
BULLHORN_CLIENT_ID="..." \
BULLHORN_CLIENT_SECRET="..." \
BULLHORN_OAUTH_URL="https://auth-east.bullhornstaffing.com/oauth" \
npm run bullhorn:oauth:local
```

If you already have an authorization code:

```bash
BULLHORN_CLIENT_ID="..." \
BULLHORN_CLIENT_SECRET="..." \
BULLHORN_OAUTH_URL="https://auth-east.bullhornstaffing.com/oauth" \
BULLHORN_AUTH_CODE="your_code_here" \
npm run bullhorn:oauth:local
```
