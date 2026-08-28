const state = {
  config: null,
  queue: [],
  completedIds: new Set(),
  sessionOwner: null,
  selectedContacts: new Map(),
  navigationHistory: [],
  templates: [],
  templateTarget: "copy",
  sendpilotRoute: null,
  emailDraft: null,
  syncing: false,
  syncTimer: null,
  noteRequest: 0,
  activeStage: "Unprocessed",
  stageQueues: new Map(),
  stageHistories: new Map(),
};
const STAGES = ["Unprocessed", "Qualified", "Meeting Booked"];

const $ = (selector) => document.querySelector(selector);
const card = $("#lead-card");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 2600);
}

function current() {
  return state.queue[0] || null;
}

function selectedContact(company = current()) {
  if (!company?.contacts?.length) return null;
  const selectedId = state.selectedContacts.get(company.entryId);
  return company.contacts.find((contact) => contact.id === selectedId) || company.contacts[0];
}

function sourceBadge(contact, company) {
  const route = contact?.sendpilot;
  if (!route) {
    return '<span class="source-badge uncertain">SENDPILOT · CHECK ON OPEN</span>';
  }
  if (route.routes?.length) {
    return `<span class="source-badge uncertain">SENDPILOT · ${route.routes.length} CONVERSATIONS</span>`;
  }
  if (route?.source === "unipile_fallback" && route.verified) {
    return `<span class="source-badge sendpilot">UNIPILE FALLBACK - ${escapeHtml(route.senderName)}</span>`;
  }
  if (route?.source === "sendpilot_campaign" && route.verified) {
    return `<span class="source-badge sendpilot">SENDPILOT · ${escapeHtml(route.senderName)}</span>`;
  }
  if (route?.source === "sendpilot_campaign") {
    return '<span class="source-badge uncertain">SENDPILOT · MANUAL</span>';
  }
  return '<span class="source-badge manual">MANUAL</span>';
}

function attioSourceBadge(contact, company) {
  const source = contact?.source || company?.source;
  return source ? `<span class="source-badge campaign-source">${escapeHtml(source)}</span>` : "";
}

function formatDate(value) {
  if (!value) return "No date";
  const date = new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "Asia/Tbilisi" }).format(date);
}

function todayTbilisi() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tbilisi", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function setActions(enabled) {
  for (const button of document.querySelectorAll(".action-rail button")) button.disabled = !enabled;
  $("#previous-button").disabled = !enabled || history().length === 0;
  $("#next-button").disabled = !enabled || state.queue.length < 2;
}

function history() { return state.stageHistories.get(state.activeStage) || []; }
function setHistory(value) { state.stageHistories.set(state.activeStage, value); }
function renderStageTabs() {
  const root = $("#stage-tabs");
  root.innerHTML = STAGES.map((stage) => `<button class="stage-tab ${stage === state.activeStage ? "active" : ""}" data-stage="${stage}">${escapeHtml(stage)} <span>${state.stageQueues.get(stage)?.length || 0}</span></button>`).join("");
  root.querySelectorAll("button").forEach((button) => button.onclick = () => {
    state.stageQueues.set(state.activeStage, state.queue);
    state.activeStage = button.dataset.stage;
    state.queue = state.stageQueues.get(state.activeStage) || [];
    render();
  });
}

function renderWebsite(company) {
  const pane = $("#website-pane");
  const domain = company?.domains?.[0];
  if (!domain) { pane.innerHTML = '<div class="website-empty"><strong>No company domain</strong><p>Add a domain from the card to load the website here.</p></div>'; return; }
  const url = `https://${domain}`;
  pane.innerHTML = `<iframe title="${escapeHtml(company.companyName)} website" src="${escapeHtml(url)}"></iframe><div class="website-empty"><a class="website-open" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Open website ↗</a></div>`;
}

function render() {
  const company = current();
  const total = state.queue.length;
  renderStageTabs();

  if (!company) {
    renderWebsite(null);
    $("#count").textContent = state.syncing ? "…" : "DONE";
    setActions(false);
    card.innerHTML = state.syncing
      ? '<div class="loading-card"><div class="loading-dot"></div><h2>Building your queue</h2><span>Checking Attio and sorting the next conversations.</span></div>'
      : '<div class="complete"><p>QUEUE COMPLETE</p><h2>That is it.</h2><span>Every eligible company has a next step.</span></div>';
    return;
  }

  setActions(true);
  const ordinal = Math.min(history().length + 1, total);
  $("#count").textContent = `${String(ordinal).padStart(2, "0")} / ${String(total).padStart(2, "0")}`;
  const contact = selectedContact(company);
  renderWebsite(company);
  const domain = company.domains?.[0] || null;
  const contactControl = company.contacts.length > 1
    ? `<select class="contact-select" id="contact-select" aria-label="Select contact">${company.contacts.map((person) => `<option value="${escapeHtml(person.id)}" ${person.id === contact?.id ? "selected" : ""}>${escapeHtml(person.name)}</option>`).join("")}</select>`
    : contact
      ? `<strong>${escapeHtml(contact.name)}</strong>`
      : `<strong>No associated contact</strong><button class="inline-link" id="add-contact">+ Add contact</button>`;
  const linkedin = contact?.linkedinUrl
    ? `<a href="${escapeHtml(contact.linkedinUrl)}" target="_blank" rel="noreferrer">LinkedIn →</a>`
    : contact
      ? '<button class="inline-link" id="add-linkedin">+ Add LinkedIn URL</button>'
      : "";
  const emails = (contact?.emails || []).map((email) => ({ email, name: contact.name, personId: contact.id }));

  card.innerHTML = `<div class="contact-card">
    <div class="company-line">
      <div><p class="queue-label">${escapeHtml(company.queueLabel)}</p><h2>${escapeHtml(company.companyName)}</h2></div>
      ${domain ? `<a class="domain-link" href="https://${escapeHtml(domain)}" target="_blank" rel="noreferrer">${escapeHtml(domain)} ↗</a>` : '<button class="inline-link" id="add-domain">+ Add domain</button>'}
    </div>
    <div class="contact-line">
      <span class="section-label">CONTACT</span>
      <div class="contact-name-row">${contactControl}<div class="contact-links">${attioSourceBadge(contact, company)}${sourceBadge(contact, company)}${linkedin}</div></div>
      <div id="linkedin-editor"></div>
    </div>
    <div class="email-section">
      <span class="section-label">EMAILS</span>
      <div class="email-list">${emails.length ? emails.map((item) => `<div class="email-row"><button class="inline-email" data-email="${escapeHtml(item.email)}" data-name="${escapeHtml(item.name)}" data-person-id="${escapeHtml(item.personId)}">${escapeHtml(item.email)}</button><span>${escapeHtml(item.name)}</span></div>`).join("") : '<span class="empty-note">No email addresses for this contact</span>'}${contact ? `<button class="inline-link" id="edit-emails">${emails.length ? "Edit emails" : "+ Add email"}</button>` : ''}<div id="email-editor"></div></div>
    </div>
    <div class="email-section"><span class="section-label">PHONE</span><div class="email-list">${contact?.phones?.length ? `${escapeHtml(contact.phones.join(", "))} <button class="inline-link" id="edit-phones">Edit</button>` : contact ? '<button class="inline-link" id="edit-phones">+ Add phone</button>' : '<span class="empty-note">Add a contact first</span>'}</div></div>
    <section class="context">
      <div class="context-heading"><span class="section-label">ATTIO NOTES</span><button id="fix-interaction">Fix interaction</button></div>
      <div id="notes"><p class="empty-note">Loading notes…</p></div>
    </section>
    <div class="card-meta"><span>${escapeHtml(company.stage)} · ${company.followUpCount || 0} follow-ups</span><span>Last touch ${escapeHtml(formatDate(company.lastInteractionDate))}</span></div>
  </div>`;

  $("#linkedin-button").disabled = !contact;
  $("#email-button").disabled = !contact?.emails?.length;
  $("#contact-select")?.addEventListener("change", (event) => {
    state.selectedContacts.set(company.entryId, event.target.value);
    render();
  });
  $("#add-linkedin")?.addEventListener("click", showLinkedinEditor);
  $("#add-domain")?.addEventListener("click", editDomain);
  $("#add-contact")?.addEventListener("click", () => $("#contact-dialog").showModal());
  $("#edit-phones")?.addEventListener("click", editPhones);
  $("#edit-emails")?.addEventListener("click", showEmailEditor);
  for (const button of document.querySelectorAll(".inline-email")) {
    button.addEventListener("click", () => openEmail(button.dataset.email, button.dataset.name, button.dataset.personId));
  }
  $("#fix-interaction")?.addEventListener("click", openRepair);
  loadNotes(company);
}

async function loadNotes(company) {
  const requestId = ++state.noteRequest;
  try {
    const { notes } = await api(`/api/companies/${encodeURIComponent(company.companyId)}/notes`);
    if (requestId !== state.noteRequest || current()?.entryId !== company.entryId) return;
    const container = $("#notes");
    container.innerHTML = notes.length
      ? notes.map((note) => `<article><div><strong>${escapeHtml(note.title)}</strong><time>${escapeHtml(formatDate(note.createdAt))}</time></div><p>${escapeHtml(note.body)}</p></article>`).join("")
      : '<p class="empty-note">No company notes yet.</p>';
  } catch (error) {
    if (requestId === state.noteRequest && $("#notes")) $("#notes").innerHTML = `<p class="empty-note">Could not load notes. ${escapeHtml(error.message)}</p>`;
  }
}

function showLinkedinEditor() {
  const container = $("#linkedin-editor");
  container.innerHTML = '<div class="linkedin-editor"><input id="linkedin-input" placeholder="linkedin.com/in/…" aria-label="LinkedIn profile URL"><button class="mini-button" id="save-linkedin">Save</button></div>';
  $("#linkedin-input").focus();
  $("#save-linkedin").onclick = saveLinkedin;
}

async function saveLinkedin() {
  const company = current();
  const contact = selectedContact(company);
  if (!contact) return;
  const button = $("#save-linkedin");
  button.disabled = true;
  try {
    const result = await api(`/api/people/${encodeURIComponent(contact.id)}/linkedin`, {
      method: "PATCH",
      body: JSON.stringify({ url: $("#linkedin-input").value }),
    });
    contact.linkedinUrl = result.url;
    contact.sendpilot = null;
    toast("LinkedIn URL saved to Attio");
    render();
  } catch (error) {
    toast(error.message);
    button.disabled = false;
  }
}

async function editDomain() {
  const company = current();
  if (!company) return;
  const value = window.prompt("Company domain", company.domains?.join(", ") || "");
  if (value == null) return;
  const domains = value.split(",").map((domain) => domain.trim()).filter(Boolean);
  if (!domains.length) return toast("Enter at least one domain");
  try {
    const result = await api(`/api/companies/${encodeURIComponent(company.companyId)}/domains`, { method: "PATCH", body: JSON.stringify({ domains }) });
    company.domains = result.domains;
    render();
  } catch (error) { toast(error.message); }
}

async function editPhones() {
  const contact = selectedContact();
  if (!contact) return;
  const value = window.prompt("Phone numbers (comma-separated)", (contact.phones || []).join(", "));
  if (value == null) return;
  const phones = value.split(",").map((phone) => phone.trim()).filter(Boolean);
  if (!phones.length) return toast("Enter at least one phone number");
  try {
    const result = await api(`/api/people/${encodeURIComponent(contact.id)}/phones`, { method: "PATCH", body: JSON.stringify({ phones }) });
    contact.phones = result.phones;
    render();
  } catch (error) { toast(error.message); }
}

function showEmailEditor() {
  const contact = selectedContact();
  if (!contact) return;
  const editor = $("#email-editor");
  editor.innerHTML = `<div class="linkedin-editor"><input id="emails-input" type="text" value="${escapeHtml((contact.emails || []).join(", "))}" placeholder="name@example.com, name2@example.com" aria-label="Email addresses"><button class="mini-button" id="save-emails">Save</button></div>`;
  $("#emails-input").focus();
  $("#save-emails").onclick = saveEmails;
}

async function saveEmails() {
  const contact = selectedContact();
  if (!contact) return;
  const emails = $("#emails-input").value.split(",").map((email) => email.trim()).filter(Boolean);
  if (!emails.length) return toast("Enter at least one email address");
  try {
    const result = await api(`/api/people/${encodeURIComponent(contact.id)}/emails`, { method: "PATCH", body: JSON.stringify({ emails }) });
    contact.emails = result.emails;
    render();
  } catch (error) { toast(error.message); }
}

async function createContact() {
  const company = current();
  if (!company) return;
  const button = $("#save-contact"); button.disabled = true;
  try {
    await api(`/api/companies/${encodeURIComponent(company.companyId)}/people`, { method: "POST", body: JSON.stringify({
      name: $("#contact-name").value, linkedinUrl: $("#contact-linkedin").value, email: $("#contact-email").value, phone: $("#contact-phone").value,
    }) });
    $("#contact-dialog").close();
    await syncQueue();
    toast("Contact created and associated in Attio");
  } catch (error) { toast(error.message); } finally { button.disabled = false; }
}

async function syncQueue({ quiet = false } = {}) {
  if (state.syncing) return;
  state.syncing = true;
  if (!quiet) render();
  $("#sync-status").textContent = "Syncing with Attio…";
  try {
    const ownerId = $("#rep-select").value;
    if (state.sessionOwner !== ownerId) {
      state.sessionOwner = ownerId;
      state.completedIds.clear();
      state.navigationHistory.length = 0;
      state.stageHistories.clear();
    }
    const oldIds = new Set(state.queue.map((company) => company.entryId));
    const currentId = current()?.entryId;
    const result = await api("/api/sync", { method: "POST", body: JSON.stringify({ ownerId }) });
    const freshIds = new Set(result.queue.map((company) => company.entryId));
    for (const oldId of oldIds) {
      if (!freshIds.has(oldId)) state.completedIds.add(oldId);
    }
    const fresh = result.queue.filter((company) => !state.completedIds.has(company.entryId));

    // Sync should bring in Attio changes without losing the card the rep is
    // currently reviewing or the path used by backward navigation.
    state.navigationHistory = state.navigationHistory.filter((entryId) => freshIds.has(entryId));
    const nextQueue = [...fresh];
    if (currentId) {
      const currentIndex = nextQueue.findIndex((company) => company.entryId === currentId);
      if (currentIndex > 0) nextQueue.unshift(...nextQueue.splice(currentIndex, 1));
    }
    state.stageQueues = new Map(STAGES.map((stage) => [stage, nextQueue.filter((company) => company.stage === stage)]));
    state.stageHistories = new Map(STAGES.map((stage) => [stage, (state.stageHistories.get(stage) || []).filter((id) => state.stageQueues.get(stage).some((company) => company.entryId === id))]));
    state.queue = state.stageQueues.get(state.activeStage) || [];
    $("#sync-status").textContent = `Synced ${new Date(result.syncedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } catch (error) {
    $("#sync-status").textContent = "Sync failed";
    toast(error.message);
  } finally {
    state.syncing = false;
    render();
  }
}

function completeCurrent(message) {
  const company = state.queue.shift();
  if (company) {
    state.completedIds.add(company.entryId);
    state.navigationHistory = state.navigationHistory.filter((entryId) => entryId !== company.entryId);
    setHistory(history().filter((entryId) => entryId !== company.entryId));
    state.stageQueues.set(state.activeStage, state.queue);
    if (!state.queue.length) {
      const nextStage = STAGES.find((stage) => (state.stageQueues.get(stage) || []).length);
      if (nextStage) { state.activeStage = nextStage; state.queue = state.stageQueues.get(nextStage); }
    }
  }
  toast(message);
  render();
}

function navigateForward() {
  if (state.queue.length < 2) return;
  const company = state.queue.shift();
  state.queue.push(company);
  setHistory([...history(), company.entryId]);
  state.stageQueues.set(state.activeStage, state.queue);
  render();
}

function navigateBackward() {
  const entries = history();
  while (entries.length) {
    const entryId = entries.pop();
    const index = state.queue.findIndex((company) => company.entryId === entryId);
    if (index < 0) continue;
    state.queue.unshift(...state.queue.splice(index, 1));
    setHistory(entries);
    state.stageQueues.set(state.activeStage, state.queue);
    render();
    return;
  }
  render();
}

async function openComposer() {
  const company = current();
  const contact = selectedContact(company);
  if (!company || !contact) return;
  let route = contact.sendpilot || { source: "manual", reason: "No SendPilot conversation found" };
  state.sendpilotRoute = route;
  $("#composer-title").textContent = `${contact.name} · ${company.companyName}`;
  $("#message-text").value = "";
  $("#composer-dialog").showModal();
  if (!contact.sendpilot) {
    $("#composer-source").textContent = "CHECKING SENDPILOT";
    $("#sender-options").innerHTML = '<p class="sender-option-status">Loading existing conversation…</p>';
    $("#send-linkedin").disabled = true;
    $("#thread").innerHTML = '<p class="empty-note">Loading SendPilot conversation…</p>';
    try {
      route = await api("/api/sendpilot/resolve", {
        method: "POST",
        body: JSON.stringify({
          entryId: company.entryId,
          personId: contact.id,
          name: contact.name,
          linkedinUrl: contact.linkedinUrl,
          linkedinUrn: contact.linkedinUrn,
        }),
      });
    } catch (error) {
      route = { source: "manual", verified: false, reason: error.message };
    }
  }
  contact.sendpilot = route;
  state.sendpilotRoute = route;
  if (route.routes?.length) {
    $("#composer-source").textContent = "SENDPILOT · CHOOSE CONVERSATION";
    $("#sender-options").innerHTML = route.routes.map((item) =>
      `<button type="button" class="sender-option" data-sender-id="${escapeHtml(item.senderId)}" aria-pressed="false"><strong>${escapeHtml(item.senderName)}</strong><span>${escapeHtml(item.verified ? item.campaignName : item.reason)}</span></button>`
    ).join("");
    for (const button of $("#sender-options").querySelectorAll(".sender-option")) {
      button.onclick = () => selectSenderConversation(button.dataset.senderId);
    }
    $("#send-linkedin").textContent = "Choose a conversation first";
    $("#send-linkedin").disabled = true;
    renderThread();
    return;
  }
  const sendpilot = route.source === "sendpilot_campaign" && route.verified;
  const unipile = route.source === "unipile_fallback" && route.verified;
  $("#composer-source").textContent = sendpilot ? `SENDPILOT CAMPAIGN · ${route.campaignName}` : "MANUAL LINKEDIN";
  $("#sender-options").innerHTML = sendpilot
    ? `<div class="sender-option selected" data-sender-id="${escapeHtml(route.senderId)}"><strong>${escapeHtml(route.senderName)}</strong><span>Verified existing conversation</span></div>`
    : `<div class="sender-option selected"><strong>Manual send</strong>${route.reason ? `<span>${escapeHtml(route.reason)}</span>` : ""}</div>`;
  if (unipile) {
    $("#composer-source").textContent = `UNIPILE FALLBACK - ${route.senderName}`;
    $("#sender-options").innerHTML = `<div class="sender-option selected" data-sender-id="${escapeHtml(route.senderId)}"><strong>${escapeHtml(route.senderName)}</strong><span>Verified existing conversation</span></div>`;
  }
  $("#send-linkedin").textContent = sendpilot ? "Send via SendPilot" : "Copy & open LinkedIn";
  if (unipile) $("#send-linkedin").textContent = "Send via Unipile";
  $("#send-linkedin").disabled = false;
  renderThread();
}

function renderThread() {
  const route = state.sendpilotRoute;
  const thread = $("#thread");
  if (route?.routes?.length) {
    thread.innerHTML = '<p class="empty-note">Choose the sender whose existing conversation you want to use.</p>' + route.routes.map((item) =>
      `<p class="empty-note"><strong>${escapeHtml(item.senderName)}</strong> · ${item.messages.length} messages · last active ${escapeHtml(formatDate(item.lastActivityAt))}</p>`
    ).join("");
    return;
  }
  if (!route?.verified) {
    const messages = route?.messages || [];
    thread.innerHTML = `<p class="empty-note">Manual only${route?.reason ? ` · ${escapeHtml(route.reason)}` : ""}.</p>` + (messages.length
      ? messages.map((message) => `<div class="message-bubble ${message.isSender ? "ours" : "theirs"}">${escapeHtml(message.text)}<time>${escapeHtml(formatDate(message.timestamp))}</time></div>`).join("")
      : '<p class="empty-note">No SendPilot conversation could be verified for this contact.</p>');
  } else {
    thread.innerHTML = route.messages.length
      ? route.messages.map((message) => `<div class="message-bubble ${message.isSender ? "ours" : "theirs"}">${escapeHtml(message.text)}<time>${escapeHtml(formatDate(message.timestamp))}</time></div>`).join("")
      : '<p class="empty-note">Existing conversation found, with no message preview.</p>';
    thread.scrollTop = thread.scrollHeight;
  }
}

function selectSenderConversation(senderId) {
  const aggregate = selectedContact()?.sendpilot;
  const route = aggregate?.routes?.find((item) => item.senderId === senderId);
  if (!route) {
    state.sendpilotRoute = aggregate;
    $("#composer-source").textContent = "SENDPILOT · CHOOSE CONVERSATION";
    $("#send-linkedin").textContent = "Choose a conversation first";
    $("#send-linkedin").disabled = true;
    renderThread();
    return;
  }
  for (const button of $("#sender-options").querySelectorAll(".sender-option")) {
    const selected = button.dataset.senderId === senderId;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
  state.sendpilotRoute = route;
  const unipile = route.source === "unipile_fallback" && route.verified;
  $("#composer-source").textContent = route.verified ? `SENDPILOT CAMPAIGN · ${route.campaignName}` : `SENDPILOT · ${route.senderName}`;
  $("#send-linkedin").textContent = route.verified ? "Send via SendPilot" : "Copy & open LinkedIn";
  $("#send-linkedin").disabled = false;
  if (unipile) {
    $("#composer-source").textContent = `UNIPILE FALLBACK - ${route.senderName}`;
    $("#send-linkedin").textContent = "Send via Unipile";
  }
  renderThread();
}

async function sendLinkedin() {
  const company = current();
  const contact = selectedContact(company);
  const route = state.sendpilotRoute;
  const message = $("#message-text").value.trim();
  if (!company || !contact || !message) return toast("Write a message first");
  if (!route?.verified) {
    try {
      await navigator.clipboard.writeText(message);
      if (contact.linkedinUrl) window.open(contact.linkedinUrl, "_blank", "noopener,noreferrer");
      $("#composer-dialog").close();
      toast("Message copied · send manually in LinkedIn");
    } catch {
      toast("Could not copy the message. Select and copy it manually.");
    }
    return;
  }
  const button = $("#send-linkedin");
  const unipile = route.source === "unipile_fallback";
  button.disabled = true;
  button.textContent = "Sending…";
  try {
    await api(unipile ? "/api/unipile/send" : "/api/sendpilot/send", {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: crypto.randomUUID(),
        entryId: company.entryId,
        personId: contact.id,
        leadId: route.leadId,
        senderId: route.senderId,
        chatId: route.chatId,
        contactName: contact.name,
        linkedinUrl: contact.linkedinUrl,
        message,
      }),
    });
    $("#composer-dialog").close();
    if (unipile) {
      completeCurrent("Sent via Unipile - Attio sync pending");
      return;
    }
    completeCurrent("Sent via SendPilot · Attio sync pending");
  } catch (error) {
    toast(`${error.message} No automatic resend was attempted.`);
  } finally {
    button.disabled = false;
    button.textContent = "Send via SendPilot";
    if (unipile) button.textContent = "Send via Unipile";
  }
}

function renderEmailSenders() {
  const container = $("#email-sender-options");
  const selectedId = state.emailDraft?.senderId;
  container.innerHTML = (state.config?.emailSenders || []).map((sender) =>
    `<button type="button" class="sender-option ${sender.id === selectedId ? "selected" : ""}" data-sender-id="${escapeHtml(sender.id)}" aria-pressed="${sender.id === selectedId}"><strong>${escapeHtml(sender.name)}</strong><span>${escapeHtml(sender.email)}</span></button>`
  ).join("");
  for (const button of container.querySelectorAll(".sender-option")) {
    button.onclick = () => resolveEmailSender(button.dataset.senderId);
  }
}

function renderEmailThread(messages = []) {
  const thread = $("#email-thread");
  if (!messages.length) {
    thread.innerHTML = '<p class="empty-note">No existing conversation from this mailbox. This will be a new email.</p>';
    return;
  }
  thread.innerHTML = messages.map((message) =>
    `<div class="message-bubble ${message.isSender ? "ours" : "theirs"}">${escapeHtml(message.text || "No plain-text preview available")}<time>${escapeHtml(formatDate(message.sentAt))}</time></div>`
  ).join("");
  thread.scrollTop = thread.scrollHeight;
}

function updateEmailSendState() {
  const draft = state.emailDraft;
  const button = $("#send-email");
  if (!draft?.authorizationId || draft.resolving || draft.sending) {
    button.disabled = true;
    if (!draft?.sending) button.textContent = draft?.resolving ? "Checking Gmail…" : "Choose a sender first";
    return;
  }
  const hasBody = Boolean($("#email-message").value.trim());
  const hasSubject = draft.mode === "reply" || Boolean($("#email-subject").value.trim());
  button.disabled = !hasBody || !hasSubject;
  button.textContent = draft.mode === "reply" ? "Send reply" : "Send email";
}

function emailCc() {
  const raw = $("#email-cc").value.trim();
  if (!raw) return [];
  const values = raw.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  return values.every((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) ? [...new Set(values)] : null;
}

function openEmail(emailOverride = null, nameOverride = null, personIdOverride = null) {
  const company = current();
  const contact = personIdOverride
    ? company?.contacts?.find((person) => person.id === personIdOverride)
    : selectedContact(company);
  const email = typeof emailOverride === "string" ? emailOverride : contact?.emails?.[0];
  if (!company || !contact || !email) return toast("This contact has no email address");

  state.emailDraft = {
    ownerId: state.sessionOwner,
    entryId: company.entryId,
    personId: contact.id,
    email,
    name: nameOverride || contact.name,
    senderId: null,
    authorizationId: null,
    mode: null,
    newSubject: "",
    resolving: false,
    sending: false,
    version: 0,
  };
  $("#email-composer-source").textContent = "GMAIL · CHOOSE SENDER";
  $("#email-composer-title").textContent = `Email ${state.emailDraft.name || "contact"}`;
  $("#email-to").value = email;
  $("#email-cc").value = "";
  $("#email-subject").value = "";
  $("#email-subject").disabled = true;
  $("#email-subject").readOnly = false;
  $("#email-subject").required = false;
  $("#email-subject").placeholder = "Choose a sender first";
  $("#email-message").value = "";
  $("#email-thread").innerHTML = '<p class="empty-note">Choose a sender to check for an existing conversation.</p>';
  $("#email-mode-note").textContent = state.config?.gmailSendAvailable
    ? "Choose the Gmail identity that should send this message."
    : "Gmail sending is not configured on this server.";
  renderEmailSenders();
  $("#email-dialog").showModal();
  updateEmailSendState();
  $("#email-message").focus();
}

async function resolveEmailSender(senderId) {
  const draft = state.emailDraft;
  if (!draft || !state.config?.gmailSendAvailable) return toast("Gmail sending is not configured");
  if (draft.mode === "new") draft.newSubject = $("#email-subject").value;
  draft.senderId = senderId;
  const cc = emailCc();
  if (!cc) return toast("Enter valid comma-separated CC addresses");
  draft.authorizationId = null;
  draft.resolving = true;
  const version = ++draft.version;
  renderEmailSenders();
  $("#email-composer-source").textContent = "GMAIL · CHECKING CONVERSATION";
  $("#email-thread").innerHTML = '<p class="empty-note">Loading recent email messages…</p>';
  $("#email-mode-note").textContent = "Resolving this sender and recipient in Gmail…";
  $("#email-subject").disabled = true;
  updateEmailSendState();
  try {
    const result = await api("/api/email/resolve", {
      method: "POST",
      body: JSON.stringify({
        ownerId: draft.ownerId,
        entryId: draft.entryId,
        personId: draft.personId,
        email: draft.email,
        cc,
        senderId,
      }),
    });
    if (state.emailDraft !== draft || version !== draft.version) return;
    draft.authorizationId = result.authorizationId;
    draft.mode = result.mode;
    draft.resolving = false;
    if (result.mode === "reply") {
      $("#email-composer-source").textContent = "GMAIL · REPLY";
      $("#email-subject").value = result.subject;
      $("#email-subject").readOnly = true;
      $("#email-subject").disabled = false;
      $("#email-subject").required = false;
      $("#email-mode-note").textContent = "Replying in the existing thread. Gmail will revalidate it immediately before sending.";
    } else {
      $("#email-composer-source").textContent = "GMAIL · NEW EMAIL";
      $("#email-subject").value = draft.newSubject;
      $("#email-subject").readOnly = false;
      $("#email-subject").disabled = false;
      $("#email-subject").required = true;
      $("#email-subject").placeholder = "Subject";
      $("#email-mode-note").textContent = "No existing conversation found. Add a subject to send a new email.";
    }
    renderEmailThread(result.messages);
  } catch (error) {
    if (state.emailDraft !== draft || version !== draft.version) return;
    draft.resolving = false;
    draft.mode = null;
    $("#email-composer-source").textContent = "GMAIL · SENDER UNAVAILABLE";
    $("#email-thread").innerHTML = `<p class="empty-note">${escapeHtml(error.message)}</p>`;
    $("#email-mode-note").textContent = "Choose this sender again or select another mailbox. Nothing was sent.";
    toast(error.message);
  } finally {
    if (state.emailDraft === draft && version === draft.version) updateEmailSendState();
  }
}

async function sendEmail() {
  const draft = state.emailDraft;
  if (!draft?.authorizationId || draft.resolving || draft.sending) return;
  const subject = $("#email-subject").value.trim();
  const message = $("#email-message").value.trim();
  if (!message) return toast("Write a message first");
  if (draft.mode === "new" && !subject) return toast("Add a subject for this new email");

  const button = $("#send-email");
  draft.sending = true;
  button.disabled = true;
  button.textContent = "Sending…";
  try {
    await api("/api/email/send", {
      method: "POST",
      body: JSON.stringify({
        authorizationId: draft.authorizationId,
        idempotencyKey: crypto.randomUUID(),
        ownerId: draft.ownerId,
        entryId: draft.entryId,
        personId: draft.personId,
        subject,
        message,
        cc: emailCc() || [],
      }),
    });
    $("#email-dialog").close();
    state.emailDraft = null;
    completeCurrent("Sent via Gmail · Attio sync pending");
  } catch (error) {
    toast(`${error.message} No automatic resend was attempted.`);
    $("#email-mode-note").textContent = "Delivery failed. Your message is unchanged; use Send again only when you are ready to retry.";
  } finally {
    if (state.emailDraft === draft) {
      draft.sending = false;
      updateEmailSendState();
    }
  }
}

async function loadTemplates() {
  const result = await api("/api/templates");
  state.templates = result.templates;
  renderTemplates();
}

async function openTemplates(target = "copy") {
  state.templateTarget = target;
  $("#template-form").classList.add("hidden");
  $("#templates-dialog").showModal();
  try { await loadTemplates(); } catch (error) { toast(error.message); }
}

function renderTemplates() {
  const list = $("#template-list");
  list.innerHTML = state.templates.length
    ? state.templates.map((template) => `<article class="template-item" data-id="${escapeHtml(template.id)}"><header><strong>${escapeHtml(template.name)}</strong></header><p>${escapeHtml(template.body)}</p><div class="template-item-actions">${["composer", "email"].includes(state.templateTarget) ? '<button class="use-template">Use</button>' : ""}<button class="copy-template">Copy</button><button class="edit-template">Edit</button><button class="delete-template">Delete</button></div></article>`).join("")
    : '<p class="empty-note">No templates yet. Use + to add the first one.</p>';
  for (const item of list.querySelectorAll(".template-item")) {
    const template = state.templates.find((value) => value.id === item.dataset.id);
    item.querySelector(".use-template")?.addEventListener("click", () => {
      const target = state.templateTarget === "email" ? $("#email-message") : $("#message-text");
      target.value = template.body;
      $("#templates-dialog").close();
      if (state.templateTarget === "email") updateEmailSendState();
      target.focus();
    });
    item.querySelector(".copy-template").onclick = () => copyText(template.body);
    item.querySelector(".edit-template").onclick = () => showTemplateForm(template);
    item.querySelector(".delete-template").onclick = () => deleteTemplate(template);
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Template copied");
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    toast("Template copied");
  }
}

function showTemplateForm(template = null) {
  $("#template-id").value = template?.id || "";
  $("#template-name").value = template?.name || "";
  $("#template-body").value = template?.body || "";
  $("#template-form").classList.remove("hidden");
  $("#template-name").focus();
}

async function saveTemplate(event) {
  event.preventDefault();
  const id = $("#template-id").value;
  const body = { name: $("#template-name").value, body: $("#template-body").value };
  try {
    await api(id ? `/api/templates/${encodeURIComponent(id)}` : "/api/templates", {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify(body),
    });
    $("#template-form").classList.add("hidden");
    await loadTemplates();
    toast(id ? "Template updated" : "Template added");
  } catch (error) { toast(error.message); }
}

async function deleteTemplate(template) {
  if (!window.confirm(`Delete “${template.name}”?`)) return;
  try {
    await api(`/api/templates/${encodeURIComponent(template.id)}`, { method: "DELETE" });
    await loadTemplates();
    toast("Template deleted");
  } catch (error) { toast(error.message); }
}

function openRepair() {
  $("#repair-direction").value = "Us";
  $("#repair-date").value = todayTbilisi();
  $("#repair-dialog").showModal();
}

async function saveRepair() {
  const company = current();
  if (!company) return;
  const button = $("#save-repair");
  button.disabled = true;
  try {
    const result = await api("/api/interactions/repair", {
      method: "POST",
      body: JSON.stringify({ entryId: company.entryId, companyId: company.companyId, direction: $("#repair-direction").value, date: $("#repair-date").value }),
    });
    $("#repair-dialog").close();
    toast(result.incremented ? "Attio repaired · follow-up counter incremented" : "Attio interaction repaired");
    company.lastInteractionBy = $("#repair-direction").value;
    company.lastInteractionDate = $("#repair-date").value;
    if (result.stageChanged) company.stage = "Qualified";
    if (Number.isFinite(result.followUpCount)) company.followUpCount = result.followUpCount;
    render();
  } catch (error) { toast(error.message); } finally { button.disabled = false; }
}

function askNotQualified() {
  const company = current();
  if (!company) return;
  $("#confirm-copy").textContent = `${company.companyName} will leave this follow-up queue.`;
  $("#confirm-dialog").showModal();
}

async function markNotQualified() {
  const company = current();
  if (!company) return;
  const button = $("#confirm-not-qualified");
  button.disabled = true;
  try {
    await api(`/api/entries/${encodeURIComponent(company.entryId)}/not-qualified`, { method: "POST", body: "{}" });
    $("#confirm-dialog").close();
    completeCurrent("Moved to Not qualified in Attio");
  } catch (error) { toast(error.message); } finally { button.disabled = false; }
}

function askLost() {
  const company = current();
  if (!company) return;
  $("#confirm-lost-copy").textContent = `${company.companyName} will move to Lost and leave this follow-up queue.`;
  $("#confirm-lost-dialog").showModal();
}

async function markLost() {
  const company = current();
  if (!company) return;
  const button = $("#confirm-lost");
  button.disabled = true;
  try {
    await api(`/api/entries/${encodeURIComponent(company.entryId)}/lost`, { method: "POST", body: "{}" });
    $("#confirm-lost-dialog").close();
    completeCurrent("Moved to Lost in Attio");
  } catch (error) { toast(error.message); } finally { button.disabled = false; }
}

async function init() {
  render();
  try {
    state.config = await api("/api/config");
    $("#rep-select").innerHTML = state.config.reps.map((rep) => `<option value="${escapeHtml(rep.id)}">${escapeHtml(rep.name)}</option>`).join("");
    const savedRep = localStorage.getItem("followup-rep");
    if (savedRep && state.config.reps.some((rep) => rep.id === savedRep)) $("#rep-select").value = savedRep;
    if (state.config.mode === "mock") $("#sync-status").textContent = "Demo data · safe mode";
    await syncQueue();
    scheduleNextSync();
  } catch (error) {
    state.syncing = false;
    $("#sync-status").textContent = "Could not start";
    card.innerHTML = `<div class="complete"><p>CONNECTION ERROR</p><h2>Followup needs attention.</h2><span>${escapeHtml(error.message)}</span></div>`;
    toast(error.message);
  }
}

function scheduleNextSync() {
  clearTimeout(state.syncTimer);
  state.syncTimer = setTimeout(async () => {
    await syncQueue({ quiet: true });
    scheduleNextSync();
  }, state.config.syncIntervalMs);
}

$("#rep-select").addEventListener("change", async () => {
  localStorage.setItem("followup-rep", $("#rep-select").value);
  state.queue = [];
  state.completedIds.clear();
  state.sessionOwner = null;
  state.stageQueues.clear();
  state.stageHistories.clear();
  await syncQueue();
  scheduleNextSync();
});
$("#sync-button").onclick = async () => {
  await syncQueue();
  scheduleNextSync();
};
$("#rules-button").onclick = () => $("#rules-dialog").showModal();
$("#linkedin-button").onclick = openComposer;
$("#email-button").onclick = () => openEmail();
$("#email-templates").onclick = () => openTemplates("email");
$("#send-email").onclick = sendEmail;
$("#email-message").addEventListener("input", updateEmailSendState);
$("#email-subject").addEventListener("input", updateEmailSendState);
$("#email-cc").addEventListener("change", () => { if (state.emailDraft?.senderId) resolveEmailSender(state.emailDraft.senderId); });
$("#templates-button").onclick = () => openTemplates("copy");
$("#not-qualified-button").onclick = askNotQualified;
$("#lost-button").onclick = askLost;
$("#previous-button").onclick = navigateBackward;
$("#next-button").onclick = navigateForward;
$("#send-linkedin").onclick = sendLinkedin;
$("#composer-templates").onclick = () => openTemplates("composer");
$("#add-template-button").onclick = () => showTemplateForm();
$("#cancel-template").onclick = () => $("#template-form").classList.add("hidden");
$("#template-form").onsubmit = saveTemplate;
$("#save-repair").onclick = saveRepair;
$("#save-contact").onclick = createContact;
$("#confirm-not-qualified").onclick = markNotQualified;
$("#confirm-lost").onclick = markLost;
for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => {
    $(`#${button.dataset.close}`).close();
    if (button.dataset.close === "email-dialog") {
      if (state.emailDraft) state.emailDraft.version += 1;
      state.emailDraft = null;
    }
  });
}
document.addEventListener("keydown", (event) => {
  if ($("dialog[open]") || event.metaKey || event.ctrlKey || event.altKey) return;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
  if (event.key.toLowerCase() === "l") openComposer();
  if (event.key.toLowerCase() === "e") openEmail();
  if (event.key.toLowerCase() === "t") openTemplates("copy");
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    navigateBackward();
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    navigateForward();
  }
});

init();
