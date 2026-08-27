import test from "node:test";
import assert from "node:assert/strict";
import { LINKEDIN_SENDERS } from "../src/constants.js";
import { UnipileClient } from "../src/unipile.js";

test("Unipile re-verifies account and attendee before sending an existing chat", async () => {
  const client = new UnipileClient({ dsn: "example.unipile.com", apiKey: "test" });
  const sender = LINKEDIN_SENDERS[1];
  let sentForm = null;
  client.request = async (method, path, options = {}) => {
    if (method === "GET" && path === "/accounts") return { items: [{ id: sender.id, name: sender.name }] };
    if (method === "GET" && path === "/chats/chat-id") {
      return { id: "chat-id", account_id: sender.id, attendee_provider_id: "provider-contact", read_only: false };
    }
    if (method === "POST" && path === "/chats/chat-id/messages") {
      sentForm = options.form;
      return { id: "message-id" };
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };

  const result = await client.sendMessage({
    accountId: sender.id,
    chatId: "chat-id",
    recipientProviderId: "provider-contact",
    text: "Hello",
  });
  assert.equal(result.messageId, "message-id");
  assert.deepEqual(sentForm, { account_id: sender.id, text: "Hello" });
});

test("Unipile rejects a chat belonging to another contact", async () => {
  const client = new UnipileClient({ dsn: "example.unipile.com", apiKey: "test" });
  const sender = LINKEDIN_SENDERS[0];
  client.request = async (method, path) => {
    if (path === "/accounts") return { items: [{ id: sender.id, name: sender.name }] };
    if (path === "/chats/chat-id") return { account_id: sender.id, attendee_provider_id: "someone-else" };
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  await assert.rejects(
    client.sendMessage({ accountId: sender.id, chatId: "chat-id", recipientProviderId: "expected-contact", text: "Hello" }),
    /different LinkedIn contact/i
  );
});
