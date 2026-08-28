import test from "node:test";
import assert from "node:assert/strict";

import {
  applyEventTimeGuard,
  attachmentLabel,
  boundedDeepSeekRequest,
  buildIdentityReviewCard,
  buildQualificationCard,
  canonicalLinkedInUrl,
  dedupeAndSortMessages,
  eventLedgerDecision,
  mergeCase,
  normalizeName,
  normalizeUnipileEvent,
  resolveCompany,
  resolveIdentity,
  transcriptSaga,
  validateDeepSeekRanking,
} from "../src/unipile-attio-sync.js";

const person = ({ id, name, urn = "", linkedin = "", companyId = "" }) => ({
  id: { record_id: id },
  values: {
    name: [{ full_name: name }],
    linkedin_urn: urn ? [{ value: urn }] : [],
    linkedin: linkedin ? [{ value: linkedin }] : [],
    company: companyId ? [{ target_record_id: companyId }] : [],
  },
});

const eventPayload = (overrides = {}) => ({
  event_type: "message_received",
  account_type: "LINKEDIN",
  account_id: "5Oe83EFfTgS7GDIScVXrPg",
  message_id: "m-1",
  chat_id: "chat-1",
  timestamp: "2026-08-27T08:00:00.000Z",
  is_sender: false,
  message: "Interested — tell me more",
  attendees: [
    { attendee_provider_id: "ACoAAEbLafgBVt1BHLkVrKyprVfRMG6HIAScJ6k", attendee_name: "Sandro" },
    {
      attendee_provider_id: "urn-hamza",
      attendee_name: "  ✨ Hamza   Ahmed ",
      attendee_profile_url: "https://linkedin.com/in/Hamza-Ahmed/?trk=foo",
      attendee_specifics: { occupation: "Founder at Example" },
    },
  ],
  ...overrides,
});

test("normalizes decorated names and canonical LinkedIn URLs", () => {
  assert.equal(normalizeName("  ✨ Hamza   Ahmed "), "hamza ahmed");
  assert.equal(canonicalLinkedInUrl("linkedin.com/in/Hamza-Ahmed/?trk=foo"), "https://www.linkedin.com/in/hamza-ahmed");
});

test("normalizes a live event without requiring a URN", () => {
  const payload = eventPayload({
    attendees: [
      { attendee_provider_id: "ACoAAEbLafgBVt1BHLkVrKyprVfRMG6HIAScJ6k", attendee_name: "Sandro" },
      { attendee_name: "Hamza Ahmed", attendee_profile_url: "https://www.linkedin.com/in/hamza-a" },
    ],
  });
  const event = normalizeUnipileEvent(payload);
  assert.equal(event.proceed, true);
  assert.equal(event.eventKey, "5Oe83EFfTgS7GDIScVXrPg:m-1");
  assert.equal(event.counterpart.urn, "");
  assert.equal(event.counterpart.profileUrl, "https://www.linkedin.com/in/hamza-a");
});

test("preserves attachment-only events", () => {
  const payload = eventPayload({ message: "", attachments: [{ type: "image" }] });
  const event = normalizeUnipileEvent(payload);
  assert.equal(event.proceed, true);
  assert.equal(event.text, "[Attachment: image]");
  assert.equal(attachmentLabel({ attachments: [{}] }), "[Attachment]");
});

test("keeps the account allowlist and one-to-one restriction", () => {
  assert.equal(normalizeUnipileEvent(eventPayload({ account_id: "outside" })).proceed, false);
  assert.equal(normalizeUnipileEvent(eventPayload({ is_group: true })).proceed, false);
});

test("matches by URN, then profile URL, then unique exact normalized name", () => {
  const records = [
    person({ id: "p1", name: "Another Person", urn: "urn-hamza" }),
    person({ id: "p2", name: "Profile Person", linkedin: "https://www.linkedin.com/in/profile-person" }),
    person({ id: "p3", name: "  Hamza Ahmed " }),
  ];
  assert.equal(resolveIdentity({ urn: "urn-hamza", name: "Whatever" }, records).candidate.id, "p1");
  assert.equal(resolveIdentity({ profileUrl: "linkedin.com/in/Profile-Person/", name: "Whatever" }, records).candidate.id, "p2");
  const exact = resolveIdentity({ name: "✨ Hamza   Ahmed", urn: "new-urn" }, records);
  assert.equal(exact.candidate.id, "p3");
  assert.deepEqual(exact.identityPatch, { linkedin_urn: "new-urn" });
});

test("never overwrites conflicting identity automatically", () => {
  const result = resolveIdentity(
    { name: "Hamza Ahmed", urn: "incoming-urn", profileUrl: "https://www.linkedin.com/in/incoming" },
    [person({ id: "p1", name: "Hamza Ahmed", urn: "other-urn", linkedin: "https://www.linkedin.com/in/other" })],
  );
  assert.equal(result.status, "needs_review");
  assert.deepEqual(result.conflicts.map((conflict) => conflict.field).sort(), ["linkedin_profile_url", "linkedin_urn"]);
  assert.deepEqual(result.identityPatch, {});
});

test("partial names require bounded review", () => {
  const result = resolveIdentity({ name: "Hamza A" }, [
    person({ id: "p1", name: "Hamza Ahmed" }),
    person({ id: "p2", name: "Hamza Ali" }),
    person({ id: "p3", name: "Other Person" }),
  ]);
  assert.equal(result.status, "needs_review");
  assert.equal(result.reason, "partial_name");
  assert.deepEqual(result.candidates.map((candidate) => candidate.id), ["p1", "p2"]);

  const request = boundedDeepSeekRequest({ name: "Hamza A" }, result.candidates);
  const supplied = JSON.parse(request.messages[1].content).candidates;
  assert.deepEqual(supplied.map((candidate) => candidate.attio_person_id), ["p1", "p2"]);
  assert.throws(() => validateDeepSeekRanking({ ranked_candidate_ids: ["p3"], evidence: [], conflicts: [] }, ["p1", "p2"]));
});

test("DeepSeek structured JSON is validated and cannot introduce candidates", () => {
  const result = validateDeepSeekRanking(JSON.stringify({
    ranked_candidate_ids: ["p2", "p1"],
    evidence: [{ candidate_id: "p2", reasons: ["matching initial"] }],
    conflicts: [],
    no_match_explanation: "",
  }), ["p1", "p2"]);
  assert.deepEqual(result.rankedCandidateIds, ["p2", "p1"]);
});

test("company matching prefers exact domain and rejects ambiguous names", () => {
  const companies = [
    { id: { record_id: "c1" }, values: { name: [{ value: "Acme" }], domains: [{ domain: "acme.test" }] } },
    { id: { record_id: "c2" }, values: { name: [{ value: "Acme" }], domains: [{ domain: "other.test" }] } },
  ];
  assert.equal(resolveCompany({ domain: "https://www.acme.test/path", name: "Acme" }, companies).company.id, "c1");
  assert.equal(resolveCompany({ name: "Acme" }, companies).status, "ambiguous");
});

test("only completed events are ignored; failed and stale events resume", () => {
  const now = new Date("2026-08-27T12:00:00.000Z");
  assert.equal(eventLedgerDecision([{ status: "completed", updated_at: now.toISOString() }], { now }).process, false);
  const failed = eventLedgerDecision([{ status: "failed", attempts: 2, completed_steps: '["identity"]', updated_at: now.toISOString() }], { now });
  assert.equal(failed.process, true);
  assert.equal(failed.attempts, 3);
  assert.deepEqual(failed.completedSteps, ["identity"]);
  assert.equal(eventLedgerDecision([{ status: "processing", updated_at: "2026-08-27T11:00:00.000Z" }], { now }).reason, "resume_stale");
  assert.equal(eventLedgerDecision([{ status: "processing", updated_at: "2026-08-27T11:59:00.000Z" }], { now }).process, false);
});

test("event-time guard prevents delayed events from moving state backward", () => {
  const old = applyEventTimeGuard(
    { newest_committed_at: "2026-08-27T10:00:00.000Z", last_direction: "inbound" },
    { timestamp: "2026-08-27T09:00:00.000Z", direction: "outbound" },
  );
  assert.equal(old.shouldAdvance, false);
  assert.equal(old.direction, "inbound");
});

test("later unresolved messages aggregate into one case", () => {
  const first = mergeCase({ message_count: 1, event_keys: '["a:m1"]' }, { eventKey: "a:m2", text: "second" });
  assert.equal(first.messageCount, 2);
  assert.deepEqual(first.eventKeys, ["a:m1", "a:m2"]);
  const repeated = mergeCase({ message_count: 2, event_keys: JSON.stringify(first.eventKeys) }, { eventKey: "a:m2", text: "second" });
  assert.equal(repeated.messageCount, 2);
});

test("history pagination output is deduplicated, chronological, capped, and attachment-safe", () => {
  const history = dedupeAndSortMessages([
    { id: "m2", timestamp: "2026-08-27T11:00:00Z", attachments: [{ mime_type: "image/png" }] },
    { id: "m1", timestamp: "2026-08-27T10:00:00Z", text: "hello" },
    { id: "m1", timestamp: "2026-08-27T10:00:00Z", text: "duplicate" },
  ], { cap: 1 });
  assert.equal(history.truncated, true);
  assert.equal(history.totalUnique, 2);
  assert.equal(history.messages[0].id, "m2");
  assert.equal(history.messages[0].text, "[Attachment: png]");
});

test("transcript replacement is failure-atomic at every swap point", () => {
  assert.deepEqual(transcriptSaga({ oldNoteId: "old" }), { status: "failed", retry: "create_replacement", canonicalNoteId: "old" });
  assert.deepEqual(transcriptSaga({ oldNoteId: "old", newNoteId: "new", pointerUpdated: false }), {
    status: "compensate", deleteNoteId: "new", canonicalNoteId: "old",
  });
  assert.deepEqual(transcriptSaga({ oldNoteId: "old", newNoteId: "new", pointerUpdated: true, oldNoteDeleted: false }), {
    status: "cleanup_pending", deleteNoteId: "old", canonicalNoteId: "new",
  });
  assert.equal(transcriptSaga({ oldNoteId: "old", newNoteId: "new", pointerUpdated: true, oldNoteDeleted: true }).status, "committed");
});

test("Slack cards expose only the required decision buttons", () => {
  const event = normalizeUnipileEvent(eventPayload());
  const review = buildIdentityReviewCard({
    caseKey: "a:c:identity", event, ranking: { rankedCandidateIds: ["p1"] }, actionBaseUrl: "https://example.test/action",
  });
  assert.deepEqual(review.blocks.at(-1).elements.map((button) => button.text.text), ["Same person", "Different person"]);
  const qualification = buildQualificationCard({
    caseKey: "a:c:company", event, personName: "Hamza Ahmed", companyName: "Acme", actionBaseUrl: "https://example.test/action",
  });
  assert.deepEqual(qualification.blocks.at(-1).elements.map((button) => button.text.text), ["Not qualified", "Qualified"]);
});
