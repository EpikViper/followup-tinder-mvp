# Unipile → Attio Sync Remediation

## Summary

Replace the three active n8n paths with shared identity, company, deduplication, transcript, and recovery logic. Preserve their existing webhook URLs and schedules.

## Implementation Changes

### Identity matching

- Extract counterpart identity from `attendee_provider_id`, public `attendee_profile_url`, `attendee_name`, and occupation/headline. Do not require a URN to begin matching.
- Match in this order:
  1. Exact LinkedIn URN.
  2. Exact canonical LinkedIn profile URL.
  3. Unique exact normalized full name.
  4. Partial-name candidates, such as `Hamza Ahmed` versus `Hamza A`.
  5. Unmatched-person qualification flow.
- Normalize whitespace and decorations while retaining the original name for display.
- After a safe URL or unique full-name match, immediately add the missing URN/profile URL to the Attio person, independently of company or pipeline status.
- Never overwrite a conflicting URN or profile automatically.
- For conflicts and partial-name candidates, DeepSeek receives only the bounded Attio candidate set and returns structured JSON containing ranked candidate IDs, evidence, and conflicts. It cannot approve a merge.
- Send Slack a Same person / Different person decision:
  - **Same person:** revalidate the candidate, write the missing identity fields, and resume the original event.
  - **Different person:** leave the candidate unchanged and open the two-button qualification flow.

### Company and qualification

- Once a person is confirmed, inspect their linked Attio company.
- If no company is linked—or the linked company is not on the Cold Calling pipeline—send an inbound-only Slack card containing:
  - Person and resolved company names.
  - Incoming message.
  - Profile/headline and available company evidence.
  - Exactly two buttons: **Not qualified** and **Qualified**.
- Both buttons:
  - Reuse a company by exact domain first, then a unique normalized company name; ambiguous companies require review.
  - Otherwise create the company with verified best-effort information.
  - Reuse/update the person or create them, then link them to the company.
  - Add or reuse the company’s Cold Calling pipeline entry at the selected stage.
  - Set owner to Sandro Truman (`d9d9526a-9718-4861-a3b4-cc7e47f2b596`).
  - Set source to `Linkedin Campaign`.
  - Write last-interaction date and direction after the company and pipeline entry are confirmed.
  - Save the complete conversation transcript.
- Uncertain enrichment fields remain blank. Existing verified data is never replaced by weaker AI-derived data.
- Later inbound messages for the same unresolved case become replies under one Slack parent card; update its message count and latest preview.
- Slack actions are idempotent, revalidate current Attio state, and replace the card with the recorded outcome.

### Durable processing and atomic recovery

- Replace workflow static-data deduplication with n8n Data Tables:
  - Event ledger keyed by `account_id:message_id`.
  - Case ledger keyed by `account_id:chat_id:reason`.
  - Chat/company synchronization state containing the newest committed event timestamp.
- Track `processing`, `waiting_review`, `failed`, and `completed`, plus attempts, completed steps, outputs, and errors.
- Only completed events are ignored. Failed or stale events resume from their last committed step.
- All Attio mutations go through one shared mutation workflow; duplicate ledger rows are coalesced before processing.
- Apply event-time guards so delayed or retried messages cannot move interaction dates or directions backward.
- Make transcript replacement failure-atomic:
  1. Create the replacement note.
  2. Update the company’s chat-to-note pointer as the commit point.
  3. Delete the old note.
  4. If pointer update fails, delete the replacement and retain the old note.
  5. If old-note cleanup fails, retain the new canonical pointer and retry cleanup from the ledger.
- There is no cross-service database transaction; the durable saga guarantees recoverable, idempotent observable state.

### Live webhook and nightly reconciler

- The 15-minute SendPilot wait must rerun the shared resolver and resume the original event instead of silently skipping it.
- Both live and nightly paths must call the same identity and company resolver.
- Move nightly ambiguity resolution before “Needs Sync” filtering so it evaluates the complete candidate set.
- Nightly reconciliation repairs missed, failed, and incomplete ledger events rather than duplicating live matching rules.
- Paginate Unipile message history using cursors, deduplicate by message ID, and sort chronologically.
- Cap a single history load at 10,000 messages; flag and alert when truncated rather than describing it as complete.
- Preserve attachment-only events using `[Attachment: type]`, falling back to `[Attachment]`; they still update interaction state and appear in transcripts and Slack.
- Keep the current account allowlist and 1:1-thread restriction.
- Recent production deliveries showed no material delay, but retain timestamp guards as defensive protection.

## Interfaces

- DeepSeek must return validated structured JSON only:
  - Ranked Attio person IDs.
  - Match evidence.
  - Identity conflicts.
  - No-match explanation when applicable.
- DeepSeek credentials come from the Windows environment and are never logged or stored in workflow exports.
- Shared n8n subworkflows accept a normalized event envelope containing event key, account/chat/message IDs, timestamp, direction, text or attachment label, counterpart identity, and original payload reference.
- Preserve the existing Cold Calling list and stage IDs:
  - Not qualified: `47a0e793-0d7d-47ae-b226-4a655fe48677`
  - Qualified: `40b48a97-8ab7-48a5-9560-95f56778fc31`

## Test and Rollout

- Back up all three production workflow JSON definitions before modification.
- Build and test inactive shared workflows using sanitized fixtures, then update production workflows without changing webhook paths.
- Cover:
  - Missing URN with profile URL and/or attendee name.
  - Unique exact name with missing URN.
  - Conflicting existing URN/profile.
  - Abbreviated names requiring DeepSeek plus Slack approval.
  - Same/Different person actions and repeated button clicks.
  - Missing, existing, ambiguous, and non-pipeline companies.
  - Qualified and Not qualified entity creation.
  - Duplicate delivery, concurrent delivery, partial Attio failure, and retry.
  - Out-of-order events.
  - Attachment-only messages.
  - Multi-page history and truncation.
  - Every transcript-swap failure point.
  - Nightly recovery of missed and incomplete events.
- Run production smoke tests for each allowed LinkedIn account, verify Slack and Attio results, then enable the reconciler.
- Retain backups for immediate rollback and preserve all unrelated dirty repository changes.

## Assumptions

- DeepSeek only ranks candidates; every partial or conflicting identity requires Slack approval.
- Missing-company qualification alerts are inbound-only.
- Existing valid company/person records are reused rather than duplicated.
- Follow-up-count correction and stale linked-company validation remain unchanged, as requested.
