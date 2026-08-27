import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { AttioClient } from "./src/attio.js";
import { QUEUE_LABELS, REPS, SYNC_INTERVAL_MS, TIME_ZONE } from "./src/constants.js";
import { GmailClient } from "./src/gmail.js";
import { MockAttioClient, MockGmailClient, MockSendPilotClient, MockUnipileClient } from "./src/mock.js";
import { addUnipileFallback, addUnipileFallbacks, routingChoices } from "./src/linkedin-routing.js";
import { buildQueue, dateInTbilisi } from "./src/queue.js";
import { SendPilotClient } from "./src/sendpilot.js";
import { LocalStore } from "./src/store.js";
import { UnipileClient } from "./src/unipile.js";

const projectDir = path.dirname(fileURLToPath(import.meta.url));

function cleanText(value, maxLength) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maxLength) return null;
  return text;
}

function normalizeLinkedinUrl(value) {
  const raw = String(value || "").trim();
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(withScheme);
    if (!/(^|\.)linkedin\.com$/i.test(parsed.hostname)) throw new Error();
    const match = parsed.pathname.match(/^\/in\/([^/?#]+)/i);
    if (!match?.[1]) throw new Error();
    return `https://www.linkedin.com/in/${decodeURIComponent(match[1])}`;
  } catch {
    throw new Error("Enter a valid linkedin.com/in/... profile URL");
  }
}

function validRep(ownerId) {
  return REPS.some((rep) => rep.id === ownerId);
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email) || email.length > 254) return null;
  return email;
}

function publicError(error) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/X-API-KEY[^,}]*/gi, "X-API-KEY [redacted]")
    .slice(0, 500);
}

export function createApp(options = {}) {
  const mock = options.mock ?? (process.argv.includes("--mock") || process.env.MOCK_MODE === "true");
  const requestedEmailComposer = String(options.emailComposerProvider || process.env.EMAIL_COMPOSER_PROVIDER || "gmail").toLowerCase();
  const emailComposerProvider = requestedEmailComposer === "outlook" ? "outlook" : "gmail";
  const dataDir = options.dataDir || process.env.FOLLOWUP_DATA_DIR || path.join(projectDir, "data");
  const store = options.store || new LocalStore(path.resolve(projectDir, dataDir));
  const attio = options.attio || (mock ? new MockAttioClient() : new AttioClient());
  const sendpilot = options.sendpilot || (mock ? new MockSendPilotClient() : new SendPilotClient());
  const unipile = options.unipile || (mock ? new MockUnipileClient() : new UnipileClient());
  const gmail = options.gmail || (mock ? new MockGmailClient() : new GmailClient());
  const unipileAuthorizations = new Map();
  const emailAuthorizations = new Map();
  const app = express();

  function authorizationKey(entryId, personId, accountId, chatId) {
    return [entryId, personId, accountId, chatId].join(":");
  }

  function authorizeFallback(entryId, personId, routing) {
    for (const choice of routingChoices(routing)) {
      if (choice.source !== "unipile_fallback" || !choice.verified) continue;
      unipileAuthorizations.set(
        authorizationKey(entryId, personId, choice.senderId, choice.chatId),
        {
          recipientProviderId: choice.recipientProviderId,
          expiresAt: Date.now() + SYNC_INTERVAL_MS,
        }
      );
    }
  }

  function cleanAuthorizations() {
    const now = Date.now();
    for (const [key, authorization] of unipileAuthorizations) {
      if (authorization.expiresAt <= now) unipileAuthorizations.delete(key);
    }
  }

  function authorizeQueueEmails(ownerId, queue) {
    const prefix = `${ownerId}:`;
    for (const key of emailAuthorizations.keys()) {
      if (key.startsWith(prefix)) emailAuthorizations.delete(key);
    }
    const expiresAt = Date.now() + SYNC_INTERVAL_MS;
    for (const company of queue) {
      for (const contact of company.contacts || []) {
        for (const value of contact.emails || []) {
          const email = normalizeEmail(value);
          if (email) emailAuthorizations.set(`${ownerId}:${email}`, expiresAt);
        }
      }
    }
  }

  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
    next();
  });

  async function syncQueue(ownerId) {
    let companies = await attio.getPipelineData(ownerId);
    const promotable = companies.filter((company) =>
      company.stage === "Unprocessed" && company.lastInteractionBy === "Us" && company.entryId
    );
    if (promotable.length) {
      await Promise.all(promotable.map((company) =>
        attio.patchStageIfCurrent(company.entryId, "Unprocessed", "Qualified")
      ));
      companies = await attio.getPipelineData(ownerId);
    }
    const queue = buildQueue(companies).map((company) => ({
      ...company,
      queueLabel: QUEUE_LABELS[company.queueType],
    }));

    const contactsById = new Map();
    for (const company of queue) {
      for (const contact of company.contacts || []) {
        contactsById.set(contact.id, contact);
      }
    }
    const contacts = [...contactsById.values()];
    const sendpilotRoutings = await sendpilot.syncRoutingsForPeople(contacts);
    const routings = await addUnipileFallbacks(contacts, sendpilotRoutings, unipile);
    const routingByContactId = new Map(contacts.map((contact, index) => [contact.id, routings[index]]));
    cleanAuthorizations();

    const routedQueue = queue.map((company) => ({
      ...company,
      contacts: (company.contacts || []).map((contact) => {
        const sendpilotRoute = routingByContactId.get(contact.id);
        if (sendpilotRoute) authorizeFallback(company.entryId, contact.id, sendpilotRoute);
        return sendpilotRoute ? { ...contact, sendpilot: sendpilotRoute } : contact;
      }),
    }));
    authorizeQueueEmails(ownerId, routedQueue);
    return routedQueue;
  }

  app.get("/api/health", (req, res) => {
    res.json({ ok: true, mode: mock ? "mock" : "live", timeZone: TIME_ZONE });
  });

  app.get("/api/config", (req, res) => {
    res.json({
      reps: REPS,
      syncIntervalMs: SYNC_INTERVAL_MS,
      timeZone: TIME_ZONE,
      mode: mock ? "mock" : "live",
      emailComposerProvider,
      gmailThreadLookupEnabled: emailComposerProvider === "gmail" && gmail.configured,
    });
  });

  app.post("/api/sync", async (req, res, next) => {
    try {
      const ownerId = cleanText(req.body.ownerId, 100);
      if (!ownerId || !validRep(ownerId)) return res.status(400).json({ error: "Choose a valid rep" });
      const queue = await syncQueue(ownerId);
      res.json({ queue, syncedAt: new Date().toISOString() });
    } catch (error) { next(error); }
  });

  app.post("/api/email/resolve", async (req, res, next) => {
    try {
      const ownerId = cleanText(req.body.ownerId, 100);
      const email = normalizeEmail(req.body.email);
      if (!ownerId || !validRep(ownerId) || !email) {
        return res.status(400).json({ error: "A valid queue owner and contact email are required" });
      }
      const expiresAt = emailAuthorizations.get(`${ownerId}:${email}`);
      if (!expiresAt || expiresAt <= Date.now()) {
        return res.status(409).json({ error: "Sync the queue before looking up this email thread" });
      }
      res.json(await gmail.findLatestThread({ ownerId, email }));
    } catch (error) { next(error); }
  });

  app.get("/api/companies/:companyId/notes", async (req, res, next) => {
    try {
      res.json({ notes: await attio.getNotes(req.params.companyId) });
    } catch (error) { next(error); }
  });

  app.patch("/api/people/:personId/linkedin", async (req, res, next) => {
    try {
      const url = normalizeLinkedinUrl(req.body.url);
      await attio.updatePersonLinkedin(req.params.personId, url);
      res.json({ ok: true, url });
    } catch (error) { next(error); }
  });

  app.post("/api/entries/:entryId/not-qualified", async (req, res, next) => {
    try {
      await attio.markNotQualified(req.params.entryId);
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  app.post("/api/entries/:entryId/lost", async (req, res, next) => {
    try {
      await attio.markLost(req.params.entryId);
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  app.post("/api/interactions/repair", async (req, res, next) => {
    try {
      const entryId = cleanText(req.body.entryId, 100);
      const companyId = cleanText(req.body.companyId, 100);
      const direction = req.body.direction;
      const date = cleanText(req.body.date, 10) || dateInTbilisi();
      if (!entryId || !companyId || !["Us", "Them"].includes(direction) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: "Invalid interaction repair" });
      }
      res.json({ ok: true, ...(await attio.repairInteraction({ entryId, companyId, direction, date })) });
    } catch (error) { next(error); }
  });

  app.get("/api/templates", (req, res) => {
    res.json({ templates: store.listTemplates() });
  });

  app.post("/api/templates", (req, res) => {
    const name = cleanText(req.body.name, 80);
    const body = cleanText(req.body.body, 5000);
    if (!name || !body) return res.status(400).json({ error: "Template name and message are required" });
    res.status(201).json({ template: store.createTemplate({ name, body }) });
  });

  app.patch("/api/templates/:id", (req, res) => {
    const name = cleanText(req.body.name, 80);
    const body = cleanText(req.body.body, 5000);
    if (!name || !body) return res.status(400).json({ error: "Template name and message are required" });
    const template = store.updateTemplate(req.params.id, { name, body });
    if (!template) return res.status(404).json({ error: "Template not found" });
    res.json({ template });
  });

  app.delete("/api/templates/:id", (req, res) => {
    if (!store.deleteTemplate(req.params.id)) return res.status(404).json({ error: "Template not found" });
    res.status(204).end();
  });

  app.post("/api/sendpilot/resolve", async (req, res, next) => {
    try {
      const name = cleanText(req.body.name, 200);
      const linkedinUrl = cleanText(req.body.linkedinUrl, 500);
      const linkedinUrn = cleanText(req.body.linkedinUrn, 500);
      const entryId = cleanText(req.body.entryId, 100);
      const personId = cleanText(req.body.personId, 100);
      if (!name) return res.status(400).json({ error: "Contact name is required" });
      const person = { id: personId, name, linkedinUrl, linkedinUrn };
      const routing = await addUnipileFallback(await sendpilot.getRoutingForPerson(person), person, unipile);
      if (entryId && personId) authorizeFallback(entryId, personId, routing);
      res.json(routing);
    } catch (error) { next(error); }
  });

  app.post("/api/unipile/send", async (req, res, next) => {
    const idempotencyKey = cleanText(req.body.idempotencyKey, 100);
    const entryId = cleanText(req.body.entryId, 100);
    const personId = cleanText(req.body.personId, 100);
    const accountId = cleanText(req.body.senderId, 100);
    const chatId = cleanText(req.body.chatId, 200);
    const message = cleanText(req.body.message, 5000);
    if (!idempotencyKey || !entryId || !personId || !accountId || !chatId || !message) {
      return res.status(400).json({ error: "An existing sender conversation, contact, message, and idempotency key are required" });
    }

    cleanAuthorizations();
    const authorization = unipileAuthorizations.get(authorizationKey(entryId, personId, accountId, chatId));
    if (!authorization) {
      return res.status(409).json({ error: "This Unipile fallback is stale or was not verified. Sync before trying again." });
    }
    const started = store.beginSend({ idempotencyKey, entryId, personId, accountId, chatId, text: message });
    if (!started.created) {
      if (started.receipt.status === "sent") return res.json({ ok: true, duplicate: true, receipt: started.receipt });
      return res.status(409).json({ error: `This send is already ${started.receipt.status}. Refresh the conversation before trying again.` });
    }

    try {
      const sent = await unipile.sendMessage({
        accountId,
        chatId,
        recipientProviderId: authorization.recipientProviderId,
        text: message,
      });
      const receipt = store.completeSend(idempotencyKey, {
        providerMessageId: sent.messageId,
        chatId: sent.chatId,
      });
      if (mock && typeof attio.simulateOutbound === "function") attio.simulateOutbound(personId);
      res.json({ ok: true, provider: "unipile", receipt });
    } catch (error) {
      store.failSend(idempotencyKey, publicError(error));
      next(error);
    }
  });

  app.post("/api/sendpilot/send", async (req, res, next) => {
    const idempotencyKey = cleanText(req.body.idempotencyKey, 100);
    const entryId = cleanText(req.body.entryId, 100);
    const personId = cleanText(req.body.personId, 100);
    const leadId = cleanText(req.body.leadId, 100);
    const senderId = cleanText(req.body.senderId, 100);
    const contactName = cleanText(req.body.contactName, 200);
    const linkedinUrl = cleanText(req.body.linkedinUrl, 500);
    const message = cleanText(req.body.message, 5000);
    if (!idempotencyKey || !entryId || !personId || !leadId || !senderId || !contactName || !linkedinUrl || !message) {
      return res.status(400).json({ error: "Sender, contact, message, and idempotency key are required" });
    }

    const started = store.beginSend({ idempotencyKey, entryId, personId, accountId: senderId, chatId: leadId, text: message });
    if (!started.created) {
      if (started.receipt.status === "sent") return res.json({ ok: true, duplicate: true, receipt: started.receipt });
      return res.status(409).json({ error: `This send is already ${started.receipt.status}. Refresh the conversation before trying again.` });
    }

    try {
      await sendpilot.verifyRoute({ leadId, senderId, linkedinUrl, contactName });
      const sent = await sendpilot.sendMessageToLead({ leadId, senderId, message });
      try {
        await sendpilot.completeLead(leadId);
      } catch (error) {
        store.failSend(idempotencyKey, `Message sent, but SendPilot could not stop the campaign: ${publicError(error)}`);
        return res.status(502).json({ error: "Message was sent, but SendPilot could not stop the campaign. Check that lead in SendPilot before sending again." });
      }
      const receipt = store.completeSend(idempotencyKey, {
        providerMessageId: sent.messageId,
        chatId: leadId,
      });
      if (mock && typeof attio.simulateOutbound === "function") attio.simulateOutbound(personId);
      res.json({ ok: true, receipt });
    } catch (error) {
      store.failSend(idempotencyKey, publicError(error));
      next(error);
    }
  });

  if (mock) {
    app.post("/api/test/reset", (req, res) => {
      attio.reset?.();
      sendpilot.reset?.();
      unipile.reset?.();
      gmail.reset?.();
      unipileAuthorizations.clear();
      emailAuthorizations.clear();
      res.json({ ok: true });
    });
  }

  app.get("/", (req, res) => res.sendFile(path.join(projectDir, "index.html")));
  app.get("/styles.css", (req, res) => res.sendFile(path.join(projectDir, "styles.css")));
  app.get("/sendpilot.css", (req, res) => res.sendFile(path.join(projectDir, "sendpilot.css")));
  app.get("/email.css", (req, res) => res.sendFile(path.join(projectDir, "email.css")));
  app.get("/app.js", (req, res) => res.sendFile(path.join(projectDir, "app.js")));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(500).json({ error: publicError(error) });
  });

  return { app, store, attio, sendpilot, unipile, gmail, mock };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app } = createApp();
  const port = Number(process.env.PORT || 4317);
  const host = process.env.HOST || "127.0.0.1";
  app.listen(port, host, () => {
    console.log(`Followup is ready at http://${host}:${port}`);
  });
}
