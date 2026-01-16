"use strict";

const axios = require("axios");
const FormData = require("form-data");
const hubspot = require("@hubspot/api-client");

const HUBSPOT_FILES_BASE_URL = "https://api.hubapi.com";
const BULLHORN_AUTH_URL =
	process.env.BULLHORN_AUTH_URL || "https://auth.bullhornstaffing.com";
const BULLHORN_REST_BASE_URL =
	process.env.BULLHORN_REST_BASE_URL || "https://rest.bullhornstaffing.com";
const BULLHORN_OAUTH_URL = normalizeOauthUrl(BULLHORN_AUTH_URL);
const BULLHORN_FILE_TYPE = process.env.BULLHORN_FILE_TYPE || "Talent Resume";
const RESUME_PROPERTY = "resume";
const CATEGORY_FIELDS = [
	"creative",
	"content",
	"marketing",
	"technical",
	"strategicoperational",
	"emerging",
];
const SYNC_PROPERTIES = new Set([RESUME_PROPERTY, ...CATEGORY_FIELDS]);

exports.handler = async (event = {}) => {
	if (event.httpMethod && event.httpMethod !== "POST") {
		return response(405, { error: "Method not allowed" });
	}

	const authResult = authorizeRequest(event.headers || {});
	if (!authResult.ok) {
		return {
			statusCode: 401,
			body: JSON.stringify({ error: authResult.message }),
		};
	}

	if (!process.env.HUBSPOT_PRIVATE_APP_TOKEN) {
		return response(500, { error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" });
	}

	let events = [];
	try {
		const rawBody = event.body || "[]";
		const body = event.isBase64Encoded
			? Buffer.from(rawBody, "base64").toString("utf8")
			: rawBody;
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
		const eventContext = {
			subscriptionType: eventPayload?.subscriptionType,
			propertyName: eventPayload?.propertyName,
			objectId: eventPayload?.objectId,
		};
		console.log("resumeSync: received event", eventContext);

		try {
			if (eventPayload.subscriptionType !== "object.propertyChange") {
				continue;
			}

			if (
				eventPayload.propertyName &&
				!SYNC_PROPERTIES.has(eventPayload.propertyName)
			) {
				continue;
			}

			const contactId = eventPayload.objectId;
			if (!contactId) {
				continue;
			}

			const contact = await hubspotClient.crm.contacts.basicApi.getById(
				contactId,
				["email", RESUME_PROPERTY, ...CATEGORY_FIELDS],
			);
			const email = contact.properties?.email;
			const resumeValue = contact.properties?.[RESUME_PROPERTY];
			const categoryName = getSelectedCategoryName(contact.properties);
			const expertiseFields = CATEGORY_FIELDS.reduce((acc, field) => {
				acc[field] = contact.properties?.[field];
				return acc;
			}, {});
			console.log("resumeSync: expertise fields", {
				contactId,
				propertyName: eventPayload.propertyName,
				expertiseFields,
			});

			if (!email) {
				results.push({ contactId, skipped: true, reason: "Missing email" });
				continue;
			}

			const bullhornSession = await getBullhornSession();
			const candidateId = await findCandidateIdByEmail(bullhornSession, email);

			if (!candidateId) {
				results.push({
					contactId,
					skipped: true,
					reason: "Candidate not found",
				});
				continue;
			}

			const result = { contactId, candidateId };
			console.log("resumeSync: processing contact", { contactId, candidateId });

			if (categoryName && CATEGORY_FIELDS.includes(eventPayload.propertyName)) {
				try {
					const categoryId = await findCategoryIdByName(
						bullhornSession,
						categoryName,
					);
					if (categoryId) {
						const updateResult = await updateCandidateCategory({
							session: bullhornSession,
							candidateId,
							categoryId,
						});
						result.categoryName = categoryName;
						result.categoryId = categoryId;
						result.categoryUpdate = updateResult;
					} else {
						result.categoryName = categoryName;
						result.categoryUpdate = {
							skipped: true,
							reason: "Category not found",
						};
					}
				} catch (error) {
					console.error("resumeSync: Bullhorn category update failed", {
						contactId,
						candidateId,
						categoryName,
						message: error.message,
						status: error.response?.status,
						data: error.response?.data,
					});
					result.categoryName = categoryName;
					result.categoryUpdate = {
						skipped: true,
						reason: "Category update failed",
						error: error.message,
					};
				}
			}

			if (eventPayload.propertyName === RESUME_PROPERTY) {
				if (!resumeValue) {
					result.resumeUpload = { skipped: true, reason: "Missing resume" };
				} else {
					const { fileId, fileUrl, fileName } = parseResumeValue(resumeValue);
					const resolved = await resolveHubSpotFile({
						fileId,
						fileUrl,
						fileName,
						accessToken: process.env.HUBSPOT_PRIVATE_APP_TOKEN,
					});

					if (!resolved.url) {
						result.resumeUpload = {
							skipped: true,
							reason: "Resume file not found",
						};
					} else {
						console.log("resumeSync: resolved HubSpot file", {
							contactId,
							candidateId,
							fileId,
							fileName: resolved.fileName || fileName,
							fileUrl: resolved.url,
						});
						const fileResponse = await axios.get(resolved.url, {
							responseType: "arraybuffer",
						});

						const fileBuffer = Buffer.from(fileResponse.data);
						const contentType =
							fileResponse.headers["content-type"] ||
							"application/octet-stream";
						if (contentType.includes("text/html")) {
							console.warn("resumeSync: HubSpot file fetch returned HTML", {
								contactId,
								candidateId,
								fileId,
								fileUrl: resolved.url,
								contentType,
							});
							result.resumeUpload = {
								skipped: true,
								reason: "HubSpot file fetch returned HTML",
								contentType,
							};
							results.push(result);
							continue;
						}
						const uploadMeta = {
							candidateId,
							fileName: resolved.fileName || `resume-${contactId}`,
							contentType,
							fileType: BULLHORN_FILE_TYPE,
							externalId: `hubspot-contact-${contactId}`,
						};
						console.log("resumeSync: uploading Bullhorn file", uploadMeta);

						result.resumeUpload = await uploadCandidateFile({
							session: bullhornSession,
							candidateId,
							fileBuffer,
							fileName: resolved.fileName || `resume-${contactId}`,
							contentType,
							sourceContactId: contactId,
						});
						result.resumeUploadMeta = uploadMeta;
						console.log("resumeSync: Bullhorn upload response", {
							candidateId,
							resumeUpload: result.resumeUpload,
						});
					}
				}
			}

			if (!result.categoryUpdate && !result.resumeUpload) {
				result.skipped = true;
				result.reason = "No category or resume updates to apply";
			}

			results.push(result);
		} catch (error) {
			console.error("resumeSync: event processing failed", {
				...eventContext,
				message: error.message,
				status: error.response?.status,
				data: error.response?.data,
			});
			results.push({
				...eventContext,
				error: error.message,
				status: error.response?.status,
			});
		}
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
	if (!fileId && fileUrl) {
		return { url: fileUrl, fileName };
	}

	if (!fileId) {
		return { url: null, fileName };
	}

	const headers = {
		Authorization: `Bearer ${accessToken}`,
	};

	const response = await axios.get(
		`${HUBSPOT_FILES_BASE_URL}/files/v3/files/${fileId}`,
		{ headers },
	);

	let signedUrl = null;
	try {
		const signedResponse = await axios.get(
			`${HUBSPOT_FILES_BASE_URL}/files/v3/files/${fileId}/signed-url`,
			{ headers },
		);
		signedUrl = signedResponse.data?.url || null;
	} catch (error) {
		console.warn("resumeSync: failed to fetch HubSpot signed url", {
			fileId,
			message: error.message,
			status: error.response?.status,
			data: error.response?.data,
		});
	}

	return {
		url: signedUrl || response.data?.url || response.data?.downloadUrl || fileUrl || null,
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
			throw new Error(
				`Bullhorn token request failed (${status || "unknown"}): ${detail}`,
			);
		}
	}

	const accessToken = tokenResponse.data?.access_token;
	const rotatedRefreshToken = tokenResponse.data?.refresh_token;

	if (rotatedRefreshToken && rotatedRefreshToken !== refreshToken) {
		console.warn(
			"Bullhorn refresh token rotated. Update BULLHORN_REFRESH_TOKEN to avoid auth failures.",
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
			},
		);
	} catch (error) {
		const status = error.response?.status;
		if (retryOnAuthFailure && (status === 401 || status === 403)) {
			return getBullhornSession({ retryOnAuthFailure: false });
		}

		const data = error.response?.data;
		const detail = data ? JSON.stringify(data) : error.message;
		throw new Error(
			`Bullhorn login failed (${status || "unknown"}): ${detail}`,
		);
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

	return axios.post(
		`${BULLHORN_OAUTH_URL}/token`,
		new URLSearchParams(params).toString(),
		{
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
		},
	);
}

async function getBullhornAuthCodeHeadless({
	clientId,
	redirectUri,
	username,
	password,
}) {
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

	const startUrl = `${BULLHORN_OAUTH_URL}/authorize?${params.toString()}`;
	const result = await followRedirectForAuthCode(startUrl);

	if (!result.code) {
		throw new Error(
			`Bullhorn headless auth redirect missing code (status ${result.status || "unknown"})`,
		);
	}

	return result.code;
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

async function followRedirectForAuthCode(startUrl) {
	const maxRedirects = 5;
	let currentUrl = startUrl;

	for (let attempt = 0; attempt < maxRedirects; attempt += 1) {
		const response = await axios.get(currentUrl, {
			maxRedirects: 0,
			validateStatus: (status) => status >= 200 && status < 400,
		});

		const location = response.headers?.location;
		if (!location) {
			return { status: response.status, code: null };
		}

		const redirectUrl = new URL(location, currentUrl);
		const code = redirectUrl.searchParams.get("code");
		if (code) {
			return { status: response.status, code };
		}

		currentUrl = redirectUrl.toString();
		await delay(200);
	}

	return { status: 0, code: null };
}

async function findCandidateIdByEmail(session, email) {
	if (!session?.restUrl || !session?.bhRestToken) {
		throw new Error("Missing Bullhorn session details");
	}

	const normalizedEmail = String(email || "").trim();
	if (!normalizedEmail) {
		return null;
	}

	const escapedEmail = escapeBullhornQueryValue(normalizedEmail);
	const query = `(email:\"${escapedEmail}\" OR email2:\"${escapedEmail}\" OR email3:\"${escapedEmail}\")`;

	const response = await axios.get(`${session.restUrl}search/Candidate`, {
		params: {
			BhRestToken: session.bhRestToken,
			query,
			fields: "id,email,email2,email3",
			count: 1,
		},
	});

	return response.data?.data?.[0]?.id || null;
}

async function findCategoryIdByName(session, name) {
	if (!session?.restUrl || !session?.bhRestToken) {
		throw new Error("Missing Bullhorn session details");
	}

	const escapedName = escapeBullhornQueryValue(String(name || "").trim());
	if (!escapedName) {
		return null;
	}

	const response = await axios.get(`${session.restUrl}search/Category`, {
		params: {
			BhRestToken: session.bhRestToken,
			query: `name:\"${escapedName}\"`,
			fields: "id,name",
		},
	});

	return response.data?.data?.[0]?.id || null;
}

async function updateCandidateCategory({ session, candidateId, categoryId }) {
	if (!session?.restUrl || !session?.bhRestToken) {
		throw new Error("Missing Bullhorn session details");
	}

	const response = await axios.post(
		`${session.restUrl}entity/Candidate/${candidateId}`,
		{
			categoryID: categoryId,
		},
		{
			params: {
				BhRestToken: session.bhRestToken,
			},
			headers: {
				"Content-Type": "application/json",
			},
		},
	);

	return response.data;
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
	const externalId = `hubspot-contact-${sourceContactId}`;

	const response = await axios
		.put(`${session.restUrl}file/Candidate/${candidateId}/raw`, form, {
			params: {
				BhRestToken: session.bhRestToken,
				filetype: BULLHORN_FILE_TYPE,
				externalID: externalId,
			},
			headers: form.getHeaders(),
		})
		.catch((error) => {
			const status = error.response?.status;
			const data = error.response?.data;
			const detail = data ? JSON.stringify(data) : error.message;
			throw new Error(
				`Bullhorn file upload failed (${status || "unknown"}): ${detail}`,
			);
		});

	return response.data;
}

function response(statusCode, payload) {
	return {
		statusCode,
		body: JSON.stringify(payload),
	};
}

function authorizeRequest(headers = {}) {
	const expectedKey = process.env.RESUME_SYNC_API_KEY;
	if (!expectedKey) {
		return { ok: false, message: "Missing RESUME_SYNC_API_KEY configuration" };
	}

	const providedKey =
		headers["resume_sync_api_key"] ||
		headers["RESUME_SYNC_API_KEY"] ||
		headers["resume-sync-api-key"] ||
		headers["Resume-Sync-Api-Key"];
	if (!providedKey) {
		return { ok: false, message: "Missing RESUME_SYNC_API_KEY header" };
	}

	if (providedKey !== expectedKey) {
		return { ok: false, message: "Invalid API key" };
	}

	return { ok: true };
}

function getSelectedCategoryName(properties = {}) {
	for (const field of CATEGORY_FIELDS) {
		const value = properties[field];
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return null;
}

function escapeBullhornQueryValue(value) {
	if (!value) {
		return "";
	}

	return value
		.replace(/[\\+\-!(){}\[\]^"~*?:/]/g, "\\$&")
		.replace(/&&/g, "\\&&")
		.replace(/\|\|/g, "\\||");
}
