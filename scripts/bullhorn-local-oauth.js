const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const loadEnvFile = () => {
  const candidatePaths = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(__dirname, "..", ".env"),
    path.resolve(__dirname, "..", "..", ".env"),
  ];

  for (const envPath of candidatePaths) {
    if (!fs.existsSync(envPath)) {
      continue;
    }

    const contents = fs.readFileSync(envPath, "utf8");
    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }

      const separatorIndex = line.indexOf("=");
      if (separatorIndex === -1) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim();
      let value = line.slice(separatorIndex + 1).trim();

      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }

    break;
  }
};

loadEnvFile();

const PORT = Number.parseInt(process.env.PORT || "8787", 10);
const CLIENT_ID = process.env.BULLHORN_CLIENT_ID;
const CLIENT_SECRET = process.env.BULLHORN_CLIENT_SECRET;
const REDIRECT_URI = process.env.BULLHORN_REDIRECT_URI;
const USERNAME = process.env.BULLHORN_USERNAME;
const PASSWORD = process.env.BULLHORN_PASSWORD;
const AUTH_CODE = process.env.BULLHORN_AUTH_CODE;
const OAUTH_URL = process.env.BULLHORN_OAUTH_URL || "https://auth.bullhornstaffing.com/oauth";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing required env vars: BULLHORN_CLIENT_ID, BULLHORN_CLIENT_SECRET");
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
      return;
    }

    console.log("Bullhorn access_token:", payload.access_token);
    console.log("Bullhorn refresh_token:", payload.refresh_token);
    console.log("Save BULLHORN_REFRESH_TOKEN for use in the app.");

    if (res) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Token exchange complete. You can close this tab.");
    }
    if (closeServer) {
      closeServer();
    }
  } catch (error) {
    console.error("Token exchange failed:", error);
    if (res) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Token exchange failed. Check the server logs for details.");
    }
    if (closeServer) {
      closeServer();
    }
  }
};

if (AUTH_CODE) {
  exchangeToken(AUTH_CODE);
  return;
}

const server = http.createServer(async (req, res) => {
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

server.listen(PORT, () => {
  console.log(`Local OAuth listener running on http://localhost:${PORT}`);
  console.log("Open this URL in a browser to authorize:");
  console.log(authorizeUrl.toString());
});
