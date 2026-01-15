"use strict";

const axios = require("axios");
const FormData = require("form-data");
const hubspot = require("@hubspot/api-client");

const HUBSPOT_FILES_BASE_URL = "https://api.hubapi.com";
const BULLHORN_AUTH_URL = process.env.BULLHORN_AUTH_URL || "https://auth.bullhornstaffing.com";
const BULLHORN_REST_BASE_URL =
  process.env.BULLHORN_REST_BASE_URL || "https://rest.bullhornstaffing.com";
const BULLHORN_OAUTH_URL = normalizeOauthUrl(BULLHORN_AUTH_URL);

exports.handler = async (event = {}) => {
  if (event.httpMethod && event.httpMethod !== "POST") {
    return response(405, { error: "Method not allowed" });
  }

  if (!process.env.HUBSPOT_PRIVATE_APP_TOKEN) {
    return response(500, { error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" });
  }

  let events = [];
  try {
    const rawBody = event.body || "[]";
    const body = event.isBase64Encoded ? Buffer.from(rawBody, "base64").toString("utf8") : rawBody;
    const parsed = body ? JSON.parse(body) : [];
    events = Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    return response(400, { error: "Invalid JSON payload" });
  }

  if (!events.length) {
    return response(200, { message: "No events to process" });
  }

  const hubspotClient = new hubspot.Client({
    accessToken: process.env.HUBSPOT_PRIVATE_APP_TOKEN,
  });

  const results = [];
  for (const eventPayload of events) {
    if (eventPayload.subscriptionType !== "object.propertyChange") {
      continue;
    }

    if (eventPayload.propertyName && eventPayload.propertyName !== "resume") {
      continue;
    }

    const contactId = eventPayload.objectId;
    if (!contactId) {
      continue;
    }

    const contact = await hubspotClient.crm.contacts.basicApi.getById(
      contactId,
      ["email", "resume"]
    );
    const email = contact.properties?.email;
    const resumeValue = contact.properties?.resume;

    if (!email || !resumeValue) {
      results.push({ contactId, skipped: true, reason: "Missing email or resume" });
      continue;
    }

    const { fileId, fileUrl, fileName } = parseResumeValue(resumeValue);
    const resolved = await resolveHubSpotFile({
      fileId,
      fileUrl,
      fileName,
      accessToken: process.env.HUBSPOT_PRIVATE_APP_TOKEN,
    });

    if (!resolved.url) {
      results.push({ contactId, skipped: true, reason: "Resume file not found" });
      continue;
    }

    const fileResponse = await axios.get(resolved.url, {
      responseType: "arraybuffer",
    });

    const fileBuffer = Buffer.from(fileResponse.data);
    const contentType =
      fileResponse.headers["content-type"] || "application/octet-stream";

    const bullhornSession = await getBullhornSession();
    const candidateId = await findCandidateIdByEmail(bullhornSession, email);

    if (!candidateId) {
      results.push({ contactId, skipped: true, reason: "Candidate not found" });
      continue;
    }

    const uploadResult = await uploadCandidateFile({
      session: bullhornSession,
      candidateId,
      fileBuffer,
      fileName: resolved.fileName || `resume-${contactId}`,
      contentType,
      sourceContactId: contactId,
    });

    results.push({ contactId, candidateId, uploadResult });
  }

  return response(200, { results });
};

function parseResumeValue(resumeValue) {
  let fileId = null;
  let fileUrl = null;
  let fileName = null;

  if (typeof resumeValue !== "string") {
    return { fileId, fileUrl, fileName };
  }

  const trimmed = resumeValue.trim();
  if (!trimmed) {
    return { fileId, fileUrl, fileName };
  }

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      fileId = parsed.id || parsed.fileId || fileId;
      fileUrl = parsed.url || parsed.downloadUrl || parsed.link || fileUrl;
      fileName = parsed.name || parsed.fileName || fileName;
      return { fileId, fileUrl, fileName };
    } catch (error) {
      // Fall through to string parsing.
    }
  }

  if (/^https?:\/\//.test(trimmed)) {
    fileUrl = trimmed;
  } else if (/^\d+$/.test(trimmed)) {
    fileId = trimmed;
  }

  return { fileId, fileUrl, fileName };
}

async function resolveHubSpotFile({ fileId, fileUrl, fileName, accessToken }) {
  if (fileUrl) {
    return { url: fileUrl, fileName };
  }

  if (!fileId) {
    return { url: null, fileName };
  }

  const response = await axios.get(`${HUBSPOT_FILES_BASE_URL}/files/v3/files/${fileId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  return {
    url: response.data?.url || response.data?.downloadUrl || null,
    fileName: response.data?.name || fileName,
  };
}

async function getBullhornSession({ retryOnAuthFailure = true } = {}) {
  const clientId = process.env.BULLHORN_CLIENT_ID;
  const clientSecret = process.env.BULLHORN_CLIENT_SECRET;
  const refreshToken = process.env.BULLHORN_REFRESH_TOKEN;
  const redirectUri = process.env.BULLHORN_REDIRECT_URI;
  const username = process.env.BULLHORN_USERNAME;
  const password = process.env.BULLHORN_PASSWORD;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing Bullhorn OAuth configuration");
  }

  let tokenResponse;
  try {
    tokenResponse = await exchangeBullhornToken({
      grantType: "refresh_token",
      clientId,
      clientSecret,
      refreshToken,
      redirectUri,
    });
  } catch (error) {
    const payload = error.response?.data;
    const invalidGrant = payload?.error === "invalid_grant";

    if (invalidGrant && username && password) {
      const authCode = await getBullhornAuthCodeHeadless({
        clientId,
        redirectUri,
        username,
        password,
      });

      tokenResponse = await exchangeBullhornToken({
        grantType: "authorization_code",
        clientId,
        clientSecret,
        authCode,
        redirectUri,
      });
    } else {
      const status = error.response?.status;
      const data = error.response?.data;
      const detail = data ? JSON.stringify(data) : error.message;
      throw new Error(`Bullhorn token request failed (${status || "unknown"}): ${detail}`);
    }
  }

  const accessToken = tokenResponse.data?.access_token;
  const rotatedRefreshToken = tokenResponse.data?.refresh_token;

  if (rotatedRefreshToken && rotatedRefreshToken !== refreshToken) {
    console.warn(
      "Bullhorn refresh token rotated. Update BULLHORN_REFRESH_TOKEN to avoid auth failures."
    );
  }

  if (!accessToken) {
    throw new Error("Bullhorn token response missing access_token");
  }

  let loginResponse;
  try {
    loginResponse = await axios.get(
      `${BULLHORN_REST_BASE_URL}/rest-services/login`,
      {
        params: {
          version: "*",
          access_token: accessToken,
        },
      }
    );
  } catch (error) {
    const status = error.response?.status;
    if (retryOnAuthFailure && (status === 401 || status === 403)) {
      return getBullhornSession({ retryOnAuthFailure: false });
    }

    const data = error.response?.data;
    const detail = data ? JSON.stringify(data) : error.message;
    throw new Error(`Bullhorn login failed (${status || "unknown"}): ${detail}`);
  }

  return {
    bhRestToken: loginResponse.data?.BhRestToken,
    restUrl: loginResponse.data?.restUrl,
  };
}

async function exchangeBullhornToken({
  grantType,
  clientId,
  clientSecret,
  refreshToken,
  authCode,
  redirectUri,
}) {
  const params = {
    grant_type: grantType,
    client_id: clientId,
    client_secret: clientSecret,
  };

  if (grantType === "refresh_token") {
    params.refresh_token = refreshToken;
  } else if (grantType === "authorization_code") {
    params.code = authCode;
  }

  if (redirectUri) {
    params.redirect_uri = redirectUri;
  }

  return axios.post(`${BULLHORN_OAUTH_URL}/token`, new URLSearchParams(params).toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

async function getBullhornAuthCodeHeadless({
  clientId,
  redirectUri,
  username,
  password,
}) {
  const maxAttempts = 3;
  const baseDelayMs = 300;
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    action: "Login",
    username,
    password,
  });

  if (redirectUri) {
    params.set("redirect_uri", redirectUri);
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await axios.get(`${BULLHORN_OAUTH_URL}/authorize`, {
      params,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const location = response.headers?.location;
    if (location) {
      const redirectUrl = new URL(location);
      const code = redirectUrl.searchParams.get("code");
      if (code) {
        return code;
      }
    }

    if (attempt < maxAttempts - 1) {
      await delay(baseDelayMs * (attempt + 1));
    }
  }

  throw new Error("Bullhorn headless auth redirect missing code");
}

function normalizeOauthUrl(url) {
  if (!url) {
    return "https://auth.bullhornstaffing.com/oauth";
  }
  return url.endsWith("/oauth") ? url : `${url}/oauth`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findCandidateIdByEmail(session, email) {
  if (!session?.restUrl || !session?.bhRestToken) {
    throw new Error("Missing Bullhorn session details");
  }

  const response = await axios.get(`${session.restUrl}search/Candidate`, {
    params: {
      BhRestToken: session.bhRestToken,
      query: `email:\"${email}\"`,
    },
  });

  return response.data?.data?.[0]?.id || null;
}

async function uploadCandidateFile({
  session,
  candidateId,
  fileBuffer,
  fileName,
  contentType,
  sourceContactId,
}) {
  if (!session?.restUrl || !session?.bhRestToken) {
    throw new Error("Missing Bullhorn session details");
  }

  const form = new FormData();
  form.append("file", fileBuffer, { filename: fileName, contentType });
  form.append("externalID", `hubspot-contact-${sourceContactId}`);
  form.append("comments", "Resume synced from HubSpot");

  const response = await axios.post(
    `${session.restUrl}file/Candidate/${candidateId}`,
    form,
    {
      params: {
        BhRestToken: session.bhRestToken,
      },
      headers: form.getHeaders(),
    }
  );

  return response.data;
}

function response(statusCode, payload) {
  return {
    statusCode,
    body: JSON.stringify(payload),
  };
}
