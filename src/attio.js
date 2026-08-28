import {
  INTERACTION_OPTION_IDS,
  OUTBOUND_LIST_ID,
  PRE_DEMO_COUNTER_STAGES,
} from "./constants.js";

const ATTIO_API = "https://api.attio.com/v2";
const MAX_ATTEMPTS = 4;
const TIMEOUT_MS = 15_000;
const ID_CHUNK = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function first(values) {
  return Array.isArray(values) ? values[0] : undefined;
}

export function readTitle(values) {
  const value = first(values);
  return value?.status?.title ?? value?.option?.title ?? value?.value ?? null;
}

export function readDate(values) {
  const value = first(values)?.value;
  return value ? String(value).slice(0, 10) : null;
}

function readSource(...valueSets) {
  for (const values of valueSets) {
    for (const field of ["source", "lead_source", "campaign_source"]) {
      const source = readTitle(values?.[field]);
      if (source) return source;
    }
  }
  return null;
}

function readNumber(values) {
  const value = Number(first(values)?.value ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function entryValues(entry) {
  return entry?.entry_values ?? entry?.values ?? {};
}

function entryId(entry) {
  return entry?.id?.entry_id ?? entry?.entry_id ?? null;
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response?.headers.get("retry-after"));
  return Number.isFinite(retryAfter) && retryAfter > 0
    ? retryAfter * 1000
    : 300 * 2 ** attempt;
}

function safeErrorText(error) {
  const cause = error?.cause?.code;
  const message = error instanceof Error ? error.message : String(error);
  return cause ? `${message} (${cause})` : message;
}

export class AttioClient {
  constructor({ apiKey = process.env.ATTIO_API_KEY } = {}) {
    if (!apiKey) throw new Error("ATTIO_API_KEY is not configured");
    this.apiKey = apiKey;
  }

  async request(path, init = {}) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const last = attempt === MAX_ATTEMPTS - 1;
      let response;
      try {
        response = await fetch(`${ATTIO_API}${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            ...(init.headers || {}),
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        if (last) throw new Error(`Attio is unreachable: ${safeErrorText(error)}`);
        await sleep(retryDelay(null, attempt));
        continue;
      }

      if (response.ok) return response.status === 204 ? null : response.json();
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && !last) {
        await sleep(retryDelay(response, attempt));
        continue;
      }
      const body = await response.text();
      throw new Error(`Attio ${response.status}: ${body.slice(0, 300)}`);
    }
    throw new Error("Attio request failed");
  }

  async listEntries() {
    const entries = [];
    let cursor = null;
    do {
      const data = await this.request(`/lists/${OUTBOUND_LIST_ID}/entries/query`, {
        method: "POST",
        body: JSON.stringify({ limit: 500, ...(cursor ? { cursor } : {}) }),
      });
      entries.push(...(data?.data ?? []));
      cursor = data?.next_cursor ?? null;
    } while (cursor);
    return entries;
  }

  async recordsByIds(object, ids) {
    const records = [];
    for (let index = 0; index < ids.length; index += ID_CHUNK) {
      const chunk = ids.slice(index, index + ID_CHUNK);
      const data = await this.request(`/objects/${object}/records/query`, {
        method: "POST",
        body: JSON.stringify({
          filter: { record_id: { $in: chunk } },
          limit: ID_CHUNK,
        }),
      });
      records.push(...(data?.data ?? []));
    }
    return records;
  }

  async getPipelineData(ownerId) {
    const entries = (await this.listEntries()).filter((entry) => {
      const owner = first(entryValues(entry).owner);
      return owner?.referenced_actor_id === ownerId;
    });

    const uniqueEntries = [];
    const seenCompanies = new Set();
    for (const entry of entries) {
      if (!entry.parent_record_id || seenCompanies.has(entry.parent_record_id)) continue;
      seenCompanies.add(entry.parent_record_id);
      uniqueEntries.push(entry);
    }

    const companies = await this.recordsByIds(
      "companies",
      uniqueEntries.map((entry) => entry.parent_record_id)
    );
    const companiesById = new Map(companies.map((company) => [company.id.record_id, company]));
    const personIds = [...new Set(companies.flatMap((company) =>
      (company.values.team ?? []).map((value) => value.target_record_id).filter(Boolean)
    ))];
    const people = personIds.length ? await this.recordsByIds("people", personIds) : [];
    const peopleById = new Map(people.map((person) => [person.id.record_id, person]));

    return uniqueEntries.map((entry) => {
      const values = entryValues(entry);
      const company = companiesById.get(entry.parent_record_id);
      const companyValues = company?.values ?? {};
      const contacts = (companyValues.team ?? []).map((reference) => {
        const person = peopleById.get(reference.target_record_id);
        const personValues = person?.values ?? {};
        return {
          id: reference.target_record_id,
          name: first(personValues.name)?.full_name || "Unnamed contact",
          emails: (personValues.email_addresses ?? [])
            .map((email) => email.email_address)
            .filter(Boolean),
          linkedinUrl: first(personValues.linkedin)?.value || null,
          linkedinUrn: first(personValues.linkedin_urn)?.value || null,
          phones: (personValues.phone_numbers ?? []).map((phone) => phone.phone_number || phone.original_phone_number).filter(Boolean),
          source: readSource(personValues, companyValues, values),
        };
      });

      return {
        companyId: entry.parent_record_id,
        entryId: entryId(entry),
        companyName: first(companyValues.name)?.value || "Unknown company",
        domains: (companyValues.domains ?? [])
          .map((domain) => domain.domain || domain.value)
          .filter(Boolean),
        stage: readTitle(values.stage) || "Unprocessed",
        ownerId,
        lastInteractionDate: readDate(values.last_follow_up),
        followUpCount: readNumber(values.number_of_follow_ups),
        lastInteractionBy: readTitle(companyValues.last_interaction_by),
        meetingStatus: readTitle(companyValues.meeting_status),
        source: readSource(companyValues, values),
        addedAt: entry.created_at || null,
        contacts,
      };
    });
  }

  async getEntry(entryIdValue) {
    const response = await this.request(`/lists/${OUTBOUND_LIST_ID}/entries/${encodeURIComponent(entryIdValue)}`);
    return response?.data ?? response;
  }

  async getCompany(companyId) {
    const response = await this.request(`/objects/companies/records/${encodeURIComponent(companyId)}`);
    return response?.data ?? response;
  }

  async patchEntry(entryIdValue, values) {
    return this.request(`/lists/${OUTBOUND_LIST_ID}/entries/${encodeURIComponent(entryIdValue)}`, {
      method: "PATCH",
      body: JSON.stringify({ data: { entry_values: values } }),
    });
  }

  async patchCompany(companyId, values) {
    return this.request(`/objects/companies/records/${encodeURIComponent(companyId)}`, {
      method: "PATCH",
      body: JSON.stringify({ data: { values } }),
    });
  }

  async patchStageIfCurrent(entryIdValue, expectedStage, nextStage) {
    const fresh = await this.getEntry(entryIdValue);
    const currentStage = readTitle(entryValues(fresh).stage) || "Unprocessed";
    if (currentStage !== expectedStage) {
      return { changed: false, currentStage };
    }
    await this.patchEntry(entryIdValue, { stage: nextStage });
    return { changed: true, currentStage: nextStage };
  }

  async markNotQualified(entryIdValue) {
    const result = await this.patchStageIfCurrent(entryIdValue, "Unprocessed", "Not qualified");
    if (result.changed) return result;
    const fresh = await this.getEntry(entryIdValue);
    const currentStage = readTitle(entryValues(fresh).stage) || "Unprocessed";
    if (currentStage === "Not qualified") return { changed: false, currentStage };
    await this.patchEntry(entryIdValue, { stage: "Not qualified" });
    return { changed: true, currentStage: "Not qualified" };
  }

  async markLost(entryIdValue) {
    const fresh = await this.getEntry(entryIdValue);
    const currentStage = readTitle(entryValues(fresh).stage) || "Unprocessed";
    if (currentStage === "Lost") return { changed: false, currentStage };
    await this.patchEntry(entryIdValue, { stage: "Lost" });
    return { changed: true, currentStage: "Lost" };
  }

  async updatePersonLinkedin(personId, url) {
    return this.request(`/objects/people/records/${encodeURIComponent(personId)}`, {
      method: "PATCH",
      body: JSON.stringify({ data: { values: { linkedin: url } } }),
    });
  }

  async updatePersonPhones(personId, phones) {
    return this.request(`/objects/people/records/${encodeURIComponent(personId)}`, {
      method: "PATCH",
      body: JSON.stringify({ data: { values: { phone_numbers: phones.map((original_phone_number) => ({ original_phone_number })) } } }),
    });
  }

  async updatePersonEmails(personId, emails) {
    return this.request(`/objects/people/records/${encodeURIComponent(personId)}`, {
      method: "PUT",
      body: JSON.stringify({ data: { values: { email_addresses: emails } } }),
    });
  }

  async updateCompanyDomains(companyId, domains) {
    return this.patchCompany(companyId, { domains: domains.map((domain) => ({ domain })) });
  }

  async createPerson({ companyId, name, linkedinUrl, email = null, phone = null }) {
    const names = String(name).trim().split(/\s+/);
    const values = {
      name: [{ first_name: names[0], last_name: names.slice(1).join(" ") || null, full_name: String(name).trim() }],
      linkedin: linkedinUrl,
      company: [{ target_object: "companies", target_record_id: companyId }],
    };
    if (email) values.email_addresses = [email];
    if (phone) values.phone_numbers = [{ original_phone_number: phone }];
    return this.request("/objects/people/records", { method: "POST", body: JSON.stringify({ data: { values } }) });
  }

  async deleteNote(noteId) {
    return this.request(`/notes/${encodeURIComponent(noteId)}`, { method: "DELETE" });
  }

  async repairInteraction({ entryId: entryIdValue, companyId, direction, date }) {
    const [entry, company] = await Promise.all([
      this.getEntry(entryIdValue),
      this.getCompany(companyId),
    ]);
    const values = entryValues(entry);
    const companyValues = company?.values ?? {};
    const previousDirection = readTitle(companyValues.last_interaction_by);
    const previousDate = readDate(values.last_follow_up);
    const currentCount = readNumber(values.number_of_follow_ups);
    const stage = readTitle(values.stage) || "Unprocessed";
    const incrementCounter =
      direction === "Us" &&
      previousDirection === "Us" &&
      Boolean(previousDate) &&
      date > previousDate &&
      PRE_DEMO_COUNTER_STAGES.has(stage);

    await this.patchCompany(companyId, {
      last_interaction_by: INTERACTION_OPTION_IDS[direction],
    });
    await this.patchEntry(entryIdValue, {
      last_follow_up: date,
      ...(incrementCounter ? { number_of_follow_ups: currentCount + 1 } : {}),
    });

    let stageChanged = false;
    if (stage === "Unprocessed" && direction === "Us") {
      stageChanged = (await this.patchStageIfCurrent(entryIdValue, "Unprocessed", "Qualified")).changed;
    }
    return {
      incremented: incrementCounter,
      followUpCount: currentCount + (incrementCounter ? 1 : 0),
      stageChanged,
    };
  }

  async getNotes(companyId) {
    const params = new URLSearchParams({
      parent_object: "companies",
      parent_record_id: companyId,
      limit: "50",
    });
    const response = await this.request(`/notes?${params}`);
    return (response?.data ?? [])
      .map((note) => ({
        id: note.id?.note_id || note.id,
        title: note.title || "Note",
        body: note.content_plaintext || note.content_markdown || "",
        createdAt: note.created_at || null,
      }))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
}
