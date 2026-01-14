# Bullhorn OAuth: Local Dev Flow

Use this when you need a Bullhorn refresh token during local development.

## 1) Pick a redirect URI (HTTPS)

Bullhorn requires an exact redirect URI match. For local development, use a tunnel.

Example using ngrok:

1. Start ngrok: `ngrok http 8787`
2. Copy the HTTPS URL it prints, e.g. `https://abcd-1234.ngrok-free.app`
3. Use `https://abcd-1234.ngrok-free.app` as the redirect URI (no trailing slash unless registered)

Ask the Bullhorn admin to add that exact redirect URI to the app settings.

## 2) Get the correct Bullhorn OAuth URL

Make the loginInfo call for your API user to get the data-center-specific URL:

`https://rest.bullhornstaffing.com/rest-services/loginInfo?username=API_USERNAME`

Use the `oauthUrl` from the response, for example:

`https://auth-east.bullhornstaffing.com/oauth`

## 3) Run the local OAuth helper

From the repo root, `BULLHORN_REDIRECT_URI` is optional (only include it if you registered one):

```bash
BULLHORN_CLIENT_ID="..." \
BULLHORN_CLIENT_SECRET="..." \
BULLHORN_OAUTH_URL="https://auth-east.bullhornstaffing.com/oauth" \
node scripts/bullhorn-local-oauth.js
```

If you already have an authorization code, you can skip the redirect and exchange it directly:

```bash
BULLHORN_CLIENT_ID="..." \
BULLHORN_CLIENT_SECRET="..." \
BULLHORN_OAUTH_URL="https://auth-east.bullhornstaffing.com/oauth" \
BULLHORN_AUTH_CODE="your_code_here" \
node scripts/bullhorn-local-oauth.js
```

The script prints an authorize URL. Open it in a browser, log in, accept the terms, and you will be redirected back to the local listener. The console will print the `refresh_token`.
