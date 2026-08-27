import test from "node:test";
import assert from "node:assert/strict";
import { buildQueue, classifyCompany, isFollowUpDue, relativeDateCutoff } from "../src/queue.js";

test("Friday is eligible Tuesday under Attio's strict relative-date cutoff", () => {
  assert.equal(isFollowUpDue("2026-08-21", new Date("2026-08-25T08:00:00Z")), true);
});

test("the date exactly two days ago is excluded by the strict before boundary", () => {
  const wednesday = new Date("2026-08-26T08:00:00Z");
  assert.equal(relativeDateCutoff(wednesday).toISOString().slice(0, 10), "2026-08-24");
  assert.equal(isFollowUpDue("2026-08-23", wednesday), true);
  assert.equal(isFollowUpDue("2026-08-24", wednesday), false);
  assert.equal(isFollowUpDue("2026-08-25", wednesday), false);
});

test("Monday becomes eligible Thursday, not Wednesday", () => {
  assert.equal(isFollowUpDue("2026-08-24", new Date("2026-08-26T08:00:00Z")), false);
  assert.equal(isFollowUpDue("2026-08-24", new Date("2026-08-27T08:00:00Z")), true);
});

test("queue classification follows the agreed priority", () => {
  const now = new Date("2026-08-26T12:00:00Z");
  assert.deepEqual(classifyCompany({ stage: "Unprocessed" }, now), { queueType: "unprocessed", priority: 0 });
  assert.deepEqual(classifyCompany({ stage: "Qualified", lastInteractionBy: "Them" }, now), { queueType: "inbound", priority: 1 });
  assert.deepEqual(classifyCompany({ stage: "Meeting Booked", meetingStatus: "No show", lastInteractionDate: "2026-08-21" }, now), { queueType: "no_show", priority: 2 });
  assert.deepEqual(classifyCompany({ stage: "Qualified", lastInteractionBy: "Us", lastInteractionDate: "2026-08-21" }, now), { queueType: "follow_up", priority: 3 });
  assert.equal(classifyCompany({ stage: "Meeting Booked", meetingStatus: "Booked", lastInteractionDate: "2026-08-01" }, now), null);
});

test("queue sorts by priority, then oldest interaction", () => {
  const base = { contacts: [], companyId: "c", entryId: "e" };
  const queue = buildQueue([
    { ...base, companyName: "Newest follow-up", stage: "Qualified", lastInteractionBy: "Us", lastInteractionDate: "2026-08-21" },
    { ...base, companyName: "Inbound", stage: "Qualified", lastInteractionBy: "Them", lastInteractionDate: "2026-08-26" },
    { ...base, companyName: "Old follow-up", stage: "Qualified", lastInteractionBy: "Us", lastInteractionDate: "2026-08-18" },
    { ...base, companyName: "New", stage: "Unprocessed", addedAt: "2026-08-25" },
  ], new Date("2026-08-26T12:00:00Z"));
  assert.deepEqual(queue.map((item) => item.companyName), ["New", "Inbound", "Old follow-up", "Newest follow-up"]);
});
