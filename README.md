# Followup

A localhost-first follow-up queue for the Attio **Outbound Pipeline**. It scopes work by Attio owner, prioritizes the agreed SOP, shows the associated people and company notes, routes verified SendPilot campaign conversations through their owning LinkedIn sender, opens prefilled email drafts in Gmail or Outlook, and stores plain-text templates locally.

This directory is the complete project and an independent Git repository. Application code, tests, local runtime data, operational scripts, and integration references all live here.

## Project layout

- `src/` — Attio, Unipile, queue, and local-store modules
- `tests/` — unit, API, and browser tests
- `scripts/` — live audit and operational audit utilities
- `docs/integration/` — Attio/Unipile workflow references
- `data/` — local SQLite state and templates (ignored by Git)

## Run it

Requires Node.js 24 or newer.

```bash
npm install
npm start
```

Open `http://127.0.0.1:4317`. The server reads `ATTIO_API_KEY`, `SENDPILOT_API_KEY`, `UNIPILE_API_KEY`, and `UNIPILE_DSN` from the operating-system environment or an optional local `.env` file. Credentials never reach the browser.

To use safe fixture data instead of Attio and SendPilot:

```bash
npm run start:mock
```

## Workflow behavior

The queue is ordered as:

1. Unprocessed
2. Qualified where `Last Interaction By = Them`
3. Meeting Booked + `First Meeting = No show` where `Last Interaction Date` is strictly before two days ago
4. Qualified follow-ups where `Last Interaction Date` is strictly before two days ago

Dates use `Asia/Tbilisi` and match Attio's strict `before 2 days ago` relative-date boundary: the date exactly two days ago is excluded. A successful Unipile send advances the local card but Attio remains authoritative. Every sync safely promotes `Unprocessed` to `Qualified` only when Attio itself says the last interaction is from us.

The first live sync may therefore promote existing Unprocessed records whose current Attio interaction direction is already `Us`. The read-only audit reports this count before first use with `npm run audit:live`.

LinkedIn routing is fail-closed and independent of the contact's Attio source. Every queue contact is checked against SendPilot. A card can send through SendPilot when it has an eligible SendPilot lead and a verified existing conversation owner; its campaign may be started, paused, or historical because these are deliberate one-off replies rather than automated sequence steps. If several eligible historical leads exist, the app deterministically prefers a started campaign, then a paused campaign, then the most recently updated candidate. If multiple sender-owned conversations exist, the composer shows each one and requires an explicit sender choice. After a successful SendPilot follow-up, the app marks the selected campaign lead `DONE` so no later sequence step should be sent. Unverified matches remain **Manual**; their message is copied and the contact's native LinkedIn profile opens for a manual send. Email opens a recipient, subject, and message form in the app, can reuse any saved template, then launches a prefilled Gmail draft in a new tab. Set `EMAIL_COMPOSER_PROVIDER=outlook` to use Outlook on the web instead. Opening a draft does not send the email or complete the card. The app waits for Attio's normal sync or a deliberate manual repair.

Email actions first perform a read-only Gmail lookup using the selected rep's allowlisted mailbox or mailboxes. An existing exact-participant match opens the newest matching Gmail thread so the rep can reply in context; no match opens the new-draft form. Thread results are cached for one hour. Sandro searches `sandro@stimuli.digital`; Sergi searches both `sergi@stimuli.digital` and `sergi@revcode.app` and uses the newer match. Outlook composition remains available, but automatic thread lookup currently applies only to Gmail.

On startup, the app fetches the complete SendPilot conversation index and preloads routing and message previews for every contact in the queue. The browser then syncs Attio and rebuilds that cache once per hour. Opening cards, sending a message, and repairing an interaction do not trigger extra background syncs; the **Sync** button remains available for a deliberate refresh.

SendPilot remains the primary LinkedIn provider. When SendPilot finds an existing conversation but has no campaign lead at all, the hourly sync performs a targeted Unipile lookup. The fallback is offered only when Unipile independently resolves the Attio LinkedIn identity and finds an existing one-to-one chat owned by the same named sender. It never bypasses any SendPilot lead status and never starts a new chat automatically. The server authorizes the resolved route for one sync interval, then re-fetches the Unipile account and chat before sending to verify the connected account, sender ownership, attendee identity, and read-only state.

## Local data

Templates and send receipts live in `data/followup.sqlite`. This file is intentionally ignored by Git. Each computer has its own templates in the MVP.

Manual `Contacted by us` repair increments the pre-demo follow-up counter only when the previous direction was already `Us`, the date advances, and the company is still Unprocessed or Qualified. This mirrors the existing Gmail/LinkedIn counter definition rather than counting replies to prospects.

## Verification

```bash
npm run check
npm test
npx playwright install chromium
npm run test:e2e
```

`npm test` covers queue priority, strict relative-date boundaries, persistence, idempotency, repair semantics, and API behavior. The browser suite covers the rep selector, templates, sender resolution, LinkedIn send, Not qualified, forward/backward queue navigation, and progress UI. GitHub Actions runs all checks on every push and pull request.

`npm run audit:sendpilot-matching` performs a read-only live reconciliation across the queue. It reports SendPilot and Unipile-fallback coverage, sendable coverage, failure reasons, and which identity strategy produced each match, with bounded examples for investigation.

## Safety properties

- Only the active SendPilot accounts matching Sandro, Sergi, and Revaz are allowed LinkedIn senders, independently of Attio ownership.
- A SendPilot send requires an eligible lead and an explicitly selected, verified existing conversation owner; unsubscribed, blocked, irrelevant, skipped, inactive-sender, and unmatched records are manual-only.
- Campaign-lead and conversation ownership are checked again server-side before sending.
- SendPilot sends are never automatically retried.
- Unipile fallback sends require a sync-authorized existing chat, the same human sender as SendPilot, and a fresh server-side account and attendee verification. They never create a new chat.
- A durable idempotency receipt prevents duplicate sends from a repeated request.
- Attio writes fetch current state and patch only the intended field.
- API credentials stay server-side, and the server binds to localhost by default.
