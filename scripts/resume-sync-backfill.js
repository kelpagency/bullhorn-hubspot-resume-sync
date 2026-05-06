"use strict";

require("dotenv").config();

const hubspot = require("@hubspot/api-client");

const {
	handler,
	getBullhornSession,
	findCandidateIdByEmail,
	hasBullhornResume,
} = require("../netlify/functions/resumeSync");

const CATEGORY_FIELDS = [
	"creative",
	"content",
	"marketing",
	"technical",
	"strategicoperational",
	"emerging",
];
const SYNC_PROPERTIES = ["email", "resume", ...CATEGORY_FIELDS];

function parseArgs(argv) {
	const args = {
		since: null,
		hours: 999,
		batchSize: 25,
		limit: null,
		property: "hs_lastmodifieddate",
	};

	for (let i = 2; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = argv[i + 1];

		if ((arg === "-s" || arg === "--since") && next) {
			args.since = next;
			i += 1;
		} else if ((arg === "-h" || arg === "--hours") && next) {
			args.hours = Number.parseFloat(next);
			i += 1;
		} else if ((arg === "-b" || arg === "--batch-size") && next) {
			args.batchSize = Number.parseInt(next, 10);
			i += 1;
		} else if ((arg === "-l" || arg === "--limit") && next) {
			args.limit = Number.parseInt(next, 10);
			i += 1;
		} else if (arg === "--property" && next) {
			args.property = next;
			i += 1;
		}
	}

	return args;
}

function resolveSinceDate(args) {
	if (args.since) {
		const parsed = new Date(args.since);
		if (Number.isNaN(parsed.getTime())) {
			throw new Error(`Invalid --since value: ${args.since}`);
		}
		return parsed;
	}

	const hours = Number.isFinite(args.hours) ? args.hours : 24;
	return new Date(Date.now() - hours * 60 * 60 * 1000);
}

async function main() {
	const { since, hours, batchSize, limit, property } = parseArgs(process.argv);
	const sinceDate = resolveSinceDate({ since, hours });
	const sinceMillis = sinceDate.getTime();

	const accessToken = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
	if (!accessToken) {
		throw new Error("Missing HUBSPOT_PRIVATE_APP_TOKEN");
	}

	if (
		!process.env.RESUME_SYNC_API_KEY &&
		process.env.RESUME_SYNC_SKIP_AUTH !== "true"
	) {
		process.env.RESUME_SYNC_SKIP_AUTH = "true";
		console.warn(
			"resumeSync:backfill: enabling RESUME_SYNC_SKIP_AUTH for local replay",
		);
	}

	const client = new hubspot.Client({ accessToken });
	let uniqueContactIds = await searchContactsSince({
		client,
		property,
		sinceMillis,
		limit,
	});

	if (!uniqueContactIds.length) {
		console.warn(
			"resumeSync:backfill: search returned no contacts; falling back to full contact scan",
			{ property, since: sinceDate.toISOString() },
		);
		uniqueContactIds = await scanContactsSince({
			client,
			property,
			sinceMillis,
			limit,
		});
	}

	const cappedContactIds = limit
		? uniqueContactIds.slice(0, limit)
		: uniqueContactIds;

	console.log("resumeSync:backfill: search summary", {
		property,
		since: sinceDate.toISOString(),
		hours: Number.isFinite(hours) ? hours : null,
		found: uniqueContactIds.length,
		processing: cappedContactIds.length,
		batchSize,
	});

	const hubspotClient = new hubspot.Client({ accessToken });
	const bullhornSession = await getBullhornSession();
	const syncableContactIds = [];

	let processed = 0;
	let skipped = 0;
	let failed = 0;
	let missingEmail = 0;
	let missingHubSpotResume = 0;
	let missingBullhornCandidate = 0;
	let bullhornAlreadyHadResume = 0;

	for (const contactId of cappedContactIds) {
		try {
			const contact = await hubspotClient.crm.contacts.basicApi.getById(
				contactId,
				["email", "resume", ...CATEGORY_FIELDS],
			);

			const email = String(contact.properties?.email || "").trim();
			const resumeValue = contact.properties?.resume;

			if (!email) {
				missingEmail += 1;
				skipped += 1;
				continue;
			}

			if (!resumeValue) {
				missingHubSpotResume += 1;
				skipped += 1;
				continue;
			}

			const candidateId = await findCandidateIdByEmail(
				bullhornSession,
				email,
			);
			if (!candidateId) {
				missingBullhornCandidate += 1;
				skipped += 1;
				continue;
			}

			const resumeState = await hasBullhornResume(
				bullhornSession,
				candidateId,
			);
			if (resumeState.hasResume) {
				bullhornAlreadyHadResume += 1;
				skipped += 1;
				console.log(
					"resumeSync:backfill: candidate already has Bullhorn resume",
					{
						contactId,
						candidateId,
					},
				);
				continue;
			}

			syncableContactIds.push(contactId);
		} catch (error) {
			failed += 1;
			console.error("resumeSync:backfill: contact screening failed", {
				contactId,
				message: error.message,
				status: error.response?.status,
				data: error.response?.data,
			});
		}
	}

	console.log("resumeSync:backfill: screening summary", {
		total: cappedContactIds.length,
		syncable: syncableContactIds.length,
		missingEmail,
		missingHubSpotResume,
		missingBullhornCandidate,
		bullhornAlreadyHadResume,
		failed,
	});

	for (let i = 0; i < syncableContactIds.length; i += batchSize) {
		const batch = syncableContactIds.slice(i, i + batchSize).map((objectId) => ({
			objectId,
		}));

		console.log("resumeSync:backfill: processing batch", {
			start: i,
			count: batch.length,
		});

		const result = await handler({
			httpMethod: "POST",
			isBase64Encoded: false,
			body: JSON.stringify(batch),
			headers: process.env.RESUME_SYNC_API_KEY
				? { "resume-sync-api-key": process.env.RESUME_SYNC_API_KEY }
				: {},
		});

		const payload = result?.body ? JSON.parse(result.body) : {};
		for (const item of payload.results || []) {
			if (item?.error) {
				failed += 1;
			} else if (item?.skipped) {
				skipped += 1;
			} else {
				processed += 1;
			}
		}
	}

	console.log("resumeSync:backfill: complete", {
		processed,
		skipped,
		failed,
		total: syncableContactIds.length,
	});
}

async function searchContactsSince({ client, property, sinceMillis, limit }) {
	const contactIds = [];
	let after = undefined;

	while (true) {
		const response = await client.crm.contacts.searchApi.doSearch({
			filterGroups: [
				{
					filters: [
						{
							propertyName: property,
							operator: "GTE",
							value: sinceMillis.toString(),
						},
					],
				},
			],
			properties: SYNC_PROPERTIES,
			limit: 100,
			after,
		});

		for (const result of response.results || []) {
			if (result.id) {
				contactIds.push(Number.parseInt(result.id, 10));
			}
		}

		if (limit && contactIds.length >= limit) {
			break;
		}

		if (!response.paging?.next?.after) {
			break;
		}

		after = response.paging.next.after;
	}

	return Array.from(new Set(contactIds)).filter(Boolean);
}

async function scanContactsSince({ client, property, sinceMillis, limit }) {
	const contactIds = [];
	const properties = Array.from(new Set([...SYNC_PROPERTIES, property]));
	let after = undefined;

	while (true) {
		const response = await client.crm.contacts.basicApi.getPage(
			100,
			after,
			properties,
		);

		for (const contact of response.results || []) {
			const rawValue = contact?.properties?.[property];
			const contactMillis = normalizeDateTimeValue(rawValue);
			if (contact.id && contactMillis !== null && contactMillis >= sinceMillis) {
				contactIds.push(Number.parseInt(contact.id, 10));
			}
		}

		if (limit && contactIds.length >= limit) {
			break;
		}

		if (!response.paging?.next?.after) {
			break;
		}

		after = response.paging.next.after;
	}

	return Array.from(new Set(contactIds)).filter(Boolean);
}

function normalizeDateTimeValue(value) {
	if (value === null || value === undefined || value === "") {
		return null;
	}

	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}

	const trimmed = String(value).trim();
	if (!trimmed) {
		return null;
	}

	const asNumber = Number(trimmed);
	if (Number.isFinite(asNumber)) {
		return asNumber;
	}

	const asDate = Date.parse(trimmed);
	return Number.isNaN(asDate) ? null : asDate;
}

main().catch((error) => {
	console.error("resumeSync:backfill failed:", error);
	process.exitCode = 1;
});
