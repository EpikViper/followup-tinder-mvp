import crypto from "node:crypto";
import fs from "node:fs";
import { EMAIL_SENDERS, SYNC_INTERVAL_MS } from "./constants.js";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
].join(" ");
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const THREAD_SEARCH_LIMIT = 20;
const PREVIEW_LIMIT = 6;

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64url(value) {
  if (!value) return "";
  try { return Buffer.from(value, "base64url").toString("utf8"); } catch { return ""; }
}

function header(message, name) {
  return message?.payload?.headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

function addresses(value) {
  return [...String(value || "").matchAll(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)]
    .map((match) => match[0].toLowerCase());
}

function messageAddresses(message) {
  return ["From", "To", "Cc", "Bcc"].flatMap((name) => addresses(header(message, name)));
}

function isExactParticipantThread(thread, mailbox, recipient, cc = []) {
  const allowed = new Set([mailbox.toLowerCase(), recipient.toLowerCase(), ...cc.map((email) => email.toLowerCase())]);
  const seen = new Set();
  const messages = thread?.messages || [];
  if (!messages.length) return false;
  for (const message of messages) {
    const participants = messageAddresses(message);
    if (!participants.length || participants.some((email) => !allowed.has(email))) return false;
    participants.forEach((email) => seen.add(email));
  }
  return seen.has(mailbox.toLowerCase()) && seen.has(recipient.toLowerCase());
}

function plainTextPart(part) {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return decodeBase64url(part.body.data);
  for (const child of part.parts || []) {
    const text = plainTextPart(child);
    if (text) return text;
  }
  return part.mimeType === "text/plain" ? decodeBase64url(part.body?.data) : "";
}

function messageTime(message) {
  return Number(message?.internalDate || 0);
}

function sortedMessages(thread) {
  return [...(thread?.messages || [])].sort((a, b) => messageTime(a) - messageTime(b));
}

function previewMessages(thread, mailbox) {
  return sortedMessages(thread).slice(-PREVIEW_LIMIT).map((message) => ({
    id: message.id,
    from: header(message, "From"),
    to: header(message, "To"),
    sentAt: message.internalDate ? new Date(messageTime(message)).toISOString() : null,
    isSender: addresses(header(message, "From")).includes(mailbox.toLowerCase()),
    text: (plainTextPart(message.payload) || message.snippet || "").trim().slice(0, 5000),
  }));
}

function latestMessage(thread) {
  return sortedMessages(thread).at(-1) || null;
}

function safeHeader(value, label) {
  const text = String(value ?? "").trim();
  if (!text || /[\r\n]/.test(text)) throw new Error(`${label} is invalid`);
  return text;
}

function encodedSubject(subject) {
  const value = String(subject ?? "").trim();
  if (/[\r\n]/.test(value)) throw new Error("Email subject is invalid");
  return /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`;
}

function senderForMailbox(mailbox) {
  return EMAIL_SENDERS.find((sender) => sender.email === mailbox);
}

export function buildMimeMessage({ mailbox, to, cc = [], subject, body, inReplyTo = null, references = null }) {
  const sender = senderForMailbox(mailbox);
  if (!sender) throw new Error("Email sender is not allowlisted");
  const normalizedTo = safeHeader(to, "Recipient");
  const lines = [
    `From: ${sender.name} <${sender.email}>`,
    `To: ${normalizedTo}`,
    `Subject: ${encodedSubject(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  if (cc.length) lines.splice(2, 0, `Cc: ${cc.map((email) => safeHeader(email, "CC recipient")).join(", ")}`);
  if (inReplyTo) lines.push(`In-Reply-To: ${safeHeader(inReplyTo, "In-Reply-To")}`);
  if (references) lines.push(`References: ${safeHeader(references, "References")}`);
  return `${lines.join("\r\n")}\r\n\r\n${String(body).replace(/\r?\n/g, "\r\n")}`;
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
      if (!this.credentialPath) throw new Error("Gmail sending is not configured");
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
    const claim = { iss: serviceAccount.client_email, sub: mailbox, scope: GMAIL_SCOPES, aud: TOKEN_URL, iat: now, exp: now + 3600 };
    const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify(claim))}`;
    const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(serviceAccount.private_key).toString("base64url");
    const response = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.access_token) throw new Error(`Gmail authentication failed for ${mailbox}`);
    this.tokens.set(mailbox, { value: result.access_token, expiresAt: Date.now() + Number(result.expires_in || 3600) * 1000 });
    return result.access_token;
  }

  async request(mailbox, path, { method = "GET", body } = {}) {
    const token = await this.accessToken(mailbox);
    const response = await this.fetchImpl(`${API_BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Gmail request failed for ${mailbox} (${response.status})`);
    return result;
  }

  cacheKey(mailbox, email, cc = []) {
    return `${mailbox.toLowerCase()}:${email.toLowerCase()}:${[...cc].sort().join(",")}`;
  }

  async latestInMailbox(mailbox, email, cc = []) {
    const query = `{from:${email} to:${email}}`;
    const listed = await this.request(mailbox, `/threads?maxResults=${THREAD_SEARCH_LIMIT}&q=${encodeURIComponent(query)}`);
    const settled = await Promise.allSettled((listed.threads || []).map(({ id }) => this.request(mailbox, `/threads/${encodeURIComponent(id)}?format=full`)));
    const exact = settled
      .filter((item) => item.status === "fulfilled" && isExactParticipantThread(item.value, mailbox, email, cc))
      .map((item) => item.value)
      .sort((a, b) => messageTime(latestMessage(b)) - messageTime(latestMessage(a)));
    if (!exact.length && settled.length && settled.every((item) => item.status === "rejected")) throw settled[0].reason;
    const thread = exact[0];
    if (!thread) return { found: false, mode: "new", subject: "", messages: [] };
    const latest = latestMessage(thread);
    return {
      found: true,
      mode: "reply",
      mailbox,
      threadId: thread.id,
      subject: header(latest, "Subject"),
      lastMessageAt: latest?.internalDate ? new Date(messageTime(latest)).toISOString() : null,
      messages: previewMessages(thread, mailbox),
    };
  }

  async resolveThread({ mailbox, email, cc = [], fresh = false }) {
    const cacheKey = this.cacheKey(mailbox, email, cc);
    const cached = this.threadCache.get(cacheKey);
    if (!fresh && cached && Date.now() - cached.createdAt < SYNC_INTERVAL_MS) return cached.value;
    const value = await this.latestInMailbox(mailbox, email, cc);
    this.threadCache.set(cacheKey, { createdAt: Date.now(), value });
    return value;
  }

  async replyContext({ mailbox, email, cc = [] }) {
    const result = await this.resolveThread({ mailbox, email, cc, fresh: true });
    if (!result.found) throw new Error("The Gmail conversation no longer exists. Resolve the sender again.");
    const thread = await this.request(mailbox, `/threads/${encodeURIComponent(result.threadId)}?format=full`);
    if (!isExactParticipantThread(thread, mailbox, email, cc)) throw new Error("The Gmail conversation participants changed. Resolve the sender again.");
    const latest = latestMessage(thread);
    const messageId = header(latest, "Message-ID");
    if (!messageId) throw new Error("The latest Gmail message has no Message-ID header");
    const priorReferences = header(latest, "References").split(/\s+/).filter(Boolean);
    return {
      threadId: thread.id,
      subject: header(latest, "Subject"),
      inReplyTo: messageId,
      references: [...new Set([...priorReferences, messageId])].join(" "),
    };
  }

  async sendEmail({ mailbox, email, cc = [], subject, body, reply = false }) {
    const context = reply ? await this.replyContext({ mailbox, email, cc }) : null;
    const resolvedSubject = context?.subject || subject;
    const mime = buildMimeMessage({ mailbox, to: email, cc, subject: resolvedSubject, body, inReplyTo: context?.inReplyTo, references: context?.references });
    const sent = await this.request(mailbox, "/messages/send", {
      method: "POST",
      body: { raw: base64url(mime), ...(context ? { threadId: context.threadId } : {}) },
    });
    this.invalidateThread(mailbox, email, cc);
    return { messageId: sent.id, threadId: sent.threadId || context?.threadId || null, subject: resolvedSubject };
  }

  invalidateThread(mailbox, email, cc = []) {
    this.threadCache.delete(this.cacheKey(mailbox, email, cc));
  }

  reset() {
    this.threadCache.clear();
  }
}
