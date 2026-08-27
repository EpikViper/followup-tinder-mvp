import crypto from "node:crypto";
import fs from "node:fs";
import { GMAIL_MAILBOXES_BY_OWNER, SYNC_INTERVAL_MS } from "./constants.js";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function header(message, name) {
  return message?.payload?.headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

export class GmailClient {
  constructor({
    credentialPath = process.env.GMAIL_SERVICE_ACCOUNT_JSON || process.env["gmail-attio-sync"],
    credential = null,
    fetchImpl = fetch,
  } = {}) {
    this.credentialPath = credentialPath;
    this.credential = credential;
    this.fetchImpl = fetchImpl;
    this.tokens = new Map();
    this.threadCache = new Map();
  }

  get configured() {
    return Boolean(this.credential || this.credentialPath);
  }

  serviceAccount() {
    if (!this.credential) {
      if (!this.credentialPath) throw new Error("Gmail thread lookup is not configured");
      this.credential = JSON.parse(fs.readFileSync(this.credentialPath, "utf8"));
    }
    if (!this.credential.client_email || !this.credential.private_key) {
      throw new Error("Gmail service-account credentials are incomplete");
    }
    return this.credential;
  }

  async accessToken(mailbox) {
    const cached = this.tokens.get(mailbox);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;

    const serviceAccount = this.serviceAccount();
    const now = Math.floor(Date.now() / 1000);
    const claim = {
      iss: serviceAccount.client_email,
      sub: mailbox,
      scope: GMAIL_SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    };
    const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify(claim))}`;
    const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(serviceAccount.private_key).toString("base64url");
    const response = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.access_token) throw new Error(`Gmail authentication failed for ${mailbox}`);
    this.tokens.set(mailbox, { value: result.access_token, expiresAt: Date.now() + Number(result.expires_in || 3600) * 1000 });
    return result.access_token;
  }

  async request(mailbox, path) {
    const token = await this.accessToken(mailbox);
    const response = await this.fetchImpl(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Gmail lookup failed for ${mailbox} (${response.status})`);
    return result;
  }

  async latestInMailbox(mailbox, email) {
    const query = `{from:${email} to:${email}}`;
    const listed = await this.request(mailbox, `/threads?maxResults=1&q=${encodeURIComponent(query)}`);
    const threadId = listed.threads?.[0]?.id;
    if (!threadId) return null;
    const thread = await this.request(
      mailbox,
      `/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=Subject`
    );
    const messages = thread.messages || [];
    const latest = messages.reduce((winner, message) =>
      Number(message.internalDate || 0) > Number(winner?.internalDate || 0) ? message : winner, null);
    return {
      found: true,
      mailbox,
      threadId,
      subject: header(latest, "Subject"),
      lastMessageAt: latest?.internalDate ? new Date(Number(latest.internalDate)).toISOString() : null,
      url: `https://mail.google.com/mail/u/${mailbox}/#all/${threadId}`,
    };
  }

  async findLatestThread({ ownerId, email }) {
    const cacheKey = `${ownerId}:${email.toLowerCase()}`;
    const cached = this.threadCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < SYNC_INTERVAL_MS) return cached.value;

    const mailboxes = GMAIL_MAILBOXES_BY_OWNER[ownerId] || [];
    if (!mailboxes.length || !this.configured) return { found: false };
    const settled = await Promise.allSettled(mailboxes.map((mailbox) => this.latestInMailbox(mailbox, email)));
    const candidates = settled
      .filter((item) => item.status === "fulfilled" && item.value)
      .map((item) => item.value)
      .sort((a, b) => String(b.lastMessageAt || "").localeCompare(String(a.lastMessageAt || "")));
    if (!candidates.length && settled.every((item) => item.status === "rejected")) {
      throw settled[0].reason;
    }
    const value = candidates[0] || { found: false };
    this.threadCache.set(cacheKey, { createdAt: Date.now(), value });
    return value;
  }
}
