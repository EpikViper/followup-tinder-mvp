import { LINKEDIN_SENDERS, SYNC_INTERVAL_MS } from "./constants.js";
import { canonicalLinkedinUrl, findConversationCandidates, normalizePersonName } from "./identity.js";

const API = "https://api.sendpilot.ai/v1";
const TIMEOUT_MS = 45_000;
const READ_ATTEMPTS = 3;
const INDEX_TTL_MS = SYNC_INTERVAL_MS;
const CONVERSATION_TTL_MS = SYNC_INTERVAL_MS;
const MESSAGE_TTL_MS = SYNC_INTERVAL_MS;
const PAGE_SIZE = 100;
const MAX_CONCURRENT_REQUESTS = 2;
// DONE means the automated sequence is stopped, but an existing first-degree
// conversation can still receive a deliberate one-off follow-up. The other
// statuses are hard stops and must never be messaged from this tool.
const NON_CONTACTABLE_LEAD_STATUSES = new Set(["UNSUBSCRIBED", "BLOCKED", "IRRELEVANT", "SKIPPED"]);

function leadPriority(lead) {
  const campaignRank = lead.campaignStatus === "started" ? 0 : lead.campaignStatus === "paused" ? 1 : 2;
  const leadRank = lead.status === "DONE" ? 0 : 1;
  return [campaignRank, leadRank, String(lead.updatedAt || lead.createdAt || "")];
}

function chooseEligibleLead(leads) {
  return [...leads].sort((a, b) => {
    const aPriority = leadPriority(a);
    const bPriority = leadPriority(b);
    return aPriority[0] - bPriority[0]
      || aPriority[1] - bPriority[1]
      || bPriority[2].localeCompare(aPriority[2])
      || String(a.id).localeCompare(String(b.id));
  })[0] || null;
}

function allowedSender(sender) {
  return LINKEDIN_SENDERS.some((allowed) => allowed.name === sender.name);
}

function nameKey(value) {
  return normalizePersonName(value);
}

function leadNameKey(lead) {
  return nameKey(lead.name || `${lead.firstName || ""} ${lead.lastName || ""}`);
}

function toMessage(message) {
  return {
    id: message.id || message.messageId || null,
    text: message.content || message.text || "",
    timestamp: message.sentAt || message.timestamp || null,
    isSender: message.direction === "sent" || message.isSender === true,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SendPilotClient {
  constructor({ apiKey = process.env.SENDPILOT_API_KEY } = {}) {
    if (!apiKey) throw new Error("SENDPILOT_API_KEY is not configured");
    this.apiKey = apiKey;
    this.leadIndex = null;
    this.conversationIndex = null;
    this.leadIndexLoading = null;
    this.conversationIndexLoading = null;
    this.messageCache = new Map();
    this.activeRequests = 0;
    this.requestWaiters = [];
    this.backoffUntil = 0;
  }

  async request(path, init = {}) {
    if (this.activeRequests >= MAX_CONCURRENT_REQUESTS) {
      await new Promise((resolve) => this.requestWaiters.push(resolve));
    }
    this.activeRequests += 1;
    try {
      return await this.requestWithRetry(path, init);
    } finally {
      this.activeRequests -= 1;
      this.requestWaiters.shift()?.();
    }
  }

  async requestWithRetry(path, init = {}) {
    const method = init.method || "GET";
    const attempts = method === "GET" ? READ_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const backoffMs = Math.max(0, this.backoffUntil - Date.now());
      if (backoffMs) await sleep(backoffMs);
      let response;
      try {
        response = await fetch(`${API}${path}`, {
          ...init,
          headers: {
            "X-API-Key": this.apiKey,
            Accept: "application/json",
            ...(init.headers || {}),
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        const retryable = method === "GET" && attempt < attempts - 1;
        if (retryable) {
          await sleep(750 * 2 ** attempt);
          continue;
        }
        const cause = error?.cause?.code || error?.name;
        throw new Error(`SendPilot network error${cause ? ` (${cause})` : ""}`);
      }
      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      if (response.ok) return body;
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < attempts - 1) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
        if (response.status === 429) this.backoffUntil = Math.max(this.backoffUntil, Date.now() + delay);
        await sleep(delay);
        continue;
      }
      const message = typeof body === "object" ? body?.message || body?.error : text;
      throw new Error(`SendPilot ${response.status}: ${String(message || "Request failed").slice(0, 300)}`);
    }
    throw new Error("SendPilot request failed");
  }

  async listAllowedSenders() {
    const response = await this.request("/inbox/senders");
    return (response?.senders || []).filter(allowedSender).map((sender) => ({
      id: sender.id,
      name: sender.name,
      connected: sender.status === "active",
      status: sender.status,
      remainingMessages: sender.remainingMessages,
      dailyMessageLimit: sender.dailyMessageLimit,
      messagesSentToday: sender.messagesSentToday,
    }));
  }

  async listCampaigns() {
    const response = await this.request("/campaigns?limit=100");
    return response?.campaigns || [];
  }

  async listCampaignLeads(campaign) {
    const leads = [];
    let page = 1;
    while (true) {
      const response = await this.request(`/leads?campaignId=${encodeURIComponent(campaign.id)}&page=${page}&limit=${PAGE_SIZE}`);
      leads.push(...(response?.leads || []).map((lead) => ({
        ...lead,
        campaignName: campaign.name,
        campaignStatus: campaign.status,
        campaignSenderIds: Array.isArray(campaign.linkedInSenderIds) ? campaign.linkedInSenderIds : [],
      })));
      const pagination = response?.pagination;
      if (!pagination?.totalPages || page >= pagination.totalPages) break;
      page += 1;
    }
    return leads;
  }

  async getLeadIndex() {
    if (this.leadIndex && Date.now() - this.leadIndex.createdAt < INDEX_TTL_MS) return this.leadIndex;
    if (this.leadIndexLoading) return this.leadIndexLoading;
    this.leadIndexLoading = (async () => {
      const campaigns = (await this.listCampaigns()).filter((campaign) => Number(campaign.totalLeads) > 0);
      const groups = await Promise.all(campaigns.map((campaign) => this.listCampaignLeads(campaign)));
      const byUrl = new Map();
      const byId = new Map();
      const byName = new Map();
      for (const lead of groups.flat()) {
        const url = canonicalLinkedinUrl(lead.linkedinUrl);
        if (!lead.id) continue;
        if (url) {
          const values = byUrl.get(url) || [];
          values.push(lead);
          byUrl.set(url, values);
        }
        const name = leadNameKey(lead);
        if (name) {
          const values = byName.get(name) || [];
          values.push(lead);
          byName.set(name, values);
        }
        byId.set(lead.id, lead);
      }
      this.leadIndex = { createdAt: Date.now(), byUrl, byName, byId };
      return this.leadIndex;
    })().finally(() => { this.leadIndexLoading = null; });
    return this.leadIndexLoading;
  }

  async listSenderConversations(senderId) {
    const conversations = [];
    let continuationToken = null;
    do {
      const query = new URLSearchParams({ accountId: senderId, limit: String(PAGE_SIZE) });
      if (continuationToken) query.set("continuationToken", continuationToken);
      const response = await this.request(`/inbox/conversations?${query}`);
      conversations.push(...(response?.conversations || []).map((conversation) => ({ ...conversation, accountId: senderId })));
      continuationToken = response?.pagination?.hasMore ? response.pagination.continuationToken : null;
    } while (continuationToken);
    return conversations;
  }

  async getConversationIndex() {
    if (this.conversationIndex && Date.now() - this.conversationIndex.createdAt < CONVERSATION_TTL_MS) return this.conversationIndex;
    if (this.conversationIndexLoading) return this.conversationIndexLoading;
    this.conversationIndexLoading = (async () => {
      const senders = (await this.listAllowedSenders()).filter((sender) => sender.connected);
      const groups = await Promise.all(senders.map((sender) => this.listSenderConversations(sender.id)));
      const byUrl = new Map();
      const byName = new Map();
      for (const conversation of groups.flat()) {
        for (const participant of conversation.participants || []) {
          const url = canonicalLinkedinUrl(participant.profileUrl);
          if (url) {
            const values = byUrl.get(url) || [];
            values.push(conversation);
            byUrl.set(url, values);
          }
          const name = nameKey(participant.name);
          if (name) {
            const values = byName.get(name) || [];
            values.push(conversation);
            byName.set(name, values);
          }
        }
      }
      this.conversationIndex = { createdAt: Date.now(), byUrl, byName, senders };
      return this.conversationIndex;
    })().finally(() => { this.conversationIndexLoading = null; });
    return this.conversationIndexLoading;
  }

  async getConversationMessages(conversationId, accountId) {
    const cacheKey = `${accountId}:${conversationId}`;
    const cached = this.messageCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < MESSAGE_TTL_MS) return cached.messages;
    const query = new URLSearchParams({ accountId, limit: "30" });
    const response = await this.request(`/inbox/conversations/${encodeURIComponent(conversationId)}/messages?${query}`);
    const messages = (response?.messages || []).map(toMessage).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    this.messageCache.set(cacheKey, { createdAt: Date.now(), messages });
    return messages;
  }

  async syncRoutingsForPeople(people) {
    // Load SendPilot's complete lead and conversation indexes up front, then
    // resolve every relevant queue contact (including its message preview)
    // before returning the queue. The shared one-hour TTL prevents another
    // browser tab or a page reload from rebuilding fresh indexes unnecessarily.
    if (!people.length) {
      await Promise.allSettled([this.getLeadIndex(), this.getConversationIndex()]);
      return [];
    }
    return Promise.all(people.map((person) => this.getRoutingForPerson(person)));
  }

  async getRoutingForPerson(person) {
    const linkedinUrl = canonicalLinkedinUrl(person?.linkedinUrl);
    const contactName = nameKey(person?.name);
    try {
      const [leadIndex, conversationIndex] = await Promise.all([this.getLeadIndex(), this.getConversationIndex()]);
      // SendPilot may return an opaque LinkedIn member URL in the inbox even
      // when Attio stores the person's public /in/slug. Fall back to an exact
      // full-name match solely to load the thread; it is never enough to allow
      // an automated send.
      const urlLeads = linkedinUrl ? leadIndex.byUrl.get(linkedinUrl) || [] : [];
      const leads = urlLeads.length ? urlLeads : leadIndex.byName.get(contactName) || [];
      const conversationMatch = findConversationCandidates({
        person,
        leads,
        conversationIndex,
        linkedinLeadMatched: urlLeads.length > 0,
      });
      const conversations = conversationMatch.conversations;
      // Unipile may be used only when SendPilot has no campaign lead at all.
      // The presence of any possible lead keeps routing inside SendPilot so a
      // stopped, blocked, or unsubscribed sequence can never be bypassed.
      const fallbackEligible = leads.length === 0 && Boolean(linkedinUrl || person?.linkedinUrn);
      const byAccount = new Map();
      for (const conversation of conversations) {
        const existing = byAccount.get(conversation.accountId);
        if (!existing || String(conversation.lastActivityAt || conversation.updatedAt).localeCompare(String(existing.lastActivityAt || existing.updatedAt)) > 0) {
          byAccount.set(conversation.accountId, conversation);
        }
      }
      if (!byAccount.size) {
        return {
          source: leads.length ? "sendpilot_campaign" : "manual",
          verified: false,
          reason: leads.length ? "No verified SendPilot conversation" : "Not in SendPilot",
          campaignCount: leads.length,
          match: conversationMatch.evidence,
        };
      }
      const eligibleLeads = leads.filter((lead) => !NON_CONTACTABLE_LEAD_STATUSES.has(lead.status));
      const routes = await Promise.all([...byAccount].map(async ([senderId, conversation]) => {
        const sender = conversationIndex.senders.find((item) => item.id === senderId);
        const messages = await this.getConversationMessages(conversation.id, senderId);
        const base = {
          source: "sendpilot_campaign",
          verified: false,
          campaignCount: leads.length,
          senderId,
          senderName: sender?.name || "Unknown sender",
          senderRemainingMessages: sender?.remainingMessages,
          conversationId: conversation.id,
          lastActivityAt: conversation.lastActivityAt || conversation.updatedAt || null,
          match: conversationMatch.evidence,
          messages,
          fallbackEligible,
        };
        if (!sender?.connected) return { ...base, reason: "Sender is not active" };
        if (!urlLeads.length) {
          return {
            ...base,
            reason: fallbackEligible
              ? "SendPilot has no matching lead for this existing conversation"
              : "Conversation matched by name only; add the matching LinkedIn URL to send from here",
          };
        }
        const senderLeads = eligibleLeads.filter((lead) =>
          !lead.campaignSenderIds?.length || lead.campaignSenderIds.includes(senderId)
        );
        const selectedLead = chooseEligibleLead(senderLeads);
        if (!selectedLead) return { ...base, reason: "No eligible SendPilot lead for this conversation" };
        return {
          ...base,
          verified: true,
          leadId: selectedLead.id,
          leadStatus: selectedLead.status,
          candidateLeadCount: senderLeads.length,
          campaignName: selectedLead.campaignName,
          campaignStatus: selectedLead.campaignStatus,
        };
      }));
      routes.sort((a, b) => String(b.lastActivityAt).localeCompare(String(a.lastActivityAt)));
      if (routes.length === 1) return routes[0];
      return {
        source: "sendpilot_campaign",
        verified: false,
        reason: "Choose a SendPilot sender conversation",
        campaignCount: leads.length,
        routes,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message.replace(/X-API-Key[^,}]*/gi, "X-API-Key [redacted]") : "Request failed";
      return { source: "manual", reason: `SendPilot lookup failed: ${message.slice(0, 160)}` };
    }
  }

  async verifyRoute({ leadId, senderId, linkedinUrl, contactName }) {
    const [leadResponse, senders] = await Promise.all([
      this.request(`/leads/${encodeURIComponent(leadId)}`),
      this.listAllowedSenders(),
    ]);
    const lead = leadResponse?.data || leadResponse;
    const canonicalUrl = canonicalLinkedinUrl(linkedinUrl);
    if (!lead?.campaignId || !canonicalUrl || canonicalLinkedinUrl(lead.linkedinUrl) !== canonicalUrl || NON_CONTACTABLE_LEAD_STATUSES.has(lead.status)) {
      throw new Error("This is not a verified active SendPilot campaign lead");
    }
    const campaignResponse = await this.request(`/campaigns/${encodeURIComponent(lead.campaignId)}`);
    const campaign = campaignResponse?.data || campaignResponse;
    const sender = senders.find((item) => item.id === senderId && item.connected);
    const campaignSenders = Array.isArray(campaign?.linkedInSenderIds) ? campaign.linkedInSenderIds : [];
    if (!sender || (campaignSenders.length && !campaignSenders.includes(senderId))) {
      throw new Error("The SendPilot conversation sender could not be verified");
    }
    return lead;
  }

  async sendMessageToLead({ leadId, senderId, message }) {
    const result = await this.request(`/inbox/send/lead/${encodeURIComponent(leadId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderId, message }),
    });
    return { messageId: result?.messageId || null, status: result?.status || null };
  }

  async completeLead(leadId) {
    await this.request(`/leads/${encodeURIComponent(leadId)}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "DONE",
        note: "Manual follow-up sent from Followup.",
      }),
    });
    const cachedLead = this.leadIndex?.byId.get(leadId);
    if (cachedLead) cachedLead.status = "DONE";
  }
}
