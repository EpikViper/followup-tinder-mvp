import { LINKEDIN_SENDERS, REPS } from "./constants.js";

function clone(value) {
  return structuredClone(value);
}

export class MockAttioClient {
  constructor() {
    this.reset();
  }

  reset() {
    this.companies = [
      {
        companyId: "company-oyster",
        entryId: "entry-oyster",
        companyName: "Oyster",
        source: "LinkedIn Campaign",
        domains: ["oysterhr.com"],
        stage: "Unprocessed",
        ownerId: REPS[0].id,
        lastInteractionDate: "2026-08-25",
        followUpCount: 0,
        lastInteractionBy: "Them",
        meetingStatus: null,
        addedAt: "2026-08-25T10:00:00Z",
        contacts: [
          {
            id: "person-maya",
            name: "Maya Patel",
            emails: ["maya@oysterhr.com"],
            linkedinUrl: "https://www.linkedin.com/in/mayapatel",
            linkedinUrn: "urn-maya",
          },
          {
            id: "person-jules",
            name: "Jules Hart",
            emails: ["jules@oysterhr.com", "jules.hart@example.com"],
            linkedinUrl: null,
            linkedinUrn: null,
          },
        ],
      },
      {
        companyId: "company-vanta",
        entryId: "entry-vanta",
        companyName: "Vanta",
        source: "LinkedIn Campaign",
        domains: ["vanta.com"],
        stage: "Qualified",
        ownerId: REPS[0].id,
        lastInteractionDate: "2026-08-26",
        followUpCount: 1,
        lastInteractionBy: "Them",
        meetingStatus: null,
        addedAt: "2026-08-10T10:00:00Z",
        contacts: [{
          id: "person-alex",
          name: "Alex Morgan",
          emails: ["alex@vanta.com"],
          linkedinUrl: "https://www.linkedin.com/in/alexmorgan",
          linkedinUrn: "urn-alex",
        }],
      },
      {
        companyId: "company-sana",
        entryId: "entry-sana",
        companyName: "Sana",
        domains: ["sana.ai"],
        stage: "Meeting Booked",
        ownerId: REPS[0].id,
        lastInteractionDate: "2026-08-20",
        followUpCount: 2,
        lastInteractionBy: "Us",
        meetingStatus: "No show",
        addedAt: "2026-08-01T10:00:00Z",
        contacts: [{
          id: "person-sofia",
          name: "Sofia Lind",
          emails: ["sofia@sana.ai"],
          linkedinUrl: "https://www.linkedin.com/in/sofialind",
          linkedinUrn: "urn-sofia",
        }],
      },
      {
        companyId: "company-pigment",
        entryId: "entry-pigment",
        companyName: "Pigment",
        domains: ["gopigment.com"],
        stage: "Qualified",
        ownerId: REPS[0].id,
        lastInteractionDate: "2026-08-21",
        followUpCount: 3,
        lastInteractionBy: "Us",
        meetingStatus: null,
        addedAt: "2026-07-20T10:00:00Z",
        contacts: [{
          id: "person-theo",
          name: "Theo Barnes",
          emails: ["theo@gopigment.com"],
          linkedinUrl: "https://www.linkedin.com/in/theobarnes",
          linkedinUrn: "urn-theo",
        }],
      },
      {
        companyId: "company-airwallex",
        entryId: "entry-airwallex",
        companyName: "Airwallex",
        domains: ["airwallex.com"],
        stage: "Unprocessed",
        ownerId: REPS[1].id,
        lastInteractionDate: "2026-08-24",
        followUpCount: 0,
        lastInteractionBy: "Them",
        meetingStatus: null,
        addedAt: "2026-08-24T10:00:00Z",
        contacts: [{
          id: "person-rina",
          name: "Rina Chen",
          emails: ["rina@airwallex.com"],
          linkedinUrl: "https://www.linkedin.com/in/rinachen",
          linkedinUrn: "urn-rina",
        }],
      },
    ];
    this.notes = {
      "company-oyster": [
        { id: "note-1", title: "LinkedIn conversation", body: "Maya asked for more detail about the workflow and how quickly the team can start.", createdAt: "2026-08-25T12:00:00Z" },
        { id: "note-2", title: "Qualification note", body: "RevOps owns outbound operations. Current process is manual.", createdAt: "2026-08-20T09:00:00Z" },
      ],
      "company-vanta": [
        { id: "note-3", title: "Latest reply", body: "Asked whether the system can work with their current Attio setup.", createdAt: "2026-08-26T08:30:00Z" },
      ],
    };
  }

  async getPipelineData(ownerId) {
    return clone(this.companies.filter((company) => company.ownerId === ownerId));
  }

  findByEntry(entryId) {
    const company = this.companies.find((item) => item.entryId === entryId);
    if (!company) throw new Error("Mock company not found");
    return company;
  }

  async patchStageIfCurrent(entryId, expected, next) {
    const company = this.findByEntry(entryId);
    if (company.stage !== expected) return { changed: false, currentStage: company.stage };
    company.stage = next;
    return { changed: true, currentStage: next };
  }

  async markNotQualified(entryId) {
    const company = this.findByEntry(entryId);
    company.stage = "Not qualified";
    return { changed: true, currentStage: company.stage };
  }

  async markLost(entryId) {
    const company = this.findByEntry(entryId);
    company.stage = "Lost";
    return { changed: true, currentStage: company.stage };
  }

  async updatePersonLinkedin(personId, url) {
    for (const company of this.companies) {
      const person = company.contacts.find((contact) => contact.id === personId);
      if (person) {
        person.linkedinUrl = url;
        person.linkedinUrn ||= `urn-${personId}`;
        return clone(person);
      }
    }
    throw new Error("Mock person not found");
  }

  async repairInteraction({ entryId, direction, date }) {
    const company = this.findByEntry(entryId);
    const incremented = direction === "Us" && company.lastInteractionBy === "Us" && date > company.lastInteractionDate && company.stage === "Qualified";
    company.lastInteractionBy = direction;
    company.lastInteractionDate = date;
    if (incremented) company.followUpCount += 1;
    const stageChanged = company.stage === "Unprocessed" && direction === "Us";
    if (stageChanged) company.stage = "Qualified";
    return { incremented, followUpCount: company.followUpCount, stageChanged };
  }

  async getNotes(companyId) {
    return clone(this.notes[companyId] || []);
  }

  simulateOutbound(personId) {
    const company = this.companies.find((item) => item.contacts.some((contact) => contact.id === personId));
    if (!company) return;
    company.lastInteractionBy = "Us";
    company.lastInteractionDate = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tbilisi" });
  }
}

export class MockUnipileClient {
  constructor() {
    this.reset();
  }

  reset() {
    this.messages = new Map([
      ["chat-maya-sandro", [
        { id: "m1", text: "Thanks for connecting — are follow-ups still mostly manual?", timestamp: "2026-08-24T10:00:00Z", isSender: true },
        { id: "m2", text: "Mostly, yes. What did you have in mind?", timestamp: "2026-08-25T12:00:00Z", isSender: false },
      ]],
      ["chat-alex-rezi", [
        { id: "m3", text: "Could this work with Attio?", timestamp: "2026-08-26T08:30:00Z", isSender: false },
      ]],
      ["chat-theo-sandro", [
        { id: "m4", text: "Send me the short version.", timestamp: "2026-08-21T12:00:00Z", isSender: false },
      ]],
    ]);
  }

  async listAllowedAccounts() {
    return clone(LINKEDIN_SENDERS);
  }

  async getConversations(person) {
    const matches = [];
    if (person.id === "person-maya") matches.push({ accountId: LINKEDIN_SENDERS[0].id, accountName: LINKEDIN_SENDERS[0].name, chatId: "chat-maya-sandro", lastMessageAt: "2026-08-25T12:00:00Z", messages: clone(this.messages.get("chat-maya-sandro")) });
    if (person.id === "person-alex") matches.push({ accountId: LINKEDIN_SENDERS[2].id, accountName: LINKEDIN_SENDERS[2].name, chatId: "chat-alex-rezi", lastMessageAt: "2026-08-26T08:30:00Z", messages: clone(this.messages.get("chat-alex-rezi")) });
    if (person.id === "person-theo") matches.push({ accountId: LINKEDIN_SENDERS[0].id, accountName: LINKEDIN_SENDERS[0].name, chatId: "chat-theo-sandro", lastMessageAt: "2026-08-21T12:00:00Z", messages: clone(this.messages.get("chat-theo-sandro")) });
    return { conversations: matches, recipientProviderId: person.linkedinUrn || null };
  }

  async sendMessage({ accountId, chatId, recipientProviderId, text }) {
    const id = `mock-message-${Date.now()}`;
    const resolvedChatId = chatId || `mock-chat-${accountId}-${recipientProviderId}`;
    const history = this.messages.get(resolvedChatId) || [];
    history.push({ id, text, timestamp: new Date().toISOString(), isSender: true });
    this.messages.set(resolvedChatId, history);
    return { messageId: id, chatId: resolvedChatId };
  }
}

export class MockSendPilotClient {
  constructor() {
    this.reset();
  }

  reset() {
    this.messages = new Map([
      ["sendpilot-maya-sandro", [
        { id: "m1", text: "Thanks for connecting — are follow-ups still mostly manual?", timestamp: "2026-08-24T10:00:00Z", isSender: true },
        { id: "m2", text: "Mostly, yes. What did you have in mind?", timestamp: "2026-08-25T12:00:00Z", isSender: false },
      ]],
      ["sendpilot-alex-revaz", [
        { id: "m3", text: "Could this work with Attio?", timestamp: "2026-08-26T08:30:00Z", isSender: false },
      ]],
      ["sendpilot-sofia-sergi", [
        { id: "m4", text: "Should we find another time?", timestamp: "2026-08-20T09:15:00Z", isSender: true },
      ]],
    ]);
    this.routes = new Map([
      ["https://www.linkedin.com/in/mayapatel", {
        leadId: "sendpilot-lead-maya", senderId: LINKEDIN_SENDERS[0].id, senderName: LINKEDIN_SENDERS[0].name,
        campaignName: "Revcode Campaign Europe", conversationId: "sendpilot-maya-sandro",
      }],
      ["https://www.linkedin.com/in/alexmorgan", {
        leadId: "sendpilot-lead-alex", senderId: LINKEDIN_SENDERS[2].id, senderName: LINKEDIN_SENDERS[2].name,
        campaignName: "Revcode Campaign US", conversationId: "sendpilot-alex-revaz",
      }],
      ["https://www.linkedin.com/in/sofialind", {
        leadId: "sendpilot-lead-sofia", senderId: LINKEDIN_SENDERS[1].id, senderName: LINKEDIN_SENDERS[1].name,
        campaignName: "Revcode Campaign Europe", conversationId: "sendpilot-sofia-sergi",
      }],
    ]);
  }

  async listAllowedSenders() {
    return LINKEDIN_SENDERS.map((sender) => ({ ...sender, connected: true, status: "active", remainingMessages: 40 }));
  }

  async getRoutingForPerson(person) {
    const route = this.routes.get(person.linkedinUrl);
    if (person.id === "person-theo") {
      return {
        source: "sendpilot_campaign",
        verified: false,
        reason: "No matching SendPilot lead for this conversation",
        campaignCount: 0,
        senderId: "sendpilot-sandro",
        senderName: LINKEDIN_SENDERS[0].name,
        conversationId: "sendpilot-theo-sandro",
        lastActivityAt: "2026-08-21T12:00:00Z",
        messages: [{ id: "m4", text: "Send me the short version.", timestamp: "2026-08-21T12:00:00Z", isSender: false }],
        fallbackEligible: true,
      };
    }
    if (!route) return { source: "manual", reason: "Not in SendPilot" };
    return {
      source: "sendpilot_campaign",
      verified: true,
      ...clone(route),
      senderRemainingMessages: 40,
      messages: clone(this.messages.get(route.conversationId) || []),
    };
  }

  async syncRoutingsForPeople(people) {
    return Promise.all(people.map((person) => this.getRoutingForPerson(person)));
  }

  async verifyRoute({ leadId, senderId, linkedinUrl }) {
    const route = this.routes.get(linkedinUrl);
    if (!route || route.leadId !== leadId || route.senderId !== senderId) {
      throw new Error("The SendPilot conversation sender could not be verified");
    }
    return route;
  }

  async sendMessageToLead({ leadId, senderId, message }) {
    const route = [...this.routes.values()].find((item) => item.leadId === leadId && item.senderId === senderId);
    if (!route) throw new Error("The SendPilot conversation sender could not be verified");
    const messageId = `mock-sendpilot-message-${Date.now()}`;
    this.messages.get(route.conversationId).push({ id: messageId, text: message, timestamp: new Date().toISOString(), isSender: true });
    return { messageId, status: "sent" };
  }

  async completeLead(leadId) {
    const route = [...this.routes.values()].find((item) => item.leadId === leadId);
    if (!route) throw new Error("SendPilot lead not found");
    route.completed = true;
  }
}

export class MockGmailClient {
  constructor() {
    this.configured = true;
  }

  async findLatestThread({ ownerId, email }) {
    if (ownerId === REPS[0].id && email.toLowerCase() === "maya@oysterhr.com") {
      return {
        found: true,
        mailbox: "sandro@stimuli.digital",
        threadId: "mock-gmail-thread-maya",
        subject: "Re: Oyster follow-up",
        lastMessageAt: "2026-08-25T12:00:00.000Z",
        url: "https://mail.google.com/mail/u/sandro@stimuli.digital/#all/mock-gmail-thread-maya",
      };
    }
    return { found: false };
  }

  reset() {}
}
