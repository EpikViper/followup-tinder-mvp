import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export class LocalStore {
  constructor(dataDir) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "followup.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS send_receipts (
        idempotency_key TEXT PRIMARY KEY,
        provider_message_id TEXT,
        entry_id TEXT NOT NULL,
        person_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        chat_id TEXT,
        text_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_send_receipts_entry_created
      ON send_receipts(entry_id, created_at);
      PRAGMA optimize;
    `);
  }

  close() {
    this.db.close();
  }

  listTemplates() {
    return this.db.prepare(
      "SELECT id, name, body, created_at AS createdAt, updated_at AS updatedAt FROM templates ORDER BY name COLLATE NOCASE"
    ).all();
  }

  createTemplate({ name, body }) {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(
      "INSERT INTO templates (id, name, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run(id, name, body, now, now);
    return { id, name, body, createdAt: now, updatedAt: now };
  }

  updateTemplate(id, { name, body }) {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      "UPDATE templates SET name = ?, body = ?, updated_at = ? WHERE id = ?"
    ).run(name, body, now, id);
    if (result.changes === 0) return null;
    return this.db.prepare(
      "SELECT id, name, body, created_at AS createdAt, updated_at AS updatedAt FROM templates WHERE id = ?"
    ).get(id);
  }

  deleteTemplate(id) {
    return this.db.prepare("DELETE FROM templates WHERE id = ?").run(id).changes > 0;
  }

  textHash(text) {
    return createHash("sha256").update(text).digest("hex");
  }

  beginSend({ idempotencyKey, entryId, personId, accountId, chatId, text }) {
    const existing = this.getReceipt(idempotencyKey);
    if (existing) return { created: false, receipt: existing };
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO send_receipts
      (idempotency_key, entry_id, person_id, account_id, chat_id, text_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(idempotencyKey, entryId, personId, accountId, chatId || null, this.textHash(text), now, now);
    return { created: true, receipt: this.getReceipt(idempotencyKey) };
  }

  completeSend(idempotencyKey, { providerMessageId, chatId }) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE send_receipts
      SET provider_message_id = ?, chat_id = ?, status = 'sent', error = NULL, updated_at = ?
      WHERE idempotency_key = ?
    `).run(providerMessageId || null, chatId || null, now, idempotencyKey);
    return this.getReceipt(idempotencyKey);
  }

  failSend(idempotencyKey, error) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE send_receipts SET status = 'failed', error = ?, updated_at = ?
      WHERE idempotency_key = ?
    `).run(String(error).slice(0, 500), now, idempotencyKey);
    return this.getReceipt(idempotencyKey);
  }

  getReceipt(idempotencyKey) {
    return this.db.prepare(`
      SELECT idempotency_key AS idempotencyKey, provider_message_id AS providerMessageId,
             entry_id AS entryId, person_id AS personId, account_id AS accountId,
             chat_id AS chatId, status, error, created_at AS createdAt, updated_at AS updatedAt
      FROM send_receipts WHERE idempotency_key = ?
    `).get(idempotencyKey) || null;
  }
}
