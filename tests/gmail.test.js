import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { buildMimeMessage, GmailClient } from "../src/gmail.js";

function gmailMessage({ id, at, from, to, subject = "Follow-up", text = "Hello", messageId = `<${id}@example.com>`, references = "" }) {
  return {
    id,
    internalDate: String(at),
    snippet: text,
    payload: {
      mimeType: "text/plain",
      body: { data: Buffer.from(text).toString("base64url") },
      headers: [
        { name: "From", value: from },
        { name: "To", value: to },
        { name: "Subject", value: subject },
        { name: "Message-ID", value: messageId },
        ...(references ? [{ name: "References", value: references }] : []),
      ],
    },
  };
}

function credential() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    client_email: "gmail-test@example.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

test("Gmail selects and caches the newest exact-participant thread for one mailbox", async () => {
  const calls = [];
  const threads = {
    group: { id: "group", messages: [gmailMessage({ id: "group-message", at: 4000, from: "maya@oysterhr.com", to: "sandro@stimuli.digital, teammate@stimuli.digital" })] },
    older: { id: "older", messages: [gmailMessage({ id: "old-message", at: 1000, from: "sandro@stimuli.digital", to: "maya@oysterhr.com", text: "Old email" })] },
    newest: { id: "newest", messages: [
      gmailMessage({ id: "new-1", at: 2000, from: "Sandro <sandro@stimuli.digital>", to: "Maya <maya@oysterhr.com>", text: "Would a short overview help?" }),
      gmailMessage({ id: "new-2", at: 3000, from: "Maya <maya@oysterhr.com>", to: "Sandro <sandro@stimuli.digital>", subject: "Re: Follow-up", text: "Yes, please." }),
    ] },
  };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
    if (String(url).includes("/threads?")) return new Response(JSON.stringify({ threads: Object.keys(threads).map((id) => ({ id })) }), { status: 200 });
    const id = String(url).match(/\/threads\/([^?]+)/)?.[1];
    if (id && threads[id]) return new Response(JSON.stringify(threads[id]), { status: 200 });
    return new Response("{}", { status: 404 });
  };
  const client = new GmailClient({ credential: credential(), fetchImpl });

  const first = await client.resolveThread({ mailbox: "sandro@stimuli.digital", email: "maya@oysterhr.com" });
  const second = await client.resolveThread({ mailbox: "sandro@stimuli.digital", email: "maya@oysterhr.com" });
  assert.equal(first.threadId, "newest");
  assert.equal(first.subject, "Re: Follow-up");
  assert.deepEqual(first.messages.map((message) => message.text), ["Would a short overview help?", "Yes, please."]);
  assert.equal(first.messages[1].isSender, false);
  assert.deepEqual(second, first);
  const listCall = calls.find((call) => call.url.includes("/threads?"));
  assert.equal(new URL(listCall.url).searchParams.get("q"), "{from:maya@oysterhr.com to:maya@oysterhr.com}");
  assert.equal(calls.filter((call) => call.url.includes("/threads?")).length, 1);
  const tokenCall = calls.find((call) => call.url.includes("oauth2.googleapis.com/token"));
  const assertion = new URLSearchParams(tokenCall.options.body).get("assertion");
  const claim = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString("utf8"));
  assert.equal(claim.sub, "sandro@stimuli.digital");
  assert.match(claim.scope, /gmail\.readonly/);
  assert.match(claim.scope, /gmail\.send/);
});

test("plain-text MIME includes required new-message and reply headers", () => {
  const fresh = buildMimeMessage({
    mailbox: "sergi@stimuli.digital",
    to: "prospect@example.com",
    subject: "Quick follow-up",
    body: "First line\nSecond line",
  });
  assert.match(fresh, /^From: Sergi Cheishvili <sergi@stimuli\.digital>\r\n/);
  assert.match(fresh, /To: prospect@example\.com\r\nSubject: Quick follow-up/);
  assert.match(fresh, /Content-Type: text\/plain; charset=UTF-8/);
  assert.match(fresh, /\r\n\r\nFirst line\r\nSecond line$/);
  assert.doesNotMatch(fresh, /In-Reply-To|References/);

  const reply = buildMimeMessage({
    mailbox: "sergi@revcode.app",
    to: "prospect@example.com",
    subject: "Re: Intro",
    body: "Following up.",
    inReplyTo: "<latest@example.com>",
    references: "<first@example.com> <latest@example.com>",
  });
  assert.match(reply, /In-Reply-To: <latest@example\.com>/);
  assert.match(reply, /References: <first@example\.com> <latest@example\.com>/);
});

test("Gmail sends new mail and freshly revalidated replies, then invalidates cache", async () => {
  const sentBodies = [];
  const thread = {
    id: "thread-123",
    messages: [gmailMessage({
      id: "latest",
      at: 3000,
      from: "maya@oysterhr.com",
      to: "sandro@stimuli.digital",
      subject: "Existing subject",
      text: "Can you share details?",
      messageId: "<latest@oysterhr.com>",
      references: "<first@stimuli.digital>",
    })],
  };
  const fetchImpl = async (url, options = {}) => {
    const value = String(url);
    if (value.includes("oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
    if (value.includes("/threads?")) return new Response(JSON.stringify({ threads: [{ id: thread.id }] }), { status: 200 });
    if (value.includes(`/threads/${thread.id}?`)) return new Response(JSON.stringify(thread), { status: 200 });
    if (value.endsWith("/messages/send")) {
      const requestBody = JSON.parse(options.body);
      sentBodies.push(requestBody);
      return new Response(JSON.stringify({ id: `sent-${sentBodies.length}`, threadId: requestBody.threadId || "new-thread" }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  const client = new GmailClient({ credential: credential(), fetchImpl });
  client.threadCache.set(client.cacheKey("sergi@stimuli.digital", "new@example.com"), { createdAt: Date.now(), value: { found: false } });
  await client.sendEmail({ mailbox: "sergi@stimuli.digital", email: "new@example.com", subject: "New subject", body: "New body", reply: false });
  assert.equal(sentBodies[0].threadId, undefined);
  assert.match(Buffer.from(sentBodies[0].raw, "base64url").toString("utf8"), /Subject: New subject/);
  assert.equal(client.threadCache.has(client.cacheKey("sergi@stimuli.digital", "new@example.com")), false);

  client.threadCache.set(client.cacheKey("sandro@stimuli.digital", "maya@oysterhr.com"), { createdAt: Date.now(), value: { found: true } });
  const sent = await client.sendEmail({ mailbox: "sandro@stimuli.digital", email: "maya@oysterhr.com", subject: "Untrusted browser subject", body: "Reply body", reply: true });
  const rawReply = Buffer.from(sentBodies[1].raw, "base64url").toString("utf8");
  assert.equal(sentBodies[1].threadId, "thread-123");
  assert.match(rawReply, /Subject: Existing subject/);
  assert.match(rawReply, /In-Reply-To: <latest@oysterhr\.com>/);
  assert.match(rawReply, /References: <first@stimuli\.digital> <latest@oysterhr\.com>/);
  assert.equal(sent.messageId, "sent-2");
  assert.equal(client.threadCache.has(client.cacheKey("sandro@stimuli.digital", "maya@oysterhr.com")), false);
});
