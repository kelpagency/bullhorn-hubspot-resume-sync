# Resume Sync Client Guide

This document explains how the HubSpot to Bullhorn resume sync works at a high
level.

## Overview

When a candidate submits the **Talent Registration Form** in HubSpot, a HubSpot
Workflow is triggered. That workflow sends the candidate’s HubSpot contact ID to
our Netlify webhook as a `POST` request.

The webhook then uses that contact ID to look up the full HubSpot contact record,
find the matching Bullhorn candidate, and sync the relevant data into Bullhorn.

## Trigger Flow

1. A candidate submits the **Talent Registration Form** in HubSpot.
2. A HubSpot Workflow waits for that submission event.
3. When the workflow fires, it sends the HubSpot `contact ID` to the webhook URL
   as a `POST` request.
4. The Netlify function receives the request and performs the Bullhorn sync.

## What Gets Synced

The sync process can update two things in Bullhorn:

- **Resume file**: if the candidate has a resume in HubSpot, the file is
  downloaded from HubSpot and uploaded to the matching Bullhorn candidate.
- **Category / expertise fields**: if the candidate selected a category such as
  creative, content, marketing, technical, strategic/operational, or emerging,
  that selection is mirrored into Bullhorn.

## How Matching Works

The sync does not create a Bullhorn candidate from scratch.

Instead, it:

1. Uses the HubSpot contact ID to fetch the contact details from HubSpot.
2. Reads the candidate’s email address from HubSpot.
3. Finds the matching Bullhorn candidate by email.
4. Updates that Bullhorn candidate with the resume and category information.

## What Happens to the Resume

If a resume exists in HubSpot:

- The function resolves the HubSpot file.
- It downloads the file.
- It uploads the file into the Bullhorn candidate record.

If the resume is missing in HubSpot, no resume file is uploaded.

## What Happens to Categories

If the candidate selected one or more categories in HubSpot:

- The selected category is mapped to the corresponding Bullhorn category.
- Bullhorn is updated so the candidate is tagged consistently.

## Backfill / Missed Records

We also have a backfill process for missed or delayed syncs.

That process looks back through HubSpot contacts, checks Bullhorn to see whether
the candidate already has a resume, and only replays the sync for candidates
that still need one.

## What This Does Not Do

- It does not create a new Bullhorn candidate if no match is found.
- It does not overwrite an existing Bullhorn resume during the normal webhook
  flow.
- It does not move data in the opposite direction from Bullhorn back to HubSpot.

## Summary

The workflow is:

**HubSpot form submission** -> **HubSpot Workflow** -> **POST to webhook URL**
-> **Netlify sync function** -> **Bullhorn update**

This keeps HubSpot and Bullhorn aligned for new talent submissions without
manual copying.
