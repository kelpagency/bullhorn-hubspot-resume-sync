const dotenv = require("dotenv");

dotenv.config();

const AUTH_URL = normalizeAuthUrl(
	process.env.BULLHORN_AUTH_URL ||
		process.env.BULLHORN_OAUTH_URL ||
		"https://auth.bullhornstaffing.com",
);
const CLIENT_ID = process.env.BULLHORN_CLIENT_ID;
const CLIENT_SECRET = process.env.BULLHORN_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.BULLHORN_REFRESH_TOKEN;
const REDIRECT_URI = process.env.BULLHORN_REDIRECT_URI;

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
	console.error(
		"Missing required env vars: BULLHORN_CLIENT_ID, BULLHORN_CLIENT_SECRET, BULLHORN_REFRESH_TOKEN",
	);
	process.exit(1);
}

const run = async () => {
	const tokenUrl = `${AUTH_URL}/oauth/token`;
	const params = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: REFRESH_TOKEN,
		client_id: CLIENT_ID,
		client_secret: CLIENT_SECRET,
	});

	if (REDIRECT_URI) {
		params.set("redirect_uri", REDIRECT_URI);
	}

	const response = await fetch(tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString(),
	});
	const responseText = await response.text();
	const payload = responseText ? safeParseJson(responseText) : {};

	if (!response.ok) {
		console.error(`Refresh token check failed (HTTP ${response.status}).`);
		if (responseText) {
			console.error("Response body:", responseText);
		}
		process.exit(1);
	}

	console.log("Refresh token is valid.");
	if (payload.access_token) {
		console.log("Access token acquired.");
	}
	if (payload.expires_in) {
		console.log(`Access token expires in ${payload.expires_in} seconds.`);
	}
};

run().catch((error) => {
	console.error("Refresh token check failed:", error);
	process.exit(1);
});

function safeParseJson(text) {
	try {
		return JSON.parse(text);
	} catch (error) {
		return {};
	}
}

function normalizeAuthUrl(url) {
	if (!url) {
		return url;
	}
	return url.endsWith("/oauth") ? url.slice(0, -"/oauth".length) : url;
}
