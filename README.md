# Bullhorn <> HubSpot Resume Sync

Utilities for syncing resumes between Bullhorn and HubSpot.

## Netlify resume sync function

The Netlify function at `netlify/functions/resumeSync.js` listens for HubSpot webhook
events and mirrors resume/category updates into Bullhorn.

How it works:

- Accepts `POST` webhook payloads (single event or array of events).
- Validates an API key header against `RESUME_SYNC_API_KEY`.
- Loads the HubSpot contact (email, resume, category fields).
- Finds the Bullhorn candidate by matching email/email2/email3.
- Updates the Bullhorn category if a category field is set.
- Downloads the HubSpot resume file and uploads it to Bullhorn as a candidate file.

Configuration (Netlify env vars or `.env` for local testing):

- `HUBSPOT_PRIVATE_APP_TOKEN`: HubSpot private app token used to read contacts/files.
- `RESUME_SYNC_API_KEY`: Shared secret required in the request header.
- `BULLHORN_CLIENT_ID`, `BULLHORN_CLIENT_SECRET`, `BULLHORN_REFRESH_TOKEN`: Bullhorn OAuth.
- `BULLHORN_REDIRECT_URI`: Optional redirect URI (needed if refreshing auth fails).
- `BULLHORN_USERNAME`, `BULLHORN_PASSWORD`: Optional fallback for headless auth.
- `BULLHORN_AUTH_URL`: Optional, defaults to `https://auth.bullhornstaffing.com`.
- `BULLHORN_REST_BASE_URL`: Optional, defaults to `https://rest.bullhornstaffing.com`.
- `BULLHORN_FILE_TYPE`: Optional, defaults to `Talent Resume`.

Calling the function (webhook-style):

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "Resume-Sync-Api-Key: $RESUME_SYNC_API_KEY" \
  -d '[{"subscriptionType":"object.propertyChange","objectId":123,"propertyName":"resume"}]' \
  https://<your-netlify-site>/.netlify/functions/resumeSync
```

The function only reacts to `object.propertyChange` events for the `resume` field or
category fields (`creative`, `content`, `marketing`, `technical`,
`strategicoperational`, `emerging`). Other events are ignored. If
`subscriptionType` is omitted, the handler treats the request as a manual trigger
and syncs resume/category fields for the contact.

Manual trigger example (minimal payload):

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "Resume-Sync-Api-Key: $RESUME_SYNC_API_KEY" \
  -d '[{"objectId":123}]' \
  https://<your-netlify-site>/.netlify/functions/resumeSync
```

Local usage:

```bash
cp .env.example .env # if you have one; otherwise set env vars manually
npm run resumeSync:local -- --payload path/to/payload.json
```

If you omit `--payload`, it will run a default manual trigger against the
contact ID in the script.

## Bullhorn local OAuth

Use this when you need a Bullhorn refresh token during local development.

1. Follow the setup in `BULLHORN_OAUTH_LOCAL.md`.
2. Run the helper:

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
