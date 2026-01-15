"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const { handler } = require("../netlify/functions/resumeSync");

function parseArgs(argv) {
  const args = { payloadPath: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === "-p" || arg === "--payload") && argv[i + 1]) {
      args.payloadPath = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function loadPayload(payloadPath) {
  if (!payloadPath) {
    return [
      {
        subscriptionType: "object.propertyChange",
        objectId: 100133051,
        propertyName: "resume",
      },
    ];
  }

  const resolved = path.resolve(process.cwd(), payloadPath);
  const raw = fs.readFileSync(resolved, "utf8");
  return JSON.parse(raw);
}

async function run() {
  const { payloadPath } = parseArgs(process.argv);
  const payload = loadPayload(payloadPath);

  const event = {
    httpMethod: "POST",
    isBase64Encoded: false,
    body: JSON.stringify(payload),
  };

  const result = await handler(event);
  const body = result?.body ? JSON.parse(result.body) : null;

  console.log("statusCode:", result?.statusCode);
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
