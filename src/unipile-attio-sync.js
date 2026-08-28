export const LINKEDIN_ACCOUNTS = Object.freeze({
  "5Oe83EFfTgS7GDIScVXrPg": { repName: "Sandro", selfId: "ACoAAEbLafgBVt1BHLkVrKyprVfRMG6HIAScJ6k" },
  EmucfXukRDejlX7QvAw2GQ: { repName: "Sergi", selfId: "ACoAACdLDRcBDAmGHRg86rWWc2UGvZKZB-0IicQ" },
  "YcO4z477S8aHln4L-EIUGw": { repName: "Revaz", selfId: "ACoAADLD3rgByE78rqHVRjNyw9DiEm1_9v82288" },
});

export const COLD_CALLING = Object.freeze({
  listId: "7ac0b11c-204e-4c25-a744-e306606f6aa4",
  ownerId: "d9d9526a-9718-4861-a3b4-cc7e47f2b596",
  source: "Linkedin Campaign",
  notQualifiedStageId: "47a0e793-0d7d-47ae-b226-4a655fe48677",
  qualifiedStageId: "40b48a97-8ab7-48a5-9560-95f56778fc31",
});

const safeString = (value) => String(value ?? "").trim();

export function normalizeName(value) {
  return safeString(value)
    .normalize("NFKC")
    .replace(/[\p{Extended_Pictographic}\p{So}\p{Sk}\u{FE0F}\u{200D}]/gu, " ")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}.]+$/u, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en");
}

export function canonicalLinkedInUrl(value) {
  let raw = safeString(value);
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLocaleLowerCase("en").replace(/^www\./, "");
    if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return "";
    const parts = url.pathname.split("/").filter(Boolean);
    const index = parts.findIndex((part) => part.toLocaleLowerCase("en") === "in");
    if (index < 0 || !parts[index + 1]) return "";
    const slug = decodeURIComponent(parts[index + 1]).trim().toLocaleLowerCase("en");
    return slug ? `https://www.linkedin.com/in/${encodeURIComponent(slug)}` : "";
  } catch {
    return "";
  }
}

export function attachmentLabel(message) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  const attachment = attachments[0] || message?.attachment || null;
  const type = safeString(
    attachment?.type || attachment?.mime_type || attachment?.content_type || message?.attachment_type,
  ).split("/").pop();
  return type ? `[Attachment: ${type}]` : "[Attachment]";
}

function attendeeOccupation(attendee) {
  return safeString(attendee?.attendee_specifics?.occupation || attendee?.occupation || attendee?.headline);
}

function profileUrlOf(attendee) {
  return canonicalLinkedInUrl(
    attendee?.attendee_profile_url || attendee?.profile_url || attendee?.public_profile_url ||
      attendee?.attendee_public_identifier,
  );
}

export function normalizeUnipileEvent(payload, { now = new Date() } = {}) {
  const body = payload?.body || payload || {};
  const eventName = body.event || body.event_type;
  if (eventName && eventName !== "message_received") return { proceed: false, skipReason: `event: ${eventName}` };
  if (safeString(body.account_type).toUpperCase() !== "LINKEDIN") return { proceed: false, skipReason: "not linkedin" };

  const account = LINKEDIN_ACCOUNTS[body.account_id];
  if (!account) return { proceed: false, skipReason: "account out of scope" };
  const attendees = Array.isArray(body.attendees) ? body.attendees : [];
  if (body.is_group === true || body.is_group === 1 || attendees.length > 2) {
    return { proceed: false, skipReason: "not a 1:1 thread" };
  }

  const messageId = safeString(body.message_id || body.id);
  const chatId = safeString(body.chat_id);
  if (!messageId || !chatId) return { proceed: false, skipReason: "missing chat or message id" };

  const selfId = safeString(body.account_info?.user_id) || account.selfId;
  let direction;
  if (body.is_sender === 1 || body.is_sender === true) direction = "outbound";
  else if (body.is_sender === 0 || body.is_sender === false) direction = "inbound";
  else direction = safeString(body.sender?.attendee_provider_id) === selfId ? "outbound" : "inbound";

  const counterpart = attendees.find((attendee) =>
    safeString(attendee?.attendee_provider_id || attendee?.provider_id) !== selfId,
  ) || (direction === "inbound" ? body.sender : null) || {};
  const originalName = safeString(counterpart.attendee_name || counterpart.name);
  const displayName = originalName.replace(/\s+/g, " ").trim();
  const urn = safeString(counterpart.attendee_provider_id || counterpart.provider_id);
  const profileUrl = profileUrlOf(counterpart);
  if (!urn && !profileUrl && !displayName) return { proceed: false, skipReason: "counterpart has no usable identity" };

  const rawText = safeString(body.message || body.text);
  const hasAttachment = Boolean(
    body.attachment || body.attachment_type || (Array.isArray(body.attachments) && body.attachments.length),
  );
  if (!rawText && !hasAttachment) return { proceed: false, skipReason: "empty event" };
  const timestamp = new Date(body.timestamp || now);
  if (Number.isNaN(timestamp.valueOf())) return { proceed: false, skipReason: "invalid timestamp" };

  const text = rawText || attachmentLabel(body);
  return {
    proceed: true,
    eventKey: `${body.account_id}:${messageId}`,
    accountId: body.account_id,
    chatId,
    messageId,
    timestamp: timestamp.toISOString(),
    direction,
    text,
    repName: account.repName,
    selfId,
    counterpart: {
      urn,
      profileUrl,
      name: displayName,
      originalName,
      normalizedName: normalizeName(displayName),
      occupation: attendeeOccupation(counterpart),
    },
    originalPayloadRef: {
      event: eventName || "message_received",
      accountId: body.account_id,
      chatId,
      messageId,
    },
  };
}

function firstValue(record, slug) {
  return (record?.values?.[slug] || [])[0] || {};
}

export function attioPersonIdentity(record) {
  const name = safeString(firstValue(record, "name").full_name || firstValue(record, "name").value);
  const urn = safeString(firstValue(record, "linkedin_urn").value);
  const profileUrl = canonicalLinkedInUrl(firstValue(record, "linkedin").value || firstValue(record, "linkedin").url);
  const companies = (record?.values?.company || []).map((value) => value.target_record_id).filter(Boolean);
  return {
    id: record?.id?.record_id || record?.id || "",
    name,
    normalizedName: normalizeName(name),
    urn,
    profileUrl,
    companyIds: [...new Set(companies)],
  };
}

export function namesArePartial(left, right) {
  const a = normalizeName(left).split(" ").filter(Boolean);
  const b = normalizeName(right).split(" ").filter(Boolean);
  if (a.length < 2 || b.length < 2 || a[0] !== b[0]) return false;
  const tailA = a.slice(1).join(" ");
  const tailB = b.slice(1).join(" ");
  return tailA === tailB || tailA.startsWith(tailB) || tailB.startsWith(tailA) ||
    (tailA.length === 1 && tailB.startsWith(tailA)) || (tailB.length === 1 && tailA.startsWith(tailB));
}

function identityConflicts(incoming, candidate) {
  const conflicts = [];
  if (incoming.urn && candidate.urn && incoming.urn !== candidate.urn) conflicts.push("linkedin_urn");
  const incomingProfileUrl = canonicalLinkedInUrl(incoming.profileUrl);
  if (incomingProfileUrl && candidate.profileUrl && incomingProfileUrl !== candidate.profileUrl) {
    conflicts.push("linkedin_profile_url");
  }
  return conflicts;
}

export function resolveIdentity(incoming, records) {
  const candidates = records.map(attioPersonIdentity).filter((candidate) => candidate.id);
  const urnMatches = incoming.urn ? candidates.filter((candidate) => candidate.urn === incoming.urn) : [];
  if (urnMatches.length === 1) return acceptedIdentity("urn", incoming, urnMatches[0]);
  if (urnMatches.length > 1) return reviewIdentity("conflicting_urn_candidates", incoming, urnMatches);

  const urlMatches = incoming.profileUrl
    ? candidates.filter((candidate) => candidate.profileUrl === canonicalLinkedInUrl(incoming.profileUrl))
    : [];
  if (urlMatches.length === 1) {
    const conflicts = identityConflicts(incoming, urlMatches[0]);
    return conflicts.length ? reviewIdentity("identity_conflict", incoming, urlMatches) : acceptedIdentity("profile_url", incoming, urlMatches[0]);
  }
  if (urlMatches.length > 1) return reviewIdentity("conflicting_profile_candidates", incoming, urlMatches);

  const normalized = normalizeName(incoming.name);
  const exactNames = normalized ? candidates.filter((candidate) => candidate.normalizedName === normalized) : [];
  if (exactNames.length === 1) {
    const conflicts = identityConflicts(incoming, exactNames[0]);
    return conflicts.length ? reviewIdentity("identity_conflict", incoming, exactNames) : acceptedIdentity("exact_name", incoming, exactNames[0]);
  }
  if (exactNames.length > 1) return reviewIdentity("ambiguous_exact_name", incoming, exactNames);

  const partial = incoming.name ? candidates.filter((candidate) => namesArePartial(incoming.name, candidate.name)) : [];
  if (partial.length) return reviewIdentity("partial_name", incoming, partial);
  return { status: "unmatched", matchBy: null, candidate: null, candidates: [], conflicts: [], identityPatch: {} };
}

function acceptedIdentity(matchBy, incoming, candidate) {
  const identityPatch = {};
  if (incoming.urn && !candidate.urn) identityPatch.linkedin_urn = incoming.urn;
  if (incoming.profileUrl && !candidate.profileUrl) identityPatch.linkedin = canonicalLinkedInUrl(incoming.profileUrl);
  return { status: "matched", matchBy, candidate, candidates: [candidate], conflicts: [], identityPatch };
}

function reviewIdentity(reason, incoming, candidates) {
  return {
    status: "needs_review",
    reason,
    matchBy: null,
    candidate: null,
    candidates,
    conflicts: candidates.flatMap((candidate) => identityConflicts(incoming, candidate).map((field) => ({ candidateId: candidate.id, field }))),
    identityPatch: {},
  };
}

export function boundedDeepSeekRequest(incoming, candidates) {
  return {
    model: "deepseek-chat",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "Rank only the supplied Attio candidates. Never approve or recommend an automatic merge. Return JSON only.",
      },
      {
        role: "user",
        content: JSON.stringify({
          incoming: {
            name: incoming.name || "", urn: incoming.urn || "", profile_url: incoming.profileUrl || "",
            occupation: incoming.occupation || "",
          },
          candidates: candidates.map((candidate) => ({
            attio_person_id: candidate.id, name: candidate.name, urn: candidate.urn,
            profile_url: candidate.profileUrl, company_ids: candidate.companyIds,
          })),
          required_schema: {
            ranked_candidate_ids: ["attio-person-id"], evidence: [{ candidate_id: "attio-person-id", reasons: ["string"] }],
            conflicts: [{ candidate_id: "attio-person-id", fields: ["string"] }], no_match_explanation: "string",
          },
        }),
      },
    ],
  };
}

export function validateDeepSeekRanking(value, allowedCandidateIds) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  const allowed = new Set(allowedCandidateIds);
  if (!parsed || !Array.isArray(parsed.ranked_candidate_ids) || !Array.isArray(parsed.evidence) || !Array.isArray(parsed.conflicts)) {
    throw new Error("DeepSeek response does not match the required schema");
  }
  if (parsed.ranked_candidate_ids.some((id) => !allowed.has(id))) throw new Error("DeepSeek returned an out-of-bounds candidate");
  return {
    rankedCandidateIds: [...new Set(parsed.ranked_candidate_ids)],
    evidence: parsed.evidence.filter((item) => allowed.has(item?.candidate_id)),
    conflicts: parsed.conflicts.filter((item) => allowed.has(item?.candidate_id)),
    noMatchExplanation: safeString(parsed.no_match_explanation),
  };
}

export function resolveCompany({ domain, name }, companies) {
  const canonicalDomain = safeString(domain).toLocaleLowerCase("en").replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  const normalizedName = normalizeName(name);
  const identities = companies.map((company) => {
    const domains = (company?.values?.domains || []).map((value) =>
      safeString(value.domain || value.value).toLocaleLowerCase("en").replace(/^www\./, ""),
    );
    const companyName = safeString(firstValue(company, "name").value);
    return { id: company?.id?.record_id || company?.id, name: companyName, normalizedName: normalizeName(companyName), domains };
  });
  const domainMatches = canonicalDomain ? identities.filter((company) => company.domains.includes(canonicalDomain)) : [];
  if (domainMatches.length === 1) return { status: "matched", matchBy: "domain", company: domainMatches[0] };
  if (domainMatches.length > 1) return { status: "ambiguous", matchBy: "domain", candidates: domainMatches };
  const nameMatches = normalizedName ? identities.filter((company) => company.normalizedName === normalizedName) : [];
  if (nameMatches.length === 1) return { status: "matched", matchBy: "name", company: nameMatches[0] };
  if (nameMatches.length > 1) return { status: "ambiguous", matchBy: "name", candidates: nameMatches };
  return { status: "unmatched", matchBy: null, candidates: [] };
}

export function eventLedgerDecision(rows, { now = new Date(), staleAfterMs = 10 * 60 * 1000 } = {}) {
  if (!rows.length) return { process: true, reason: "new", attempts: 1, completedSteps: [] };
  const ordered = [...rows].sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
  const canonical = ordered[0];
  if (canonical.status === "completed") return { process: false, reason: "completed", canonical, duplicateRowIds: ordered.slice(1).map((row) => row.id) };
  const stale = canonical.status !== "processing" || now.valueOf() - new Date(canonical.updated_at || 0).valueOf() >= staleAfterMs;
  if (!stale) return { process: false, reason: "already_processing", canonical, duplicateRowIds: ordered.slice(1).map((row) => row.id) };
  let completedSteps = [];
  try { completedSteps = JSON.parse(canonical.completed_steps || "[]"); } catch { completedSteps = []; }
  return {
    process: true,
    reason: canonical.status === "failed" ? "retry_failed" : "resume_stale",
    attempts: Number(canonical.attempts || 0) + 1,
    completedSteps,
    canonical,
    duplicateRowIds: ordered.slice(1).map((row) => row.id),
  };
}

export function applyEventTimeGuard(state, event) {
  const incoming = new Date(event.timestamp).valueOf();
  const committed = state?.newest_committed_at ? new Date(state.newest_committed_at).valueOf() : Number.NEGATIVE_INFINITY;
  return {
    shouldAdvance: Number.isFinite(incoming) && incoming > committed,
    newestCommittedAt: incoming > committed ? event.timestamp : state?.newest_committed_at || null,
    direction: incoming > committed ? event.direction : state?.last_direction || null,
  };
}

export function mergeCase(caseRow, event) {
  let eventKeys = [];
  try { eventKeys = JSON.parse(caseRow?.event_keys || "[]"); } catch { eventKeys = []; }
  const isNewEvent = !eventKeys.includes(event.eventKey);
  if (isNewEvent) eventKeys.push(event.eventKey);
  return {
    eventKeys,
    messageCount: Number(caseRow?.message_count || 0) + (isNewEvent ? 1 : 0),
    latestPreview: event.text.slice(0, 500),
  };
}

export function dedupeAndSortMessages(messages, { cap = 10_000 } = {}) {
  const unique = new Map();
  for (const message of messages) {
    const id = safeString(message.id || message.message_id);
    if (!id || unique.has(id)) continue;
    const text = safeString(message.text || message.message);
    unique.set(id, { ...message, id, text: text || attachmentLabel(message) });
  }
  const sorted = [...unique.values()].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return { messages: sorted.slice(Math.max(0, sorted.length - cap)), truncated: sorted.length > cap, totalUnique: sorted.length };
}

export function buildTranscript(messages, { repName, counterpartName, timeZone = "Asia/Tbilisi" } = {}) {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  return messages.map((message) => {
    const parts = Object.fromEntries(format.formatToParts(new Date(message.timestamp)).map((part) => [part.type, part.value]));
    const stamp = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
    const sender = message.is_sender === 1 || message.isSender === true ? repName : counterpartName;
    return `${stamp} · ${sender}: ${safeString(message.text) || attachmentLabel(message)}`;
  }).join("\n");
}

export function transcriptSaga({ oldNoteId, newNoteId, pointerUpdated, oldNoteDeleted }) {
  if (!newNoteId) return { status: "failed", retry: "create_replacement", canonicalNoteId: oldNoteId || "" };
  if (!pointerUpdated) return { status: "compensate", deleteNoteId: newNoteId, canonicalNoteId: oldNoteId || "" };
  if (oldNoteId && !oldNoteDeleted) return { status: "cleanup_pending", deleteNoteId: oldNoteId, canonicalNoteId: newNoteId };
  return { status: "committed", canonicalNoteId: newNoteId };
}

export function buildIdentityReviewCard({ caseKey, event, ranking, actionBaseUrl, channel = "C0BQ53M5JKF" }) {
  const top = ranking.rankedCandidateIds?.[0] || "";
  const payload = encodeURIComponent(JSON.stringify({ caseKey, eventKey: event.eventKey, candidateId: top }));
  const base = `${actionBaseUrl}?p=${payload}`;
  return {
    channel,
    text: `Identity review: ${event.counterpart.name || "unknown"}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*Possible Attio identity match*\n${event.counterpart.name || "Unknown"} · ${event.counterpart.occupation || "No headline"}` } },
      { type: "section", text: { type: "mrkdwn", text: `>${event.text.replace(/\n/g, "\n>").slice(0, 500)}` } },
      { type: "actions", elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: "Same person" }, url: `${base}&a=same_person` },
        { type: "button", style: "danger", text: { type: "plain_text", text: "Different person" }, url: `${base}&a=different_person` },
      ] },
    ],
  };
}

export function buildQualificationCard({ caseKey, event, personName, companyName, evidence, actionBaseUrl, channel = "C0BQ53M5JKF" }) {
  const payload = encodeURIComponent(JSON.stringify({ caseKey, eventKey: event.eventKey }));
  const base = `${actionBaseUrl}?p=${payload}`;
  const details = [event.counterpart.profileUrl, event.counterpart.occupation, evidence].filter(Boolean).join(" · ");
  return {
    channel,
    text: `Qualification required: ${personName || event.counterpart.name || "unknown"}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*Qualification required*\n${personName || event.counterpart.name || "Unknown"} · ${companyName || "Company unresolved"}` } },
      { type: "section", text: { type: "mrkdwn", text: `>${event.text.replace(/\n/g, "\n>").slice(0, 500)}` } },
      ...(details ? [{ type: "context", elements: [{ type: "mrkdwn", text: details.slice(0, 1500) }] }] : []),
      { type: "actions", elements: [
        { type: "button", style: "danger", text: { type: "plain_text", text: "Not qualified" }, url: `${base}&a=not_qualified` },
        { type: "button", style: "primary", text: { type: "plain_text", text: "Qualified" }, url: `${base}&a=qualified` },
      ] },
    ],
  };
}
