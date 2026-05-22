"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const { handler } = require("../netlify/functions/resumeSync");

function parseArgs(argv) {
  const args = {
    payloadPath: null,
    csvPath: null,
    csvColumn: "Record ID",
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === "-p" || arg === "--payload") && argv[i + 1]) {
      args.payloadPath = argv[i + 1];
      i += 1;
    } else if ((arg === "-c" || arg === "--csv") && argv[i + 1]) {
      args.csvPath = argv[i + 1];
      i += 1;
    } else if (arg === "--csv-column" && argv[i + 1]) {
      args.csvColumn = argv[i + 1];
      i += 1;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    }
  }
  return args;
}

function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      fields.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  fields.push(current);
  return fields;
}

function loadCsvPayload(csvPath, csvColumn) {
  const resolved = path.resolve(process.cwd(), csvPath);
  const raw = fs.readFileSync(resolved, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());

  if (!lines.length) {
    throw new Error(`CSV file is empty: ${csvPath}`);
  }

  const header = parseCsvLine(lines[0]).map((value) => value.trim());
  const columnIndex = header.indexOf(csvColumn);
  if (columnIndex === -1) {
    throw new Error(`CSV column not found: ${csvColumn}`);
  }

  const payload = [];
  for (const line of lines.slice(1)) {
    const fields = parseCsvLine(line);
    const rawContactId = String(fields[columnIndex] || "").trim();
    if (!rawContactId) {
      continue;
    }

    const objectId = Number.parseInt(rawContactId, 10);
    if (!Number.isFinite(objectId)) {
      throw new Error(`Invalid contact ID in CSV: ${rawContactId}`);
    }

    payload.push({ objectId });
  }

  return payload;
}

function loadPayload(payloadPath) {
  if (!payloadPath) {
    return [
      {
        objectId: 100133051,
      },
    ];
  }

  const resolved = path.resolve(process.cwd(), payloadPath);
  const raw = fs.readFileSync(resolved, "utf8");
  return JSON.parse(raw);
}

async function run() {
  const { payloadPath, csvPath, csvColumn, dryRun } = parseArgs(process.argv);
  const payload = csvPath
    ? loadCsvPayload(csvPath, csvColumn)
    : loadPayload(payloadPath);

  if (!payload.length) {
    throw new Error("No contact IDs were found to sync");
  }

  if (!process.env.RESUME_SYNC_API_KEY && process.env.RESUME_SYNC_SKIP_AUTH !== "true") {
    process.env.RESUME_SYNC_SKIP_AUTH = "true";
    console.warn("resumeSync:local: enabling RESUME_SYNC_SKIP_AUTH for local replay");
  }

  if (dryRun) {
    const preview = payload.slice(0, 20).map((entry) => entry.objectId);
    console.log("dry-run: no sync request was sent");
    console.log("contacts:", payload.length);
    console.log("preview:", preview);
    return;
  }

  const event = {
    httpMethod: "POST",
    isBase64Encoded: false,
    body: JSON.stringify(payload),
    headers: {},
  };
  if (process.env.RESUME_SYNC_API_KEY) {
    event.headers["resume-sync-api-key"] = process.env.RESUME_SYNC_API_KEY;
  }

  const result = await handler(event);
  const body = result?.body ? JSON.parse(result.body) : null;

  console.log("statusCode:", result?.statusCode);
  console.log("contacts:", payload.length);
  if (body) {
    console.log(JSON.stringify(body, null, 2));
  }

  if (result?.statusCode >= 400) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
