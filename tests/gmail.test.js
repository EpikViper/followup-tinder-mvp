import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { GmailClient } from "../src/gmail.js";
import { REPS } from "../src/constants.js";

test("Gmail lookup finds and caches the newest exact-contact thread", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
    }
    if (String(url).includes("/threads?")) {
      return new Response(JSON.stringify({ threads: [{ id: "thread-123" }] }), { status: 200 });
    }
    if (String(url).includes("/threads/thread-123?")) {
      return new Response(JSON.stringify({
        id: "thread-123",
        messages: [{
          id: "message-123",
          internalDate: "1787745600000",
          payload: { headers: [{ name: "Subject", value: "Re: Follow-up" }] },
        }],
      }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  const client = new GmailClient({
    credential: {
      client_email: "gmail-test@example.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    },
    fetchImpl,
  });

  const first = await client.findLatestThread({ ownerId: REPS[0].id, email: "maya@oysterhr.com" });
  const second = await client.findLatestThread({ ownerId: REPS[0].id, email: "maya@oysterhr.com" });
  assert.equal(first.threadId, "thread-123");
  assert.equal(first.subject, "Re: Follow-up");
  assert.equal(first.url, "https://mail.google.com/mail/u/sandro@stimuli.digital/#all/thread-123");
  assert.deepEqual(second, first);
  const listCall = calls.find((call) => call.url.includes("/threads?"));
  assert.equal(new URL(listCall.url).searchParams.get("q"), "{from:maya@oysterhr.com to:maya@oysterhr.com}");
  assert.equal(calls.filter((call) => call.url.includes("/threads?")).length, 1);
});
