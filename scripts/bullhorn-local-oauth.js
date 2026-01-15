const crypto = require("crypto");
const http = require("http");
const { URL } = require("url");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

dotenv.config();

const PORT = Number.parseInt(process.env.PORT || "8787", 10);
const CLIENT_ID = process.env.BULLHORN_CLIENT_ID;
const CLIENT_SECRET = process.env.BULLHORN_CLIENT_SECRET;
const REDIRECT_URI = process.env.BULLHORN_REDIRECT_URI;
const USERNAME = process.env.BULLHORN_USERNAME;
const PASSWORD = process.env.BULLHORN_PASSWORD;
const AUTH_CODE = process.env.BULLHORN_AUTH_CODE;
const HEADLESS_AUTH = process.env.BULLHORN_HEADLESS_AUTH === "true";
const OAUTH_URL = normalizeOauthUrl(process.env.BULLHORN_OAUTH_URL);

if (!CLIENT_ID || !CLIENT_SECRET) {
	console.error(
		"Missing required env vars: BULLHORN_CLIENT_ID, BULLHORN_CLIENT_SECRET",
	);
	process.exit(1);
}

const authorizeUrl = new URL(`${OAUTH_URL}/authorize`);
authorizeUrl.searchParams.set("client_id", CLIENT_ID);
authorizeUrl.searchParams.set("response_type", "code");
const state = crypto.randomBytes(16).toString("hex");
authorizeUrl.searchParams.set("state", state);
if (REDIRECT_URI) {
	authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
}
if (USERNAME && PASSWORD) {
	authorizeUrl.searchParams.set("action", "Login");
	authorizeUrl.searchParams.set("username", USERNAME);
	authorizeUrl.searchParams.set("password", PASSWORD);
}

const exchangeToken = async (code, res, closeServer) => {
	try {
		const tokenUrl = `${OAUTH_URL}/token`;
		const params = new URLSearchParams({
			grant_type: "authorization_code",
			code,
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
		});
		if (REDIRECT_URI) {
			params.set("redirect_uri", REDIRECT_URI);
		}

		const tokenResponse = await fetch(tokenUrl, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: params,
		});

		const payload = await tokenResponse.json();

		if (!tokenResponse.ok) {
			console.error("Bullhorn token error:", payload);
			if (res) {
				res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("Token exchange failed. Check the server logs for details.");
			}
			if (closeServer) {
				closeServer();
			}
			return { ok: false, payload };
		}

		console.log("Bullhorn access_token:", payload.access_token);
		console.log("Bullhorn refresh_token:", payload.refresh_token);
		console.log("Save BULLHORN_REFRESH_TOKEN for use in the app.");
		upsertEnvVar("BULLHORN_ACCESS_TOKEN", payload.access_token);
		upsertEnvVar("BULLHORN_REFRESH_TOKEN", payload.refresh_token);

		if (res) {
			res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Token exchange complete. You can close this tab.");
		}
		if (closeServer) {
			closeServer();
		}
		return { ok: true, payload };
	} catch (error) {
		console.error("Token exchange failed:", error);
		if (res) {
			res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Token exchange failed. Check the server logs for details.");
		}
		if (closeServer) {
			closeServer();
		}
		return { ok: false, payload: { error: error.message } };
	}
};
let server;

function startManualFlow() {
	server.listen(PORT, () => {
		console.log(`Local OAuth listener running on http://localhost:${PORT}`);
		console.log("Open this URL in a browser to authorize:");
		console.log(authorizeUrl.toString());
	});
}

server = http.createServer(async (req, res) => {
	const requestUrl = new URL(req.url, `http://localhost:${PORT}`);
	const code = requestUrl.searchParams.get("code");
	const returnedState = requestUrl.searchParams.get("state");

	if (!code) {
		res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Waiting for Bullhorn redirect with ?code=...");
		return;
	}

	if (state && returnedState !== state) {
		console.error("Invalid OAuth state returned.");
		res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Invalid OAuth state. Please restart the flow.");
		server.close();
		return;
	}

	await exchangeToken(code, res, () => server.close());
});

async function runAuthFlow() {
	if (AUTH_CODE) {
		const tokenResult = await exchangeToken(AUTH_CODE);
		const invalidGrant = tokenResult?.payload?.error === "invalid_grant";
		if (!tokenResult?.ok && invalidGrant) {
			removeEnvVar("BULLHORN_AUTH_CODE");
			console.warn(
				"Authorization code invalid/expired. Attempting headless OAuth.",
			);
		} else {
			return;
		}
	}

	if (HEADLESS_AUTH) {
		if (!USERNAME || !PASSWORD) {
			console.warn(
				"Headless auth requested, but BULLHORN_USERNAME or BULLHORN_PASSWORD is missing. Falling back to manual flow.",
			);
		} else {
			try {
				const code = await getAuthCodeViaHeadless(authorizeUrl);
				if (code) {
					const tokenResult = await exchangeToken(code);
					if (tokenResult?.ok) {
						process.exit(0);
					}
				}
				console.warn(
					"Headless auth did not return a usable code. Falling back to manual flow.",
				);
			} catch (error) {
				console.error("Headless auth failed:", error);
				console.warn("Falling back to manual flow.");
			}
		}
	}

	startManualFlow();
}

runAuthFlow();

function upsertEnvVar(key, value) {
	if (!value) {
		return;
	}

	const envPath = path.resolve(process.cwd(), ".env");
	const line = `${key}="${value}"`;

	if (!fs.existsSync(envPath)) {
		fs.writeFileSync(envPath, `${line}\n`, "utf8");
		console.log(`Wrote ${key} to ${envPath}.`);
		return;
	}

	const contents = fs.readFileSync(envPath, "utf8");
	const lines = contents.split(/\r?\n/);
	let found = false;

	const updated = lines.map((existing) => {
		if (!existing || existing.trim().startsWith("#")) {
			return existing;
		}
		const [existingKey] = existing.split("=");
		if (existingKey && existingKey.trim() === key) {
			found = true;
			return line;
		}
		return existing;
	});

	if (!found) {
		updated.push(line);
	}

	fs.writeFileSync(envPath, `${updated.join("\n")}\n`, "utf8");
	console.log(`Wrote ${key} to ${envPath}.`);
}

function removeEnvVar(key) {
	const envPath = path.resolve(process.cwd(), ".env");
	if (!fs.existsSync(envPath)) {
		return;
	}

	const contents = fs.readFileSync(envPath, "utf8");
	const lines = contents.split(/\r?\n/);
	const updated = lines.filter((existing) => {
		if (!existing || existing.trim().startsWith("#")) {
			return true;
		}
		const [existingKey] = existing.split("=");
		return !(existingKey && existingKey.trim() === key);
	});

	fs.writeFileSync(envPath, `${updated.join("\n")}\n`, "utf8");
	console.log(`Removed ${key} from ${envPath}.`);
}

function normalizeOauthUrl(url) {
	const fallback = "https://auth.bullhornstaffing.com/oauth";
	if (!url) {
		return fallback;
	}
	return url.endsWith("/oauth") ? url : `${url}/oauth`;
}

async function getAuthCodeViaHeadless(authUrl) {
	const response = await fetch(authUrl.toString(), { redirect: "manual" });
	const location = response.headers.get("location");
	if (location) {
		const redirectUrl = new URL(location, authUrl.toString());
		const code = redirectUrl.searchParams.get("code");
		if (code) {
			return code;
		}
	}
	return null;
}
