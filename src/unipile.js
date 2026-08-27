import { LINKEDIN_SENDERS, SYNC_INTERVAL_MS } from "./constants.js";

const READ_ATTEMPTS = 3;
const TIMEOUT_MS = 15_000;

function normalizeDsn(dsn) {
  const trimmed = String(dsn || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const [host, port] = trimmed.split(":", 2);
  if (!host) throw new Error("UNIPILE_DSN is not configured");
  return { host, port: port || null };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function linkedinSlug(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!/(^|\.)linkedin\.com$/i.test(parsed.hostname)) return null;
    const match = parsed.pathname.match(/^\/in\/([^/?#]+)/i);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

export function normalizeLinkedinUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("LinkedIn URL is required");
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const slug = linkedinSlug(withScheme);
  if (!slug) throw new Error("Enter a valid linkedin.com/in/... profile URL");
  return `https://www.linkedin.com/in/${slug}`;
}

export class UnipileClient {
  constructor({ dsn = process.env.UNIPILE_DSN, apiKey = process.env.UNIPILE_API_KEY } = {}) {
    if (!apiKey) throw new Error("UNIPILE_API_KEY is not configured");
    this.apiKey = apiKey;
    this.dsn = normalizeDsn(dsn);
    this.chatCache = new Map();
    this.chatLoading = new Map();
    this.accountCache = null;
    this.accountLoading = null;
  }

  url(path, params = {}) {
    const url = new URL(`https://${this.dsn.host}/api/v1${path}`);
    if (this.dsn.port) url.searchParams.set("port", this.dsn.port);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  async request(method, path, { params, form, body, retrySafe = method === "GET" } = {}) {
    const attempts = retrySafe ? READ_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const headers = { "X-API-KEY": this.apiKey, Accept: "application/json" };
      const init = { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) };
      if (form) {
        const data = new FormData();
        for (const [key, value] of Object.entries(form)) {
          if (value !== undefined && value !== null) data.append(key, String(value));
        }
        init.body = data;
      } else if (body) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }

      let response;
      try {
        response = await fetch(this.url(path, params), init);
      } catch (error) {
        if (attempt === attempts - 1) throw new Error(`Unipile is unreachable: ${error.message}`);
        await sleep(350 * 2 ** attempt);
        continue;
      }
      const text = await response.text();
      if (response.ok) {
        if (!text) return null;
        try { return JSON.parse(text); } catch { return text; }
      }
      if (retrySafe && (response.status === 429 || response.status >= 500) && attempt < attempts - 1) {
        await sleep(350 * 2 ** attempt);
        continue;
      }
      throw new Error(`Unipile ${response.status}: ${text.slice(0, 300)}`);
    }
    throw new Error("Unipile request failed");
  }

  async listAllowedAccounts({ fresh = false } = {}) {
    if (!fresh && this.accountCache && Date.now() - this.accountCache.createdAt < SYNC_INTERVAL_MS) {
      return this.accountCache.items;
    }
    if (!fresh && this.accountLoading) return this.accountLoading;
    const loading = (async () => {
      const response = await this.request("GET", "/accounts");
      const byId = new Map((response?.items ?? []).map((account) => [account.id, account]));
      const items = LINKEDIN_SENDERS.map((sender) => ({
        ...sender,
        connected: Boolean(byId.get(sender.id)),
        actualName: byId.get(sender.id)?.name || null,
      }));
      this.accountCache = { createdAt: Date.now(), items };
      return items;
    })().finally(() => { this.accountLoading = null; });
    if (!fresh) this.accountLoading = loading;
    return loading;
  }

  async listAllChats(accountId) {
    const cached = this.chatCache.get(accountId);
    if (cached && Date.now() - cached.createdAt < SYNC_INTERVAL_MS) return cached.items;
    if (this.chatLoading.has(accountId)) return this.chatLoading.get(accountId);
    const loading = (async () => {
      const items = [];
      let cursor = null;
      let pages = 0;
      do {
        const response = await this.request("GET", "/chats", {
          params: { account_id: accountId, cursor, limit: 100 },
        });
        items.push(...(response?.items ?? []));
        cursor = response?.cursor ?? null;
        pages += 1;
      } while (cursor && pages < 30);
      this.chatCache.set(accountId, { createdAt: Date.now(), items });
      return items;
    })().finally(() => this.chatLoading.delete(accountId));
    this.chatLoading.set(accountId, loading);
    return loading;
  }

  async resolveProviderId(person) {
    if (person.linkedinUrn) return person.linkedinUrn;
    const slug = linkedinSlug(person.linkedinUrl);
    if (!slug) return null;
    for (const sender of LINKEDIN_SENDERS) {
      try {
        const profile = await this.request("GET", `/users/${encodeURIComponent(slug)}`, {
          params: { account_id: sender.id },
        });
        const providerId = profile?.provider_id || profile?.id;
        if (providerId) return providerId;
      } catch {
        // A profile can be unavailable from one sender and resolvable from another.
      }
    }
    return null;
  }

  async getMessages(chatId) {
    const response = await this.request("GET", `/chats/${encodeURIComponent(chatId)}/messages`, {
      params: { limit: 30 },
    });
    return (response?.items ?? [])
      .map((message) => ({
        id: message.id,
        text: message.text || "",
        timestamp: message.timestamp || null,
        isSender: message.is_sender === 1,
      }))
      .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  }

  async getConversations(person) {
    const recipientProviderId = await this.resolveProviderId(person);
    if (!recipientProviderId) return { conversations: [], recipientProviderId: null };
    const connected = (await this.listAllowedAccounts()).filter((account) => account.connected);
    const matches = await Promise.all(connected.map(async (sender) => {
      const chats = await this.listAllChats(sender.id);
      const chat = chats
        .filter((item) => item.attendee_provider_id === recipientProviderId)
        .sort((a, b) => String(b.timestamp || b.last_message?.timestamp).localeCompare(String(a.timestamp || a.last_message?.timestamp)))[0];
      if (!chat?.id) return null;
      return {
        accountId: sender.id,
        accountName: sender.name,
        chatId: chat.id,
        lastMessageAt: chat.timestamp || chat.last_message?.timestamp || null,
        messages: await this.getMessages(chat.id),
      };
    }));
    return {
      recipientProviderId,
      conversations: matches.filter(Boolean).sort((a, b) =>
        String(b.lastMessageAt).localeCompare(String(a.lastMessageAt))
      ),
    };
  }

  async verifyExistingConversation({ accountId, chatId, recipientProviderId }) {
    if (!LINKEDIN_SENDERS.some((sender) => sender.id === accountId)) {
      throw new Error("That LinkedIn sender is not allowed");
    }
    const accounts = await this.listAllowedAccounts({ fresh: true });
    if (!accounts.some((account) => account.id === accountId && account.connected)) {
      throw new Error("That LinkedIn sender is not connected");
    }
    if (!chatId || !recipientProviderId) {
      throw new Error("An existing verified LinkedIn conversation is required");
    }
    const chat = await this.request("GET", `/chats/${encodeURIComponent(chatId)}`);
    if (chat?.account_id !== accountId) {
      throw new Error("That conversation belongs to a different LinkedIn sender");
    }
    if (chat?.attendee_provider_id !== recipientProviderId) {
      throw new Error("That conversation belongs to a different LinkedIn contact");
    }
    if (chat?.read_only === true) {
      throw new Error("That LinkedIn conversation is read-only");
    }
    return chat;
  }

  async sendMessage({ accountId, chatId, recipientProviderId, text }) {
    if (chatId) {
      await this.verifyExistingConversation({ accountId, chatId, recipientProviderId });
      const response = await this.request("POST", `/chats/${encodeURIComponent(chatId)}/messages`, {
        form: { account_id: accountId, text },
        retrySafe: false,
      });
      this.chatCache.delete(accountId);
      return {
        chatId,
        messageId: response?.id || response?.message_id || null,
      };
    }
    if (!LINKEDIN_SENDERS.some((sender) => sender.id === accountId)) {
      throw new Error("That LinkedIn sender is not allowed");
    }
    if (!recipientProviderId) throw new Error("The contact has no resolvable LinkedIn identity");
    const response = await this.request("POST", "/chats", {
      form: { account_id: accountId, text, attendees_ids: recipientProviderId },
      retrySafe: false,
    });
    this.chatCache.delete(accountId);
    return {
      chatId: response?.chat_id || response?.id || response?.chat?.id || null,
      messageId: response?.message_id || response?.message?.id || null,
    };
  }
}
