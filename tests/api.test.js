import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server.js";
import { EMAIL_SENDERS, REPS, LINKEDIN_SENDERS } from "../src/constants.js";

async function withServer(run, options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "followup-api-"));
  const instance = createApp({ mock: true, dataDir: dir, ...options });
  const server = await new Promise((resolve) => {
    const listener = instance.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, options = {}) => {
    const response = await fetch(`${base}${route}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const body = response.status === 204 ? null : await response.json();
    return { response, body };
  };
  try { await run({ request }); } finally {
    await new Promise((resolve) => server.close(resolve));
    instance.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("mock sync returns the four priority buckets in order", () => withServer(async ({ request }) => {
  const { response, body } = await request("/api/sync", { method: "POST", body: JSON.stringify({ ownerId: REPS[0].id }) });
  assert.equal(response.status, 200);
  assert.deepEqual(body.queue.map((item) => item.queueType), ["unprocessed", "inbound", "no_show", "follow_up"]);
  assert.deepEqual(body.queue.map((item) => item.companyName), ["Oyster", "Vanta", "Sana", "Pigment"]);
  const maya = body.queue.flatMap((company) => company.contacts).find((contact) => contact.id === "person-maya");
  assert.equal(maya.sendpilot.verified, true);
  assert.equal(maya.sendpilot.messages.length, 2);
  const sofia = body.queue.flatMap((company) => company.contacts).find((contact) => contact.id === "person-sofia");
  assert.equal(sofia.sendpilot.verified, true);
  assert.equal(sofia.sendpilot.senderName, "Sergi Cheishvili");
  const theo = body.queue.flatMap((company) => company.contacts).find((contact) => contact.id === "person-theo");
  assert.equal(theo.sendpilot.source, "unipile_fallback");
  assert.equal(theo.sendpilot.verified, true);
  assert.equal(theo.sendpilot.chatId, "chat-theo-sandro");
}));

test("sync interval is one hour", () => withServer(async ({ request }) => {
  const { body } = await request("/api/config");
  assert.equal(body.syncIntervalMs, 60 * 60_000);
  assert.deepEqual(body.emailSenders, EMAIL_SENDERS);
  assert.equal(body.gmailSendAvailable, true);
  assert.equal("emailComposerProvider" in body, false);
}));

test("email resolution requires a synchronized exact contact and allowlisted sender", () => withServer(async ({ request }) => {
  const payload = {
    ownerId: REPS[0].id,
    entryId: "entry-oyster",
    personId: "person-maya",
    email: "maya@oysterhr.com",
    senderId: EMAIL_SENDERS[0].id,
  };
  const denied = await request("/api/email/resolve", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  assert.equal(denied.response.status, 409);

  await request("/api/sync", { method: "POST", body: JSON.stringify({ ownerId: REPS[0].id }) });
  const existing = await request("/api/email/resolve", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  assert.equal(existing.body.mode, "reply");
  assert.equal(existing.body.sender.email, "sandro@stimuli.digital");
  assert.equal(existing.body.thread.id, "mock-gmail-thread-maya");
  assert.equal(existing.body.messages.length, 2);
  assert.ok(existing.body.authorizationId);

  const unknown = await request("/api/email/resolve", {
    method: "POST",
    body: JSON.stringify({ ...payload, email: "unknown@example.com" }),
  });
  assert.equal(unknown.response.status, 409);

  const wrongPerson = await request("/api/email/resolve", {
    method: "POST",
    body: JSON.stringify({ ...payload, personId: "person-jules" }),
  });
  assert.equal(wrongPerson.response.status, 409);

  const unallowlisted = await request("/api/email/resolve", {
    method: "POST",
    body: JSON.stringify({ ...payload, senderId: "attacker@example.com" }),
  });
  assert.equal(unallowlisted.response.status, 400);
}));

test("all three Gmail identities resolve independently of queue ownership", () => withServer(async ({ request }) => {
  await request("/api/sync", { method: "POST", body: JSON.stringify({ ownerId: REPS[0].id }) });
  const modes = [];
  for (const sender of EMAIL_SENDERS) {
    const resolved = await request("/api/email/resolve", {
      method: "POST",
      body: JSON.stringify({
        ownerId: REPS[0].id,
        entryId: "entry-oyster",
        personId: "person-maya",
        email: "maya@oysterhr.com",
        senderId: sender.id,
      }),
    });
    assert.equal(resolved.response.status, 200);
    assert.equal(resolved.body.sender.email, sender.email);
    modes.push(resolved.body.mode);
  }
  assert.deepEqual(modes, ["reply", "new", "reply"]);
}));

test("Gmail new and reply sends are successful and idempotent", () => withServer(async ({ request }) => {
  await request("/api/sync", { method: "POST", body: JSON.stringify({ ownerId: REPS[0].id }) });
  const base = { ownerId: REPS[0].id, entryId: "entry-oyster", personId: "person-maya", email: "maya@oysterhr.com" };
  const resolve = async (senderId) => (await request("/api/email/resolve", {
    method: "POST", body: JSON.stringify({ ...base, senderId }),
  })).body;

  const replyAuthorization = await resolve(EMAIL_SENDERS[0].id);
  const replyPayload = {
    authorizationId: replyAuthorization.authorizationId,
    idempotencyKey: "gmail-reply-once",
    ownerId: base.ownerId,
    entryId: base.entryId,
    personId: base.personId,
    subject: "Browser supplied subject is ignored",
    message: "Replying in the existing thread.",
  };
  const reply = await request("/api/email/send", { method: "POST", body: JSON.stringify(replyPayload) });
  assert.equal(reply.response.status, 200);
  assert.equal(reply.body.receipt.accountId, EMAIL_SENDERS[0].email);
  assert.equal(reply.body.receipt.chatId, "mock-gmail-thread-maya");
  const duplicate = await request("/api/email/send", { method: "POST", body: JSON.stringify(replyPayload) });
  assert.equal(duplicate.body.duplicate, true);

  const newAuthorization = await resolve(EMAIL_SENDERS[1].id);
  const missingSubject = await request("/api/email/send", {
    method: "POST",
    body: JSON.stringify({ ...replyPayload, authorizationId: newAuthorization.authorizationId, idempotencyKey: "gmail-no-subject", subject: "" }),
  });
  assert.equal(missingSubject.response.status, 400);
  const fresh = await request("/api/email/send", {
    method: "POST",
    body: JSON.stringify({ ...replyPayload, authorizationId: newAuthorization.authorizationId, idempotencyKey: "gmail-new-once", subject: "A new subject" }),
  });
  assert.equal(fresh.response.status, 200);
  assert.equal(fresh.body.receipt.accountId, EMAIL_SENDERS[1].email);
}));

test("expired Gmail authorization cannot send", () => withServer(async ({ request }) => {
  await request("/api/sync", { method: "POST", body: JSON.stringify({ ownerId: REPS[0].id }) });
  const resolved = await request("/api/email/resolve", {
    method: "POST",
    body: JSON.stringify({ ownerId: REPS[0].id, entryId: "entry-oyster", personId: "person-maya", email: "maya@oysterhr.com", senderId: EMAIL_SENDERS[0].id }),
  });
  const sent = await request("/api/email/send", {
    method: "POST",
    body: JSON.stringify({ authorizationId: resolved.body.authorizationId, idempotencyKey: "stale-gmail", ownerId: REPS[0].id, entryId: "entry-oyster", personId: "person-maya", message: "Must not send" }),
  });
  assert.equal(sent.response.status, 409);
  assert.match(sent.body.error, /expired/i);
}, { emailAuthorizationTtlMs: 0 }));

test("SendPilot resolution is independent of the Attio source", () => withServer(async ({ request }) => {
  const campaign = await request("/api/sendpilot/resolve", {
    method: "POST",
    body: JSON.stringify({ name: "Maya Patel", linkedinUrl: "https://www.linkedin.com/in/mayapatel", source: "Cold Calling" }),
  });
  assert.equal(campaign.response.status, 200);
  assert.equal(campaign.body.verified, true);
  assert.equal(campaign.body.messages.length, 2);

  const manual = await request("/api/sendpilot/resolve", {
    method: "POST",
    body: JSON.stringify({ name: "Theo Barnes", linkedinUrl: "https://www.linkedin.com/in/theobarnes", source: "LinkedIn Campaign" }),
  });
  assert.equal(manual.body.source, "manual");
  assert.match(manual.body.reason, /Not in SendPilot/i);
}));

test("template CRUD is durable through the API", () => withServer(async ({ request }) => {
  const created = await request("/api/templates", { method: "POST", body: JSON.stringify({ name: "Follow up", body: "Worth revisiting?" }) });
  assert.equal(created.response.status, 201);
  const id = created.body.template.id;
  const listed = await request("/api/templates");
  assert.equal(listed.body.templates[0].body, "Worth revisiting?");
  const updated = await request(`/api/templates/${id}`, { method: "PATCH", body: JSON.stringify({ name: "Follow-up", body: "Should I close the loop?" }) });
  assert.equal(updated.body.template.name, "Follow-up");
  assert.equal((await request(`/api/templates/${id}`, { method: "DELETE" })).response.status, 204);
}));

test("verified SendPilot campaign sends are idempotent and reconcile through Attio state", () => withServer(async ({ request }) => {
  const payload = {
    idempotencyKey: "send-once",
    entryId: "entry-oyster",
    personId: "person-maya",
    leadId: "sendpilot-lead-maya",
    senderId: LINKEDIN_SENDERS[0].id,
    contactName: "Maya Patel",
    linkedinUrl: "https://www.linkedin.com/in/mayapatel",
    message: "Thanks — here is the detail.",
  };
  const first = await request("/api/sendpilot/send", { method: "POST", body: JSON.stringify(payload) });
  assert.equal(first.body.ok, true);
  const duplicate = await request("/api/sendpilot/send", { method: "POST", body: JSON.stringify(payload) });
  assert.equal(duplicate.body.duplicate, true);
  const synced = await request("/api/sync", { method: "POST", body: JSON.stringify({ ownerId: REPS[0].id }) });
  assert.equal(synced.body.queue.some((item) => item.entryId === "entry-oyster"), false);
}));

test("unverified contacts cannot use the SendPilot send endpoint", () => withServer(async ({ request }) => {
  const result = await request("/api/sendpilot/send", {
    method: "POST",
    body: JSON.stringify({
      idempotencyKey: "manual-send",
      entryId: "entry-sana",
      personId: "person-sofia",
      leadId: "not-a-lead",
      senderId: LINKEDIN_SENDERS[0].id,
      contactName: "Sofia Lind",
      linkedinUrl: "https://www.linkedin.com/in/sofialind",
      message: "Following up.",
    }),
  });
  assert.equal(result.response.status, 500);
  assert.match(result.body.error, /could not be verified/i);
}));

test("a verified existing Unipile chat is an idempotent fallback when SendPilot has no lead", () => withServer(async ({ request }) => {
  await request("/api/sync", { method: "POST", body: JSON.stringify({ ownerId: REPS[0].id }) });
  const payload = {
    idempotencyKey: "unipile-send-once",
    entryId: "entry-pigment",
    personId: "person-theo",
    senderId: LINKEDIN_SENDERS[0].id,
    chatId: "chat-theo-sandro",
    message: "Here is the short version.",
  };
  const first = await request("/api/unipile/send", { method: "POST", body: JSON.stringify(payload) });
  assert.equal(first.response.status, 200);
  assert.equal(first.body.provider, "unipile");
  const duplicate = await request("/api/unipile/send", { method: "POST", body: JSON.stringify(payload) });
  assert.equal(duplicate.body.duplicate, true);
  const synced = await request("/api/sync", { method: "POST", body: JSON.stringify({ ownerId: REPS[0].id }) });
  assert.equal(synced.body.queue.some((item) => item.entryId === "entry-pigment"), false);
}));

test("Unipile cannot send a chat that was not authorized by queue resolution", () => withServer(async ({ request }) => {
  const result = await request("/api/unipile/send", {
    method: "POST",
    body: JSON.stringify({
      idempotencyKey: "unverified-unipile",
      entryId: "entry-pigment",
      personId: "person-theo",
      senderId: LINKEDIN_SENDERS[0].id,
      chatId: "chat-theo-sandro",
      message: "This must not send.",
    }),
  });
  assert.equal(result.response.status, 409);
  assert.match(result.body.error, /stale|not verified/i);
}));

test("manual repair increments only a genuine consecutive outbound follow-up", () => withServer(async ({ request }) => {
  const outbound = await request("/api/interactions/repair", { method: "POST", body: JSON.stringify({ entryId: "entry-pigment", companyId: "company-pigment", direction: "Us", date: "2026-08-26" }) });
  assert.equal(outbound.body.incremented, true);
  assert.equal(outbound.body.followUpCount, 4);
  const inbound = await request("/api/interactions/repair", { method: "POST", body: JSON.stringify({ entryId: "entry-vanta", companyId: "company-vanta", direction: "Them", date: "2026-08-26" }) });
  assert.equal(inbound.body.incremented, false);
}));

test("Lost disposition removes the company from the follow-up queue", () => withServer(async ({ request }) => {
  const lost = await request("/api/entries/entry-pigment/lost", { method: "POST", body: "{}" });
  assert.equal(lost.response.status, 200);
  const synced = await request("/api/sync", { method: "POST", body: JSON.stringify({ ownerId: REPS[0].id }) });
  assert.equal(synced.body.queue.some((item) => item.entryId === "entry-pigment"), false);
}));
