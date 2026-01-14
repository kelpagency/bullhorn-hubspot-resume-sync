"use strict";

const axios = require("axios");
const FormData = require("form-data");
const hubspot = require("@hubspot/api-client");

const HUBSPOT_FILES_BASE_URL = "https://api.hubapi.com";
const BULLHORN_AUTH_URL = process.env.BULLHORN_AUTH_URL || "https://auth.bullhornstaffing.com";
const BULLHORN_REST_BASE_URL =
  process.env.BULLHORN_REST_BASE_URL || "https://rest.bullhornstaffing.com";

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

async function getBullhornSession() {
  const clientId = process.env.BULLHORN_CLIENT_ID;
  const clientSecret = process.env.BULLHORN_CLIENT_SECRET;
  const refreshToken = process.env.BULLHORN_REFRESH_TOKEN;
  const redirectUri = process.env.BULLHORN_REDIRECT_URI;

  if (!clientId || !clientSecret || !refreshToken || !redirectUri) {
    throw new Error("Missing Bullhorn OAuth configuration");
  }

  const tokenResponse = await axios.get(`${BULLHORN_AUTH_URL}/oauth/token`, {
    params: {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    },
  });

  const accessToken = tokenResponse.data?.access_token;

  if (!accessToken) {
    throw new Error("Bullhorn token response missing access_token");
  }

  const loginResponse = await axios.get(
    `${BULLHORN_REST_BASE_URL}/rest-services/login`,
    {
      params: {
        version: "*",
        access_token: accessToken,
      },
    }
  );

  return {
    bhRestToken: loginResponse.data?.BhRestToken,
    restUrl: loginResponse.data?.restUrl,
  };
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
