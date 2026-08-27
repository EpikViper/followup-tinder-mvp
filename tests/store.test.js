import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalStore } from "../src/store.js";

test("templates persist and send receipts enforce idempotency", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "followup-store-"));
  const store = new LocalStore(dir);
  try {
    const template = store.createTemplate({ name: "No show", body: "Want to find another time?" });
    assert.equal(store.listTemplates().length, 1);
    assert.equal(store.updateTemplate(template.id, { name: "No-show", body: "Should we reschedule?" }).body, "Should we reschedule?");

    const send = { idempotencyKey: "idem-1", entryId: "entry-1", personId: "person-1", accountId: "account-1", chatId: "chat-1", text: "Hello" };
    assert.equal(store.beginSend(send).created, true);
    assert.equal(store.beginSend(send).created, false);
    assert.equal(store.completeSend("idem-1", { providerMessageId: "message-1", chatId: "chat-1" }).status, "sent");
    assert.equal(store.deleteTemplate(template.id), true);
    assert.equal(store.listTemplates().length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
