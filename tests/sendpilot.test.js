import test from "node:test";
import assert from "node:assert/strict";
import { LINKEDIN_SENDERS } from "../src/constants.js";
import { SendPilotClient } from "../src/sendpilot.js";

test("multiple sender conversations are returned as explicit choices", async () => {
  const client = new SendPilotClient({ apiKey: "test" });
  const linkedinUrl = "https://www.linkedin.com/in/rumen-marinov-00b458174";
  const lead = {
    id: "lead-rumen",
    linkedinUrl,
    campaignName: "Europe",
    campaignStatus: "paused",
    campaignSenderIds: [LINKEDIN_SENDERS[1].id],
    status: "DONE",
  };
  client.leadIndex = {
    createdAt: Date.now(),
    byUrl: new Map([[linkedinUrl, [lead]]]),
    byName: new Map([["rumen marinov", [lead]]]),
    byId: new Map([[lead.id, lead]]),
  };
  client.conversationIndex = {
    createdAt: Date.now(),
    byUrl: new Map(),
    byName: new Map([["rumen marinov", [
      { id: "conversation-sergi", accountId: LINKEDIN_SENDERS[1].id, lastActivityAt: "2026-08-13T15:52:44.720Z" },
      { id: "conversation-revaz", accountId: LINKEDIN_SENDERS[2].id, lastActivityAt: "2026-08-10T07:56:53.300Z" },
    ]]]),
    senders: [
      { ...LINKEDIN_SENDERS[1], connected: true, remainingMessages: 20 },
      { ...LINKEDIN_SENDERS[2], connected: true, remainingMessages: 20 },
    ],
  };
  client.getConversationMessages = async (conversationId) => [
    { id: `message-${conversationId}`, text: conversationId, timestamp: "2026-08-13T00:00:00Z", isSender: false },
  ];

  const route = await client.getRoutingForPerson({ name: "Rumen Marinov", linkedinUrl });

  assert.equal(route.reason, "Choose a SendPilot sender conversation");
  assert.equal(route.routes.length, 2);
  assert.equal(route.routes[0].senderName, "Sergi Cheishvili");
  assert.equal(route.routes[0].verified, true);
  assert.equal(route.routes[1].senderName, "Revaz Dzidziguri");
  assert.equal(route.routes[1].verified, false);
  assert.equal(route.routes[1].messages.length, 1);
});

test("a corroborated public LinkedIn slug bridges abbreviated and full inbox names", async () => {
  const client = new SendPilotClient({ apiKey: "test" });
  const linkedinUrl = "https://www.linkedin.com/in/matt-prewitt3";
  const sender = { ...LINKEDIN_SENDERS[2], connected: true, remainingMessages: 20 };
  const lead = {
    id: "lead-matt",
    firstName: "Matt",
    lastName: "P.",
    linkedinUrl,
    campaignName: "US",
    campaignStatus: "paused",
    campaignSenderIds: [sender.id],
    status: "DONE",
  };
  client.leadIndex = {
    createdAt: Date.now(),
    byUrl: new Map([[linkedinUrl, [lead]]]),
    byName: new Map([["matt p", [lead]]]),
    byId: new Map([[lead.id, lead]]),
  };
  client.conversationIndex = {
    createdAt: Date.now(),
    byUrl: new Map([["https://www.linkedin.com/in/acoopaque", [
      { id: "conversation-matt", accountId: sender.id, lastActivityAt: "2026-08-25T15:09:32.913Z" },
    ]]]),
    byName: new Map([["matt prewitt", [
      { id: "conversation-matt", accountId: sender.id, lastActivityAt: "2026-08-25T15:09:32.913Z" },
    ]]]),
    senders: [sender],
  };
  client.getConversationMessages = async () => [
    { id: "message-matt", text: "Found", timestamp: "2026-08-25T15:09:32.913Z", isSender: false },
  ];

  const route = await client.getRoutingForPerson({ name: "Matt P.", linkedinUrl });

  assert.equal(route.verified, true);
  assert.equal(route.senderName, "Revaz Dzidziguri");
  assert.equal(route.match.strategy, "linkedin_slug");
  assert.equal(route.match.confidence, "corroborated");
  assert.equal(route.campaignStatus, "paused");
  assert.equal(route.messages.length, 1);
});

test("send-time verification permits a paused campaign for an existing conversation", async () => {
  const client = new SendPilotClient({ apiKey: "test" });
  const sender = { ...LINKEDIN_SENDERS[1], connected: true };
  client.request = async (path) => {
    if (path === "/leads/lead-paused") {
      return {
        id: "lead-paused",
        campaignId: "campaign-paused",
        linkedinUrl: "https://www.linkedin.com/in/existing-contact",
        status: "DONE",
      };
    }
    if (path === "/inbox/senders") {
      return { senders: [{ id: sender.id, name: sender.name, status: "active" }] };
    }
    if (path === "/campaigns/campaign-paused") {
      return { id: "campaign-paused", status: "paused", linkedInSenderIds: [sender.id] };
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  const result = await client.verifyRoute({
    leadId: "lead-paused",
    senderId: sender.id,
    linkedinUrl: "https://www.linkedin.com/in/existing-contact",
    contactName: "Existing Contact",
  });

  assert.equal(result.id, "lead-paused");
});
