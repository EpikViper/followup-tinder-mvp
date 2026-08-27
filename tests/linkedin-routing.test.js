import test from "node:test";
import assert from "node:assert/strict";
import { addUnipileFallback } from "../src/linkedin-routing.js";

const primary = {
  source: "sendpilot_campaign",
  verified: false,
  fallbackEligible: true,
  senderId: "sendpilot-sergi",
  senderName: "Sergi Cheishvili",
  conversationId: "sendpilot-conversation",
  reason: "SendPilot has no matching lead for this existing conversation",
  messages: [],
};

test("Unipile fallback requires the same named sender's existing conversation", async () => {
  const unipile = {
    async getConversations() {
      return {
        recipientProviderId: "provider-contact",
        conversations: [{
          accountId: "unipile-sergi",
          accountName: "Sergi Cheishvili",
          chatId: "unipile-chat",
          lastMessageAt: "2026-08-26T10:00:00Z",
          messages: [{ id: "message", text: "Existing", timestamp: "2026-08-26T10:00:00Z", isSender: false }],
        }],
      };
    },
  };

  const route = await addUnipileFallback(primary, { id: "person", linkedinUrn: "provider-contact" }, unipile);
  assert.equal(route.source, "unipile_fallback");
  assert.equal(route.verified, true);
  assert.equal(route.senderId, "unipile-sergi");
  assert.equal(route.sendpilotSenderId, "sendpilot-sergi");
  assert.equal(route.chatId, "unipile-chat");
});

test("a different Unipile sender cannot replace the SendPilot conversation owner", async () => {
  const unipile = {
    async getConversations() {
      return {
        recipientProviderId: "provider-contact",
        conversations: [{ accountId: "unipile-sandro", accountName: "Sandro Turmanidze", chatId: "wrong-chat", messages: [] }],
      };
    },
  };
  assert.equal(await addUnipileFallback(primary, { id: "person" }, unipile), primary);
});

test("a Unipile outage leaves the primary routing result usable", async () => {
  const unipile = { async getConversations() { throw new Error("offline"); } };
  assert.equal(await addUnipileFallback(primary, { id: "person" }, unipile), primary);
});
