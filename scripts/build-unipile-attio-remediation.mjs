import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const API = "https://velogtm.co/api/v1";
const API_KEY = process.env.N8N_API_KEY;
const APPLY_PRODUCTION = process.argv.includes("--production");
const DRY_RUN = process.argv.includes("--dry-run");
if (!API_KEY && !DRY_RUN) throw new Error("N8N_API_KEY is unavailable");

const ATTIO = { httpHeaderAuth: { id: "oO2dlTi8cx1EPM4j", name: "Attio API (download leads)" } };
const UNIPILE = { httpHeaderAuth: { id: "XgIwy3Ic6GILqQWf", name: "Unipile API" } };
const SLACK = { httpHeaderAuth: { id: "wrKST14oJKHjskWK", name: "Slack Attio Bot (xoxb)" } };
const DEEPSEEK = { httpHeaderAuth: { id: "5bcEi3wb1FdBQOBG", name: "DeepSeek API" } };
const ERROR_WORKFLOW = "k33dMa0HRqqRzbK1";
const ACTION_URL = "https://velogtm.co/webhook/linkedin-create-lead";

const tableManifest = JSON.parse(await readFile("docs/integration/linkedin-attio-data-tables.json", "utf8"));
const DT_EVENT = tableManifest.linkedin_attio_event_ledger.id;
const DT_CASE = tableManifest.linkedin_attio_case_ledger.id;
const DT_CHAT = tableManifest.linkedin_attio_chat_state.id;
const generatedDir = path.resolve("docs/integration/generated");
const workflowManifestFile = path.resolve("docs/integration/linkedin-attio-workflows.json");
let workflowManifest = {};
try { workflowManifest = JSON.parse(await readFile(workflowManifestFile, "utf8")); } catch {}

const core = (await readFile("src/unipile-attio-sync.js", "utf8"))
  .replace(/^export\s+/gm, "")
  .replace(/\r/g, "");
const withCore = (runtime) => `${core}\n\n${runtime.trim()}\n`;

function graph(name) {
  const nodes = [];
  const connections = {};
  const add = (node) => { nodes.push(node); return node.name; };
  const link = (from, to, output = 0) => {
    connections[from] ||= { main: [] };
    while (connections[from].main.length <= output) connections[from].main.push([]);
    connections[from].main[output].push({ node: to, type: "main", index: 0 });
  };
  const node = (nodeName, type, parameters, extra = {}) => add({
    id: `${name}-${nodeName}`.toLocaleLowerCase("en").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 62),
    name: nodeName,
    type,
    typeVersion: extra.typeVersion || 1,
    position: extra.position || [(nodes.length % 6) * 260, Math.floor(nodes.length / 6) * 220],
    parameters,
    ...(extra.credentials ? { credentials: extra.credentials } : {}),
    ...(extra.alwaysOutputData ? { alwaysOutputData: true } : {}),
    ...(extra.onError ? { onError: extra.onError } : {}),
    ...(extra.retryOnFail ? { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 } : {}),
  });
  const codeNode = (nodeName, jsCode, mode) => {
    const selectedMode = mode || (/\$input\.(?:first|all)\(\)|return\s*\[\s*\{/.test(jsCode) ? "runOnceForAllItems" : "runOnceForEachItem");
    const normalizedCode = selectedMode === "runOnceForAllItems" && /\$json\b/.test(jsCode) && !/const\s+\$json\b/.test(jsCode)
      ? `const $json = $input.first().json;\n${jsCode}`
      : jsCode;
    return node(nodeName, "n8n-nodes-base.code", { mode: selectedMode, jsCode: normalizedCode }, { typeVersion: 2 });
  };
  const ifNode = (nodeName, expression) => node(nodeName, "n8n-nodes-base.if", {
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 },
      conditions: [{ id: "condition", leftValue: `={{ ${expression} }}`, rightValue: "", operator: { type: "boolean", operation: "true", singleValue: true } }],
      combinator: "and",
    },
    looseTypeValidation: true,
    options: {},
  }, { typeVersion: 2.2 });
  const noOp = (nodeName) => node(nodeName, "n8n-nodes-base.noOp", {}, { typeVersion: 1 });
  const http = (nodeName, parameters, credentials, extra = {}) => node(nodeName, "n8n-nodes-base.httpRequest", {
    authentication: "genericCredentialType",
    genericAuthType: "httpHeaderAuth",
    options: { batching: { batch: { batchSize: 5, batchInterval: 1000 } }, ...(parameters.options || {}) },
    ...parameters,
  }, { typeVersion: 4.2, credentials, retryOnFail: true, ...extra });
  const execute = (nodeName, workflowId) => node(nodeName, "n8n-nodes-base.executeWorkflow", {
    workflowId: { __rl: true, mode: "id", value: workflowId },
    mode: "each",
    workflowInputs: { mappingMode: "defineBelow", value: {} },
    options: { waitForSubWorkflow: true },
  }, { typeVersion: 1.2, onError: "continueRegularOutput" });
  const dtGet = (nodeName, tableId, keyName, keyValue, extraConditions = []) => node(nodeName, "n8n-nodes-base.dataTable", {
    resource: "row", operation: "get", dataTableId: { __rl: true, mode: "id", value: tableId },
    matchType: "allConditions", filters: { conditions: [{ keyName, condition: "eq", keyValue }, ...extraConditions] },
    returnAll: true, options: {},
  }, { typeVersion: 1, alwaysOutputData: true });
  const dtUpsert = (nodeName, tableId, keyName, keyValue, values) => node(nodeName, "n8n-nodes-base.dataTable", {
    resource: "row", operation: "upsert", dataTableId: { __rl: true, mode: "id", value: tableId },
    matchType: "allConditions", filters: { conditions: [{ keyName, condition: "eq", keyValue }] },
    columns: { mappingMode: "defineBelow", value: values }, options: {},
  }, { typeVersion: 1 });
  return { nodes, connections, link, node, codeNode, ifNode, noOp, http, execute, dtGet, dtUpsert };
}

function workflow(name, g, settings = {}) {
  const allowedSettings = Object.fromEntries(
    Object.entries(settings).filter(([key]) => [
      "executionOrder", "errorWorkflow", "saveDataSuccessExecution", "saveDataErrorExecution",
      "timezone", "executionTimeout", "callerPolicy", "saveExecutionProgress",
    ].includes(key)),
  );
  return {
    name,
    nodes: g.nodes,
    connections: g.connections,
    settings: {
      executionOrder: "v1",
      errorWorkflow: ERROR_WORKFLOW,
      saveDataSuccessExecution: "all",
      saveDataErrorExecution: "all",
      ...allowedSettings,
    },
  };
}

function buildResolver() {
  const g = graph("resolver");
  const trigger = g.node("When called", "n8n-nodes-base.executeWorkflowTrigger", { inputSource: "passthrough" }, { typeVersion: 1.1 });
  const prepare = g.codeNode("Prepare bounded person query", withCore(`
const input = $input.first().json;
const event = input.event || input;
const incoming = event.counterpart || {};
const conditions = [];
if (incoming.urn) conditions.push({ linkedin_urn: incoming.urn });
if (incoming.profileUrl) conditions.push({ linkedin: canonicalLinkedInUrl(incoming.profileUrl) });
if (incoming.name) {
  conditions.push({ name: { full_name: { $eq: incoming.name } } });
  const first = normalizeName(incoming.name).split(' ')[0];
  if (first) conditions.push({ name: { first_name: { $eq: first } } });
}
return [{ json: { ...input, event, personQuery: { filter: { $or: conditions }, limit: 100 } } }];
`), "runOnceForAllItems");
  const find = g.http("Attio: Find bounded candidates", {
    method: "POST", url: "https://api.attio.com/v2/objects/people/records/query", sendBody: true,
    specifyBody: "json", jsonBody: "={{ JSON.stringify($json.personQuery) }}",
  }, ATTIO);
  const resolve = g.codeNode("Resolve identity ladder", withCore(`
const input = $('Prepare bounded person query').first().json;
const records = $input.first().json.data || [];
let resolution = resolveIdentity(input.event.counterpart || {}, records);
const selected = input.action?.type === 'same_person' ? input.action.candidateId : '';
if (selected) {
  const candidate = resolution.candidates.find((item) => item.id === selected);
  if (!candidate) throw new Error('The selected Attio candidate is no longer in the bounded set');
  const incoming = input.event.counterpart || {};
  const identityPatch = {};
  if (incoming.urn && !candidate.urn) identityPatch.linkedin_urn = incoming.urn;
  if (incoming.profileUrl && !candidate.profileUrl) identityPatch.linkedin = canonicalLinkedInUrl(incoming.profileUrl);
  resolution = { status: 'matched', matchBy: 'human_review', candidate, candidates: [candidate], conflicts: [], identityPatch };
}
return [{ json: { ...input, resolution, deepSeekRequest: resolution.status === 'needs_review' ? boundedDeepSeekRequest(input.event.counterpart || {}, resolution.candidates) : null } }];
`));
  // A LinkedIn event is fundamentally a company interaction.  Person identity is
  // preferred when it is unambiguous, but a missing or duplicate person must not
  // discard a uniquely identifiable company conversation.
  const needsCompanyFallback = g.ifNode("Needs company-led fallback?", "$json.resolution.status !== 'matched'");
  const prepareCompanyFallback = g.codeNode("Prepare employer company lookup", withCore(`
const base=$('Resolve identity ladder').first().json;
const occupation=safeString(base.event.counterpart?.occupation);
const parts=occupation.split('|').map(safeString).filter(Boolean);
let employer=parts.length>1 ? parts.at(-1) : '';
if(!employer) employer=safeString(occupation.match(/@\\s*([^|,;]+)/i)?.[1]);
if(!employer) employer=safeString(occupation.match(/\\bat\\s+([^|,;]+)/i)?.[1]);
employer=employer.replace(/\\s+(?:inc|ltd|llc|limited|gmbh)\\.?$/i,'').trim();
return [{json:{...base,employer,companyQuery:employer?{filter:{name:{$eq:employer}},limit:25}:null}}];
`));
  const companyEvidence = g.ifNode("Employer company usable?", "Boolean($json.companyQuery)");
  const findEmployerCompany = g.http("Attio: Find employer company", {
    method: "POST", url: "https://api.attio.com/v2/objects/companies/records/query", sendBody: true,
    specifyBody: "json", jsonBody: "={{ JSON.stringify($json.companyQuery) }}",
  }, ATTIO);
  const resolveEmployerCompany = g.codeNode("Resolve employer company", withCore(`
const base=$('Prepare employer company lookup').first().json;
const rows=$input.first().json.data||[];
const exact=rows.filter(row=>normalizeName(((row.values?.name||[])[0]||{}).value)===normalizeName(base.employer));
const companyCandidates=exact.map((row)=>({
  id:row.id?.record_id||row.id,
  name:((row.values?.name||[])[0]||{}).value||'',
}));
if(exact.length!==1) {
  const reason=exact.length?'company_ambiguous':'company_unmatched';
  return [{json:{...base,fallback:{ok:false,reason,companyCandidates}}}];
}
const company=exact[0]; const companyId=company.id?.record_id||company.id;
const companyName=safeString(((company.values?.name||[])[0]||{}).value);
const companyDomains=(company.values?.domains||[]).map(v=>v.domain||v.value).filter(Boolean);
const candidates=(base.resolution.candidates||[]).filter(candidate=>candidate.companyIds.includes(companyId)).sort((a,b)=>a.id.localeCompare(b.id));
if(base.resolution.status==='needs_review'&&!candidates.length) {
  return [{json:{...base,fallback:{ok:false,reason:'person_company_conflict',companyCandidates:[{id:companyId,name:companyName}]}}}];
}
const incoming=base.event.counterpart||{}; const names=safeString(incoming.name).split(/\\s+/).filter(Boolean);
const candidate=candidates[0]||null;
const personValues={name:[{first_name:names[0]||'Unknown',last_name:names.slice(1).join(' ')||null,full_name:safeString(incoming.name)||'Unknown'}],company:[{target_object:'companies',target_record_id:companyId}]};
if(incoming.urn) personValues.linkedin_urn=incoming.urn;
if(incoming.profileUrl) personValues.linkedin=canonicalLinkedInUrl(incoming.profileUrl);
return [{json:{...base,fallback:{ok:true,mode:candidate?'reuse':'create',candidate,personValues,companyId,companyName,companyDomains}}}];
`));
  const fallbackReady = g.ifNode("Company-led fallback resolved?", "$json.fallback.ok");
  const createFallback = g.ifNode("Create employer contact?", "$json.fallback.mode === 'create'");
  const createFallbackPerson = g.http("Attio: Create verified employer contact", {
    method: "POST", url: "https://api.attio.com/v2/objects/people/records", sendBody: true,
    specifyBody: "json", jsonBody: "={{ JSON.stringify({ data: { values: $json.fallback.personValues } }) }}",
  }, ATTIO, { onError: "continueRegularOutput" });
  const reuseFallbackPerson = g.noOp("Reuse employer-linked contact");
  const finalFallbackIdentity = g.codeNode("Finalize company-led identity", `
const base=$('Resolve employer company').first().json;const response=$input.first().json||{};const fallback=base.fallback;
const personId=fallback.candidate?.id||response.data?.id?.record_id||response.id?.record_id||'';
if(!personId) {
  const resolution={status:'unmatched',reason:'person_create_failed',candidates:[],conflicts:[],identityPatch:{}};
  return [{json:{...base,resolution}}];
}
const candidate=fallback.candidate||{id:personId,name:base.event.counterpart?.name||'',urn:base.event.counterpart?.urn||'',profileUrl:base.event.counterpart?.profileUrl||'',companyIds:[fallback.companyId]};
const resolution={status:'matched',matchBy:fallback.mode==='reuse'?'company_fallback_existing_person':'company_fallback_created_person',candidate,candidates:[candidate],conflicts:[],identityPatch:{},companyId:fallback.companyId,companyName:fallback.companyName,companyDomains:fallback.companyDomains};
return [{json:{...base,resolution}}];
`);
  const getFallbackEntries = g.http("Attio: Inspect fallback company membership", {
    url: "=https://api.attio.com/v2/objects/companies/records/{{ $json.resolution.companyId }}/entries",
  }, ATTIO);
  const finalFallback = g.codeNode("Company-led matched resolution", withCore(`
const base=$('Finalize company-led identity').first().json; const entries=$input.first().json.data||[];
const entry=entries.find(item=>item.list_api_slug==='cold_calling'||item.list_id===COLD_CALLING.listId)||null;
const resolution={...base.resolution,onPipeline:Boolean(entry),entryId:entry?.entry_id||''};
return [{json:{...base,resolution}}];
`));
  const needsReview = g.ifNode("Needs identity review?", "$json.resolution.status === 'needs_review'");
  const deepseek = g.http("DeepSeek: Rank bounded candidates", {
    method: "POST", url: "https://api.deepseek.com/chat/completions", sendBody: true, specifyBody: "json",
    jsonBody: "={{ JSON.stringify($json.deepSeekRequest) }}",
  }, DEEPSEEK, { onError: "continueRegularOutput" });
  const review = g.codeNode("Validated review result", withCore(`
const base = $('Resolve identity ladder').first().json;
const response = $input.first().json || {};
let ranking = { rankedCandidateIds: base.resolution.candidates.map(c => c.id), evidence: [], conflicts: base.resolution.conflicts, noMatchExplanation: '' };
try {
  const content = response.choices?.[0]?.message?.content;
  if (content) ranking = validateDeepSeekRanking(content, base.resolution.candidates.map(c => c.id));
} catch (error) { ranking.validationError = error.message; }
return [{ json: { ...base, resolution: { ...base.resolution, ranking } } }];
`));
  const matched = g.ifNode("Identity matched?", "$json.resolution.status === 'matched'");
  const hasCompany = g.ifNode("Has linked company?", "Boolean($json.resolution.candidate.companyIds[0])");
  const getCompany = g.http("Attio: Revalidate linked company", {
    url: "=https://api.attio.com/v2/objects/companies/records/{{ $('Resolve identity ladder').first().json.resolution.candidate.companyIds[0] }}",
  }, ATTIO);
  const getEntries = g.http("Attio: Inspect Cold Calling membership", {
    url: "=https://api.attio.com/v2/objects/companies/records/{{ $('Resolve identity ladder').first().json.resolution.candidate.companyIds[0] }}/entries",
  }, ATTIO);
  const finalMatched = g.codeNode("Matched resolution", withCore(`
const base = $('Resolve identity ladder').first().json;
const companyResponse = $('Attio: Revalidate linked company').first().json;
const company = companyResponse.data || companyResponse;
const entries = $input.first().json.data || [];
const entry = entries.find(item => item.list_api_slug === 'cold_calling' || item.list_id === COLD_CALLING.listId) || null;
const value = (slug) => ((company.values?.[slug] || [])[0] || {});
return [{ json: { ...base, resolution: { ...base.resolution,
  companyId: base.resolution.candidate.companyIds[0], company,
  companyName: safeString(value('name').value), companyDomains: (company.values?.domains || []).map(v => v.domain || v.value).filter(Boolean),
  onPipeline: Boolean(entry), entryId: entry?.entry_id || '',
} } }];
`));
  const noCompany = g.codeNode("Matched without company", `const base=$input.first().json; return [{json:{...base,resolution:{...base.resolution,companyId:'',companyName:'',companyDomains:[],onPipeline:false,entryId:''}}}];`);
  const unmatched = g.codeNode("Unmatched resolution", `return $input.all();`, "runOnceForAllItems");

  g.link(trigger, prepare); g.link(prepare, find); g.link(find, resolve); g.link(resolve, needsCompanyFallback);
  g.link(needsCompanyFallback, prepareCompanyFallback, 0); g.link(needsCompanyFallback, needsReview, 1);
  g.link(prepareCompanyFallback, companyEvidence); g.link(companyEvidence, findEmployerCompany, 0); g.link(companyEvidence, unmatched, 1);
  g.link(findEmployerCompany, resolveEmployerCompany); g.link(resolveEmployerCompany, fallbackReady);
  g.link(fallbackReady, createFallback, 0); g.link(fallbackReady, unmatched, 1);
  // The create request is used only for an unmatched person. Existing duplicate
  // contacts deliberately stay untouched; the company is the sync authority.
  g.link(createFallback, createFallbackPerson, 0); g.link(createFallback, reuseFallbackPerson, 1);
  g.link(createFallbackPerson, finalFallbackIdentity); g.link(reuseFallbackPerson, finalFallbackIdentity);
  g.link(finalFallbackIdentity, getFallbackEntries); g.link(getFallbackEntries, finalFallback);
  g.link(needsReview, deepseek, 0); g.link(deepseek, review);
  g.link(needsReview, matched, 1); g.link(matched, hasCompany, 0); g.link(matched, unmatched, 1);
  g.link(hasCompany, getCompany, 0); g.link(getCompany, getEntries); g.link(getEntries, finalMatched);
  g.link(hasCompany, noCompany, 1);
  return workflow("LinkedIn → Attio shared — identity and company resolver", g);
}

function buildMutation() {
  const g = graph("mutation");
  const trigger = g.node("When called", "n8n-nodes-base.executeWorkflowTrigger", { inputSource: "passthrough" }, { typeVersion: 1.1 });
  const plan = g.codeNode("Plan mutation", withCore(`
const input = $input.first().json;
const event = input.event;
const resolution = input.resolution || {};
const identityPatch = resolution.identityPatch || {};
return [{ json: { ...input, event, resolution, dryRun: Boolean(input.dryRun),
  hasIdentityPatch: Boolean(resolution.candidate?.id && Object.keys(identityPatch).length),
  cleanupNoteId: input.cleanupNoteId || '',
  personId: resolution.candidate?.id || input.personId || '', companyId: resolution.companyId || input.companyId || '', entryId: resolution.entryId || input.entryId || '',
} }];
`));
  const dry = g.ifNode("Dry run?", "$json.dryRun");
  const dryResult = g.codeNode("Dry-run plan", `return [{json:{ok:true,dryRun:true,plannedMode:$json.mode,eventKey:$json.event?.eventKey||''}}];`);
  const cleanupPending = g.ifNode("Ledger cleanup pending?", "Boolean($json.cleanupNoteId)");
  const cleanupPendingNote = g.http("Attio: Retry pending note cleanup", { method: "DELETE", url: "=https://api.attio.com/v2/notes/{{ $json.cleanupNoteId }}" }, ATTIO, { onError: "continueRegularOutput" });
  const cleanupPendingResult = g.codeNode("Pending cleanup result", `const b=$('Plan mutation').first().json;const r=$input.first().json||{};const ok=!r.error&&!(r.statusCode>=400);return [{json:{...b,cleanupOk:ok,error:ok?'':'pending note cleanup failed'}}];`);
  const cleanupPendingOk = g.ifNode("Pending cleanup OK?", "$json.cleanupOk");
  const cleanupPendingFailure = g.codeNode("Pending cleanup failure", `return [{json:{ok:false,status:'failed',error:$json.error,cleanupNoteId:$json.cleanupNoteId,completedSteps:[]}}];`);
  const hasIdentity = g.ifNode("Identity patch needed?", "$json.hasIdentityPatch");
  const patchIdentity = g.http("Attio: Write missing identity", {
    method: "PATCH", url: "=https://api.attio.com/v2/objects/people/records/{{ $('Plan mutation').first().json.personId }}", sendBody: true,
    specifyBody: "json", jsonBody: "={{ JSON.stringify({ data: { values: $('Plan mutation').first().json.resolution.identityPatch } }) }}",
  }, ATTIO, { onError: "continueRegularOutput" });
  const identitySkipped = g.noOp("Identity already complete");
  const afterIdentity = g.codeNode("Identity checkpoint", `
const plan=$('Plan mutation').first().json; const response=$input.first().json||{};
const failed=plan.hasIdentityPatch && Boolean(response.error || response.statusCode >= 400);
return [{json:{...plan,ok:!failed,error:failed?'identity patch failed':'',completedSteps:failed?[]:['identity']}}];
`);
  const identityOk = g.ifNode("Identity checkpoint OK?", "$json.ok");
  const identityFailure = g.codeNode("Identity failure", `return [{json:{ok:false,status:'failed',error:$json.error,eventKey:$json.event.eventKey}}];`);
  const qualification = g.ifNode("Qualification mutation?", "$json.mode === 'qualification'");
  const identityOnly = g.ifNode("Identity only?", "$json.mode === 'identity_only'");
  const identityResult = g.codeNode("Identity-only result", `return [{json:{ok:true,status:'completed',personId:$json.personId,companyId:$json.companyId,entryId:$json.entryId,completedSteps:$json.completedSteps}}];`);

  const prepareCompany = g.codeNode("Prepare approved company", withCore(`
const input=$input.first().json; const evidence=input.companyEvidence||{};
let companyName=safeString(evidence.name);
if(!companyName){ const occupation=safeString(input.event.counterpart?.occupation); const match=occupation.match(/(?:\\bat\\b|@)\\s+([^|,;]+)$/i); companyName=safeString(match?.[1]); }
if(!companyName) return [{json:{...input,ok:false,error:'Company name could not be verified from the reviewed evidence'}}];
const domain=safeString(evidence.domain).toLowerCase().replace(/^https?:\\/\\//,'').replace(/^www\\./,'').split('/')[0];
const filters=[]; if(input.preferredCompanyId) filters.push({record_id:{$in:[input.preferredCompanyId]}}); if(domain) filters.push({domains:{domain:{$eq:domain}}}); filters.push({name:{$eq:companyName}});
return [{json:{...input,ok:true,approvedCompany:{name:companyName,domain},companyQuery:{filter:{$or:filters},limit:25}}}];
`));
  const companyEvidenceOk = g.ifNode("Company evidence usable?", "$json.ok");
  const companyEvidenceFailure = g.codeNode("Company evidence failure", `return [{json:{ok:false,status:'waiting_review',error:$json.error}}];`);
  const findCompany = g.http("Attio: Find reusable company", {
    method: "POST", url: "https://api.attio.com/v2/objects/companies/records/query", sendBody: true, specifyBody: "json",
    jsonBody: "={{ JSON.stringify($json.companyQuery) }}",
  }, ATTIO);
  const chooseCompany = g.codeNode("Choose reusable company", withCore(`
const base=$('Prepare approved company').first().json; const rows=$input.first().json.data||[]; const preferred=base.preferredCompanyId?rows.find(row=>(row.id?.record_id||row.id)===base.preferredCompanyId):null;
const result=preferred?{status:'matched',matchBy:'reviewed_link',company:{id:preferred.id?.record_id||preferred.id,name:(((preferred.values?.name||[])[0]||{}).value||''),domains:(preferred.values?.domains||[]).map(v=>v.domain||v.value).filter(Boolean)}}:resolveCompany(base.approvedCompany,rows);
const original=rows.find(row=>(row.id?.record_id||row.id)===result.company?.id); const existingSource=(((original?.values?.source||[])[0]||{}).option||{}).title||'';
return [{json:{...base,companyResolution:result,companyAmbiguous:result.status==='ambiguous',companyExists:result.status==='matched',companyId:result.company?.id||'',existingSource,companyNeedsSource:result.status==='matched'&&!existingSource}}];
`));
  const companyAmbiguous = g.ifNode("Company ambiguous?", "$json.companyAmbiguous");
  const ambiguousCompanyResult = g.codeNode("Ambiguous company result", `return [{json:{ok:false,status:'waiting_review',error:'Ambiguous Attio companies require review',companyCandidates:$json.companyResolution.candidates}}];`);
  const companyExists = g.ifNode("Reuse company?", "$json.companyExists");
  const companySourceMissing = g.ifNode("Campaign source missing?", "$json.companyNeedsSource");
  const setCompanySource = g.http("Attio: Set missing campaign source", {
    method: "PATCH", url: "=https://api.attio.com/v2/objects/companies/records/{{ $json.companyId }}", sendBody: true, specifyBody: "json",
    jsonBody: "={{ JSON.stringify({ data: { values: { source: 'Linkedin Campaign' } } }) }}",
  }, ATTIO, { onError: "continueRegularOutput" });
  const verifiedSource = g.noOp("Existing company source retained");
  const createCompany = g.http("Attio: Create approved company", {
    method: "POST", url: "https://api.attio.com/v2/objects/companies/records", sendBody: true, specifyBody: "json",
    jsonBody: "={{ JSON.stringify({ data: { values: Object.assign({ name: $json.approvedCompany.name, source: 'Linkedin Campaign' }, $json.approvedCompany.domain ? { domains: [$json.approvedCompany.domain] } : {}) } }) }}",
  }, ATTIO, { onError: "continueRegularOutput" });
  const companyReady = g.codeNode("Approved company ready", `
const base=$('Choose reusable company').first().json; const response=$input.first().json||{};
const companyId=base.companyId||response.data?.id?.record_id||'';
const sourceWriteFailed=base.companyNeedsSource&&Boolean(response.error||response.statusCode>=400);
return [{json:{...base,ok:Boolean(companyId)&&!sourceWriteFailed,companyId,error:sourceWriteFailed?'company source update failed':(companyId?'':'company create failed')}}];
`);
  const companyReadyIf = g.ifNode("Company ready?", "$json.ok");
  const qualificationFailure = g.codeNode("Qualification failure", `return [{json:{ok:false,status:'failed',error:$json.error||'qualification failed'}}];`);
  const findPerson = g.http("Attio: Revalidate person for qualification", {
    method: "POST", url: "https://api.attio.com/v2/objects/people/records/query", sendBody: true, specifyBody: "json",
    jsonBody: "={{ JSON.stringify({ filter: { $or: [ $json.event.counterpart.urn ? { linkedin_urn: $json.event.counterpart.urn } : null, $json.event.counterpart.profileUrl ? { linkedin: $json.event.counterpart.profileUrl } : null, { name: { full_name: { $eq: $json.event.counterpart.name } } } ].filter(Boolean) }, limit: 25 }) }}",
  }, ATTIO);
  const preparePerson = g.codeNode("Prepare person upsert", withCore(`
const base=$('Approved company ready').first().json; const r=resolveIdentity(base.event.counterpart,$input.first().json.data||[]);
if(r.status==='needs_review') return [{json:{...base,ok:false,error:'Person became ambiguous during qualification'}}];
const existing=r.status==='matched'; const candidate=r.candidate||{}; const parts=safeString(base.event.counterpart.name).split(/\\s+/);
const values={ company:[{target_object:'companies',target_record_id:base.companyId}] };
if(base.event.counterpart.urn && !candidate.urn) values.linkedin_urn=base.event.counterpart.urn;
if(base.event.counterpart.profileUrl && !candidate.profileUrl) values.linkedin=base.event.counterpart.profileUrl;
if(!existing) values.name={first_name:parts[0]||'',last_name:parts.slice(1).join(' '),full_name:base.event.counterpart.name};
return [{json:{...base,ok:true,personExists:existing,personId:candidate.id||'',personValues:values}}];
`));
  const personPrepOk = g.ifNode("Person unambiguous?", "$json.ok");
  const personExists = g.ifNode("Reuse person?", "$json.personExists");
  const updatePerson = g.http("Attio: Link reusable person", {
    method: "PATCH", url: "=https://api.attio.com/v2/objects/people/records/{{ $json.personId }}", sendBody: true, specifyBody: "json",
    jsonBody: "={{ JSON.stringify({ data: { values: $json.personValues } }) }}",
  }, ATTIO, { onError: "continueRegularOutput" });
  const createPerson = g.http("Attio: Create approved person", {
    method: "POST", url: "https://api.attio.com/v2/objects/people/records", sendBody: true, specifyBody: "json",
    jsonBody: "={{ JSON.stringify({ data: { values: $json.personValues } }) }}",
  }, ATTIO, { onError: "continueRegularOutput" });
  const personReady = g.codeNode("Approved person ready", `
const base=$('Prepare person upsert').first().json; const response=$input.first().json||{};
const personId=base.personId||response.data?.id?.record_id||'';
return [{json:{...base,ok:Boolean(personId),personId,error:personId?'':'person write failed'}}];
`);
  const personReadyIf = g.ifNode("Person ready?", "$json.ok");
  const findPipeline = g.http("Attio: Revalidate Cold Calling entry", {
    method: "POST", url: "https://api.attio.com/v2/lists/7ac0b11c-204e-4c25-a744-e306606f6aa4/entries/query", sendBody: true, specifyBody: "json",
    jsonBody: "={{ JSON.stringify({ filter: { parent_record_id: $json.companyId }, limit: 25 }) }}",
  }, ATTIO);
  const preparePipeline = g.codeNode("Prepare pipeline upsert", `
const base=$('Approved person ready').first().json; const entry=($input.first().json.data||[])[0]||null;
const stageId=base.action?.type==='qualified'?COLD_CALLING.qualifiedStageId:COLD_CALLING.notQualifiedStageId;
return [{json:{...base,entryId:entry?.id?.entry_id||entry?.entry_id||'',stageId,entryExists:Boolean(entry)}}];
`);
  const entryExists = g.ifNode("Pipeline entry exists?", "$json.entryExists");
  const patchEntry = g.http("Attio: Apply reviewed stage", {
    method: "PATCH", url: "=https://api.attio.com/v2/lists/7ac0b11c-204e-4c25-a744-e306606f6aa4/entries/{{ $json.entryId }}", sendBody: true, specifyBody: "json",
    jsonBody: "={{ JSON.stringify({ data: { entry_values: { stage: $json.stageId, owner: [{ referenced_actor_type: 'workspace-member', referenced_actor_id: 'd9d9526a-9718-4861-a3b4-cc7e47f2b596' }] } } }) }}",
  }, ATTIO, { onError: "continueRegularOutput" });
  const addEntry = g.http("Attio: Add reviewed company to Cold Calling", {
    method: "POST", url: "https://api.attio.com/v2/lists/7ac0b11c-204e-4c25-a744-e306606f6aa4/entries", sendBody: true, specifyBody: "json",
    jsonBody: "={{ JSON.stringify({ data: { parent_object: 'companies', parent_record_id: $json.companyId, entry_values: { stage: $json.stageId, owner: [{ referenced_actor_type: 'workspace-member', referenced_actor_id: 'd9d9526a-9718-4861-a3b4-cc7e47f2b596' }] } } }) }}",
  }, ATTIO, { onError: "continueRegularOutput" });
  const qualificationResult = g.codeNode("Qualification result", `
const base=$('Prepare pipeline upsert').first().json; const response=$input.first().json||{};
const entryId=base.entryId||response.data?.id?.entry_id||response.data?.entry_id||'';
return [{json:{ok:Boolean(entryId),status:entryId?'qualified':'failed',personId:base.personId,companyId:base.companyId,entryId,stageId:base.stageId,error:entryId?'':'pipeline write failed'}}];
`);

  const getState = g.dtGet("DT: Get chat state", DT_CHAT, "sync_key", "={{ $json.event.accountId + ':' + $json.event.chatId }}");
  const getCompany = g.http("Attio: Get company before commit", { url: "=https://api.attio.com/v2/objects/companies/records/{{ $('Identity checkpoint').first().json.companyId }}" }, ATTIO);
  const getEntry = g.http("Attio: Get entry before commit", { url: "=https://api.attio.com/v2/lists/7ac0b11c-204e-4c25-a744-e306606f6aa4/entries/{{ $('Identity checkpoint').first().json.entryId }}" }, ATTIO);
  const history = g.http("Unipile: Paginate complete history", {
    url: "=https://api8.unipile.com:13818/api/v1/chats/{{ $('Identity checkpoint').first().json.event.chatId }}/messages?limit=100",
    options: {
      pagination: { pagination: {
        paginationMode: "updateAParameterInEachRequest",
        parameters: { parameters: [{ type: "qs", name: "cursor", value: "={{ $response.body.cursor }}" }] },
        paginationCompleteWhen: "other", completeExpression: "={{ !$response.body.cursor }}",
        limitPagesFetched: true, maxRequests: 100, requestInterval: 100,
      } },
    },
  }, UNIPILE, { onError: "continueRegularOutput" });
  const commitPlan = g.codeNode("Build guarded commit", withCore(`
const input=$('Identity checkpoint').first().json;
const stateRows=$('DT: Get chat state').all().map(i=>i.json).filter(r=>r.sync_key);
const state=stateRows.sort((a,b)=>new Date(b.updated_at||0)-new Date(a.updated_at||0))[0]||{};
const guard=applyEventTimeGuard(state,input.event);
const pages=$input.all().map(i=>i.json); const raw=pages.flatMap(p=>Array.isArray(p.items)?p.items:[]);
if(!raw.some(m=>(m.id||m.message_id)===input.event.messageId)) raw.push({id:input.event.messageId,timestamp:input.event.timestamp,text:input.event.text,is_sender:input.event.direction==='outbound'?1:0});
const history=dedupeAndSortMessages(raw,{cap:10000});
const lastPage=pages[pages.length-1]||{}; const truncated=history.truncated||Boolean(lastPage.cursor);
const transcript=buildTranscript(history.messages,{repName:input.event.repName,counterpartName:input.event.counterpart.name});
const companyResponse=$('Attio: Get company before commit').first().json; const company=companyResponse.data||companyResponse;
const noteRaw=((company.values?.linkedin_note_id||[])[0]||{}).value||'{}'; let noteMap={}; try{noteMap=JSON.parse(noteRaw)||{};}catch{}
const entryResponse=$('Attio: Get entry before commit').first().json; const entry=entryResponse.data||entryResponse; const values=entry.entry_values||{};
const currentDate=((values.last_follow_up||[])[0]||{}).value||null; const currentCount=Number(((values.number_of_follow_ups||[])[0]||{}).value||0);
const day=t=>new Date(t).toLocaleDateString('en-CA',{timeZone:'Asia/Tbilisi'}); let prev=null,derivedCount=0;
for(const m of history.messages){const ours=m.is_sender===1||m.isSender===true;const d=day(m.timestamp);if(ours&&prev?.ours&&d>prev.day)derivedCount++;prev={ours,day:d};}
const latest=history.messages.at(-1)||{}; const latestDay=latest.timestamp?day(latest.timestamp):null;
const entryValues={}; if(guard.shouldAdvance&&latestDay) entryValues.last_follow_up=latestDay; if(!currentCount&&derivedCount) entryValues.number_of_follow_ups=derivedCount;
return [{json:{...input,state,guard,historyTruncated:truncated,historyCount:history.totalUnique,noteMap,oldNoteId:state.note_id||noteMap[input.event.chatId]||'',
  noteTitle:'LinkedIn thread — '+input.event.repName+' ↔ '+(input.event.counterpart.name||'Unknown'),
  noteBody:'Rebuilt automatically from LinkedIn via Unipile - do not edit by hand.'+(truncated?'\\n(History exceeded 10,000 messages; transcript is explicitly truncated.)':'')+'\\n\\n'+transcript,
  companyPatch:guard.shouldAdvance?{data:{values:{last_interaction_by:input.event.direction==='outbound'?'e49570ae-01ef-4cf5-8f26-9bc3c18ce9d5':'4d8ba426-f284-469a-a53e-ed98ad6cf516'}}}:null,
  entryPatch:Object.keys(entryValues).length?{data:{entry_values:entryValues}}:null,
}}];
`), "runOnceForAllItems");
  const advance = g.ifNode("Advance interaction state?", "Boolean($json.companyPatch)");
  const patchCompany = g.http("Attio: Advance interaction direction", {
    method: "PATCH", url: "=https://api.attio.com/v2/objects/companies/records/{{ $json.companyId }}", sendBody: true, specifyBody: "json", jsonBody: "={{ JSON.stringify($json.companyPatch) }}",
  }, ATTIO, { onError: "continueRegularOutput" });
  const noCompanyPatch = g.noOp("Interaction already newer");
  const patchEntryIf = g.ifNode("Pipeline patch needed?", "Boolean($('Build guarded commit').first().json.entryPatch)");
  const patchInteractionEntry = g.http("Attio: Advance guarded pipeline state", {
    method: "PATCH", url: "=https://api.attio.com/v2/lists/7ac0b11c-204e-4c25-a744-e306606f6aa4/entries/{{ $('Build guarded commit').first().json.entryId }}", sendBody: true,
    specifyBody: "json", jsonBody: "={{ JSON.stringify($('Build guarded commit').first().json.entryPatch) }}",
  }, ATTIO, { onError: "continueRegularOutput" });
  const noEntryPatch = g.noOp("Pipeline state already current");
  const createNote = g.http("Attio: Create replacement transcript", {
    method: "POST", url: "https://api.attio.com/v2/notes", sendBody: true, specifyBody: "json",
    jsonBody: "={{ JSON.stringify({ data: { parent_object: 'companies', parent_record_id: $('Build guarded commit').first().json.companyId, title: $('Build guarded commit').first().json.noteTitle, format: 'plaintext', content: $('Build guarded commit').first().json.noteBody } }) }}",
  }, ATTIO, { onError: "continueRegularOutput" });
  const noteCreated = g.codeNode("Replacement created?", `
const base=$('Build guarded commit').first().json; const response=$input.first().json||{}; const newNoteId=response.data?.id?.note_id||'';
return [{json:{...base,newNoteId,noteCreated:Boolean(newNoteId),error:newNoteId?'':'replacement note creation failed'}}];
`);
  const noteCreatedIf = g.ifNode("Replacement note exists?", "$json.noteCreated");
  const noteFailure = g.codeNode("Transcript create failure", `return [{json:{ok:false,status:'failed',error:$json.error,completedSteps:['identity','interaction'],personId:$json.personId,companyId:$json.companyId,entryId:$json.entryId}}];`);
  const pointer = g.http("Attio: Commit transcript pointer", {
    method: "PATCH", url: "=https://api.attio.com/v2/objects/companies/records/{{ $json.companyId }}", sendBody: true, specifyBody: "json",
    jsonBody: "={{ JSON.stringify({ data: { values: { linkedin_note_id: JSON.stringify(Object.assign({}, $json.noteMap, { [$json.event.chatId]: $json.newNoteId })) } } }) }}",
  }, ATTIO, { onError: "continueRegularOutput" });
  const pointerResult = g.codeNode("Pointer committed?", `
const base=$('Replacement created?').first().json; const response=$input.first().json||{}; const ok=Boolean(response.data)&&!response.error;
return [{json:{...base,pointerCommitted:ok,error:ok?'':'transcript pointer commit failed'}}];
`);
  const pointerOk = g.ifNode("Pointer commit OK?", "$json.pointerCommitted");
  const compensate = g.http("Attio: Delete uncommitted replacement", { method: "DELETE", url: "=https://api.attio.com/v2/notes/{{ $json.newNoteId }}" }, ATTIO, { onError: "continueRegularOutput" });
  const compensationResult = g.codeNode("Pointer failure result", `const b=$('Pointer committed?').first().json;const r=$input.first().json||{};const cleanupFailed=Boolean(r.error||r.statusCode>=400);return [{json:{ok:false,status:'failed',error:b.error,cleanupNoteId:cleanupFailed?b.newNoteId:'',completedSteps:['identity','interaction'],personId:b.personId,companyId:b.companyId,entryId:b.entryId}}];`);
  const hasOld = g.ifNode("Old transcript exists?", "Boolean($json.oldNoteId && $json.oldNoteId !== $json.newNoteId)");
  const deleteOld = g.http("Attio: Cleanup old transcript", { method: "DELETE", url: "=https://api.attio.com/v2/notes/{{ $json.oldNoteId }}" }, ATTIO, { onError: "continueRegularOutput" });
  const noOld = g.noOp("No old transcript");
  const finalize = g.codeNode("Finalize transcript saga", `
const b=$('Pointer committed?').first().json; const response=$input.first().json||{};
const cleanupFailed=Boolean(b.oldNoteId)&&Boolean(response.error||response.statusCode>=400);
return [{json:{sync_key:b.event.accountId+':'+b.event.chatId,account_id:b.event.accountId,chat_id:b.event.chatId,company_id:b.companyId,person_id:b.personId,
 newest_committed_at:b.guard.newestCommittedAt||b.state.newest_committed_at,newest_message_id:b.guard.shouldAdvance?b.event.messageId:(b.state.newest_message_id||''),last_direction:b.guard.direction,
 note_id:b.newNoteId,cleanup_note_id:cleanupFailed?b.oldNoteId:'',history_cursor:'',history_truncated:b.historyTruncated,lock_until:new Date(0).toISOString(),lock_owner:'',updated_at:new Date().toISOString(),
 ok:!cleanupFailed,status:cleanupFailed?'failed':'completed',error:cleanupFailed?'old transcript cleanup failed':'',entryId:b.entryId,completedSteps:['identity','interaction','note_created','pointer_committed'].concat(cleanupFailed?[]:['old_note_cleaned'])}}];
`);
  const saveState = g.dtUpsert("DT: Commit chat state", DT_CHAT, "sync_key", "={{ $json.sync_key }}", {
    sync_key: "={{ $json.sync_key }}", account_id: "={{ $json.account_id }}", chat_id: "={{ $json.chat_id }}", company_id: "={{ $json.company_id }}",
    person_id: "={{ $json.person_id }}", newest_committed_at: "={{ $json.newest_committed_at }}", newest_message_id: "={{ $json.newest_message_id }}",
    last_direction: "={{ $json.last_direction }}", note_id: "={{ $json.note_id }}", cleanup_note_id: "={{ $json.cleanup_note_id }}",
    history_cursor: "", history_truncated: "={{ $json.history_truncated }}", lock_until: "={{ $json.lock_until }}", lock_owner: "", updated_at: "={{ $json.updated_at }}",
  });
  const syncResult = g.codeNode("Sync mutation result", `const b=$('Finalize transcript saga').first().json;return [{json:{ok:b.ok,status:b.status,error:b.error,personId:b.person_id,companyId:b.company_id,entryId:b.entryId,noteId:b.note_id,cleanupNoteId:b.cleanup_note_id,historyTruncated:b.history_truncated,completedSteps:b.completedSteps}}];`);

  g.link(trigger, plan); g.link(plan, dry); g.link(dry, dryResult, 0); g.link(dry, cleanupPending, 1);
  g.link(cleanupPending, cleanupPendingNote, 0); g.link(cleanupPending, hasIdentity, 1); g.link(cleanupPendingNote, cleanupPendingResult); g.link(cleanupPendingResult, cleanupPendingOk);
  g.link(cleanupPendingOk, hasIdentity, 0); g.link(cleanupPendingOk, cleanupPendingFailure, 1);
  g.link(hasIdentity, patchIdentity, 0); g.link(hasIdentity, identitySkipped, 1); g.link(patchIdentity, afterIdentity); g.link(identitySkipped, afterIdentity);
  g.link(afterIdentity, identityOk); g.link(identityOk, qualification, 0); g.link(identityOk, identityFailure, 1);
  g.link(qualification, prepareCompany, 0); g.link(qualification, identityOnly, 1);
  g.link(identityOnly, identityResult, 0); g.link(identityOnly, getState, 1);

  g.link(prepareCompany, companyEvidenceOk); g.link(companyEvidenceOk, findCompany, 0); g.link(companyEvidenceOk, companyEvidenceFailure, 1);
  g.link(findCompany, chooseCompany); g.link(chooseCompany, companyAmbiguous); g.link(companyAmbiguous, ambiguousCompanyResult, 0); g.link(companyAmbiguous, companyExists, 1);
  g.link(companyExists, companySourceMissing, 0); g.link(companyExists, createCompany, 1);
  g.link(companySourceMissing, setCompanySource, 0); g.link(companySourceMissing, verifiedSource, 1); g.link(setCompanySource, companyReady); g.link(verifiedSource, companyReady); g.link(createCompany, companyReady);
  g.link(companyReady, companyReadyIf); g.link(companyReadyIf, findPerson, 0); g.link(companyReadyIf, qualificationFailure, 1);
  g.link(findPerson, preparePerson); g.link(preparePerson, personPrepOk); g.link(personPrepOk, personExists, 0); g.link(personPrepOk, qualificationFailure, 1);
  g.link(personExists, updatePerson, 0); g.link(personExists, createPerson, 1); g.link(updatePerson, personReady); g.link(createPerson, personReady);
  g.link(personReady, personReadyIf); g.link(personReadyIf, findPipeline, 0); g.link(personReadyIf, qualificationFailure, 1);
  g.link(findPipeline, preparePipeline); g.link(preparePipeline, entryExists); g.link(entryExists, patchEntry, 0); g.link(entryExists, addEntry, 1);
  g.link(patchEntry, qualificationResult); g.link(addEntry, qualificationResult);

  g.link(getState, getCompany); g.link(getCompany, getEntry); g.link(getEntry, history); g.link(history, commitPlan);
  g.link(commitPlan, advance); g.link(advance, patchCompany, 0); g.link(advance, noCompanyPatch, 1); g.link(patchCompany, patchEntryIf); g.link(noCompanyPatch, patchEntryIf);
  g.link(patchEntryIf, patchInteractionEntry, 0); g.link(patchEntryIf, noEntryPatch, 1); g.link(patchInteractionEntry, createNote); g.link(noEntryPatch, createNote);
  g.link(createNote, noteCreated); g.link(noteCreated, noteCreatedIf); g.link(noteCreatedIf, pointer, 0); g.link(noteCreatedIf, noteFailure, 1);
  g.link(pointer, pointerResult); g.link(pointerResult, pointerOk); g.link(pointerOk, hasOld, 0); g.link(pointerOk, compensate, 1);
  g.link(compensate, compensationResult); g.link(hasOld, deleteOld, 0); g.link(hasOld, noOld, 1); g.link(deleteOld, finalize); g.link(noOld, finalize);
  g.link(finalize, saveState); g.link(saveState, syncResult);
  return workflow("LinkedIn → Attio shared — mutation saga", g);
}

function buildProcessor(resolverId, mutationId) {
  const g = graph("processor");
  const trigger = g.node("When called", "n8n-nodes-base.executeWorkflowTrigger", { inputSource: "passthrough" }, { typeVersion: 1.1 });
  const normalize = g.codeNode("Normalize envelope", withCore(`
const input=$input.first().json; const event=input.event?.eventKey?input.event:(input.eventKey?input:normalizeUnipileEvent(input));
return [{json:{...input,event,proceed:Boolean(event?.proceed!==false&&event?.eventKey),skipReason:event?.skipReason||''}}];
`));
  const proceed = g.ifNode("Processable event?", "$json.proceed");
  const ignored = g.codeNode("Ignored event", `return [{json:{ok:true,status:'ignored',reason:$json.skipReason}}];`);
  const getLedger = g.dtGet("DT: Get event ledger", DT_EVENT, "event_key", "={{ $json.event.eventKey }}");
  const gate = g.codeNode("Coalesce and gate event", withCore(`
const input=$('Normalize envelope').first().json; const rows=$input.all().map(i=>i.json).filter(r=>r.event_key);
const decision=input.action?{process:true,reason:'human_action',attempts:Number(rows[0]?.attempts||0)+1,completedSteps:[]} : eventLedgerDecision(rows);
return [{json:{...input,decision,attempts:decision.attempts||Number(rows[0]?.attempts||1),completedSteps:decision.completedSteps||[]}}];
`), "runOnceForAllItems");
  const shouldProcess = g.ifNode("Should run?", "$json.decision.process");
  const duplicate = g.codeNode("Completed or busy", `return [{json:{ok:true,status:$json.decision.reason,eventKey:$json.event.eventKey}}];`);
  const markProcessing = g.dtUpsert("DT: Mark processing", DT_EVENT, "event_key", "={{ $json.event.eventKey }}", {
    event_key: "={{ $json.event.eventKey }}", account_id: "={{ $json.event.accountId }}", chat_id: "={{ $json.event.chatId }}", message_id: "={{ $json.event.messageId }}",
    event_timestamp: "={{ $json.event.timestamp }}", direction: "={{ $json.event.direction }}", status: "processing", attempts: "={{ $json.attempts }}",
    completed_steps: "={{ JSON.stringify($json.completedSteps || []) }}", outputs: "{}", last_error: "", normalized_event: "={{ JSON.stringify($json.event) }}",
    case_key: "", person_id: "", company_id: "", started_at: "={{ $now.toISO() }}", updated_at: "={{ $now.toISO() }}",
    next_retry_at: "={{ $now.toISO() }}", stale_after: "={{ $now.plus({ minutes: 20 }).toISO() }}", cleanup_note_id: "",
  });
  const prepareResolver = g.codeNode("Prepare resolver call", `const base=$('Coalesce and gate event').first().json;return [{json:{event:base.event,action:base.action||null}}];`);
  const callResolver = g.execute("Call shared resolver", resolverId);
  const route = g.codeNode("Route resolution", withCore(`
const base=$('Coalesce and gate event').first().json; const resolved=$input.first().json; const r=resolved.resolution||{}; const action=base.action||{};
let route='complete'; let mutationMode=''; let caseReason='';
if(action.type==='different_person') { route=base.event.direction==='inbound'?'case':'complete'; caseReason='qualification'; }
else if(action.type==='qualified'||action.type==='not_qualified') { route='qualification'; mutationMode='qualification'; }
else if(r.status==='needs_review') { route='case'; caseReason='identity_'+(r.reason||'review'); }
else if(r.status==='unmatched') { route='case'; caseReason='company_'+(r.reason||'unresolved'); }
else if(r.status==='matched'&&r.onPipeline) { route='sync'; mutationMode='sync'; }
else if(r.status==='matched') { route='identity_then_case'; mutationMode='identity_only'; caseReason='qualification'; }
return [{json:{...base,...resolved,resolution:r,route,mutationMode,caseReason}}];
`));
  const switchRoute = g.node("Resolution route", "n8n-nodes-base.switch", {
    rules: { values: ["sync", "identity_then_case", "case", "wait_or_case", "qualification"].map((value) => ({
      conditions: { options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 }, conditions: [{ id: value, leftValue: "={{ $json.route }}", rightValue: value, operator: { type: "string", operation: "equals" } }], combinator: "and" },
      renameOutput: true, outputKey: value,
    })) }, options: { fallbackOutput: "extra" },
  }, { typeVersion: 3 });
  const prepareMutation = g.codeNode("Prepare sync mutation", `return [{json:{mode:$json.mutationMode,event:$json.event,resolution:$json.resolution,action:$json.action||null,companyEvidence:$json.companyEvidence||null,preferredCompanyId:$json.preferredCompanyId||'',cleanupNoteId:$json.decision?.canonical?.cleanup_note_id||''}}];`);
  const callMutation = g.execute("Call shared mutation", mutationId);
  const mutationOutcome = g.codeNode("Evaluate mutation", `const base=$('Route resolution').first().json;const result=$input.first().json||{};const routeAfterMutation=base.route==='identity_then_case'?'case':(base.route==='qualification'?'sync_after_qualification':'complete');return [{json:{...base,mutationResult:result,mutationOk:Boolean(result.ok),routeAfterMutation}}];`);
  const mutationOk = g.ifNode("Mutation OK?", "$json.mutationOk");
  const afterMutationCase = g.ifNode("Open case after identity?", "$json.routeAfterMutation === 'case'");
  const syncAfterQualification = g.ifNode("Sync after qualification?", "$json.routeAfterMutation === 'sync_after_qualification'");
  const postQualificationInput = g.codeNode("Prepare post-qualification sync", `
const b=$input.first().json;const r=b.mutationResult;return [{json:{mode:'sync',event:b.event,action:b.action,resolution:{status:'matched',matchBy:'qualification_review',candidate:{id:r.personId,name:b.event.counterpart.name,urn:b.event.counterpart.urn,profileUrl:b.event.counterpart.profileUrl,companyIds:[r.companyId]},identityPatch:{},companyId:r.companyId,entryId:r.entryId,onPipeline:true}}}];
`);
  const postQualificationMutation = g.execute("Call sync after qualification", mutationId);
  const postQualificationOutcome = g.codeNode("Evaluate post-qualification sync", `const base=$('Evaluate mutation').first().json;const result=$input.first().json||{};return [{json:{...base,mutationResult:result,mutationOk:Boolean(result.ok),routeAfterMutation:'complete'}}];`);
  const postQualificationOk = g.ifNode("Post-qualification sync OK?", "$json.mutationOk");
  const markFailed = g.dtUpsert("DT: Mark failed", DT_EVENT, "event_key", "={{ $('Route resolution').first().json.event.eventKey }}", {
    event_key: "={{ $('Route resolution').first().json.event.eventKey }}", status: "failed", attempts: "={{ $('Route resolution').first().json.attempts }}",
    completed_steps: "={{ JSON.stringify($json.mutationResult?.completedSteps || []) }}", outputs: "={{ JSON.stringify($json.mutationResult || {}) }}",
    last_error: "={{ $json.mutationResult?.error || 'mutation failed' }}", normalized_event: "={{ JSON.stringify($('Route resolution').first().json.event) }}",
    person_id: "={{ $json.mutationResult?.personId || '' }}", company_id: "={{ $json.mutationResult?.companyId || '' }}", updated_at: "={{ $now.toISO() }}",
    next_retry_at: "={{ $now.plus({ minutes: 15 }).toISO() }}", stale_after: "={{ $now.toISO() }}",
    cleanup_note_id: "={{ $json.mutationResult?.cleanupNoteId || '' }}",
  });
  const failedResult = g.codeNode("Failed result", `let result={};try{result=$('Evaluate post-qualification sync').first().json.mutationResult||{};}catch{result=$('Evaluate mutation').first().json.mutationResult||{};}return [{json:{ok:false,status:'failed',eventKey:$('Route resolution').first().json.event.eventKey,error:result.error||'mutation failed'}}];`);
  const waitNeeded = g.ifNode("Live SendPilot wait?", "$json.source !== 'nightly' && !$json.action");
  const wait = g.node("Hold 15 minutes for SendPilot", "n8n-nodes-base.wait", { amount: 15, unit: "minutes" }, { typeVersion: 1.1 });
  const recheckInput = g.codeNode("Resume original event", `const b=$('Route resolution').first().json;return [{json:{event:b.event,action:b.action||null}}];`);
  const recheckResolver = g.execute("Re-run shared resolver", resolverId);
  const recheckRoute = g.codeNode("Route recheck", withCore(`
const base=$('Route resolution').first().json; const resolved=$input.first().json; const r=resolved.resolution||{};
let route=r.status==='matched'&&r.onPipeline?'sync':(r.status==='matched'?'identity_then_case':'case');
return [{json:{...base,...resolved,resolution:r,route,mutationMode:route==='sync'?'sync':'identity_only',caseReason:r.status==='needs_review'?'identity_'+(r.reason||'review'):'qualification'}}];
`));
  const recheckSwitch = g.ifNode("Resolved after wait?", "$json.route === 'sync' || $json.route === 'identity_then_case'");
  const caseInput = g.codeNode("Prepare durable case", withCore(`
const base=$input.first().json; const reason=base.caseReason||'qualification'; const caseKey=base.event.accountId+':'+base.event.chatId+':'+reason;
return [{json:{...base,caseKey,reason}}];
`));
  const getCase = g.dtGet("DT: Get case", DT_CASE, "case_key", "={{ $json.caseKey }}");
  const buildCase = g.codeNode("Build or update Slack case", withCore(`
const base=$('Prepare durable case').first().json; const rows=$input.all().map(i=>i.json).filter(r=>r.case_key); const current=rows.sort((a,b)=>new Date(b.updated_at||0)-new Date(a.updated_at||0))[0]||{};
const merged=mergeCase(current,base.event); const isIdentity=base.reason.startsWith('identity_');
const ranking=base.resolution?.ranking||{rankedCandidateIds:(base.resolution?.candidates||[]).map(c=>c.id)};
let companyName=base.resolution?.companyName||base.companyEvidence?.name||''; if(!companyName){const match=safeString(base.event.counterpart.occupation).match(/(?:\\bat\\b|@)\\s+([^|,;]+)$/i);companyName=safeString(match?.[1]);}
const companyDomain=base.resolution?.companyDomains?.[0]||base.companyEvidence?.domain||''; const companyEvidence=base.event.counterpart.occupation||'';
const actionBaseUrl='https://velogtm.co/webhook/linkedin-create-lead';
const card=isIdentity?buildIdentityReviewCard({caseKey:base.caseKey,event:base.event,ranking,actionBaseUrl}):buildQualificationCard({caseKey:base.caseKey,event:base.event,personName:base.resolution?.candidate?.name||base.event.counterpart.name,companyName,evidence:companyEvidence,actionBaseUrl});
const payload=encodeURIComponent(JSON.stringify({caseKey:base.caseKey,eventKey:base.event.eventKey,candidateId:ranking.rankedCandidateIds?.[0]||''}));
for(const block of card.blocks){for(const button of block.elements||[]){if(button.url) button.url+='&k='+encodeURIComponent(base.caseKey);}}
card.text+=' · '+merged.messageCount+' message'+(merged.messageCount===1?'':'s');
return [{json:{...base,currentCase:current,caseExists:Boolean(current.slack_ts),messageCount:merged.messageCount,eventKeys:merged.eventKeys,latestPreview:merged.latestPreview,companyName,companyDomain,companyEvidence,card}}];
`), "runOnceForAllItems");
  const caseExists = g.ifNode("Slack parent exists?", "$json.caseExists");
  const slackReply = g.http("Slack: Reply under case", {
    method: "POST", url: "https://slack.com/api/chat.postMessage", sendBody: true, specifyBody: "json",
    jsonBody: "={{ JSON.stringify({ channel: $json.currentCase.slack_channel, thread_ts: $json.currentCase.slack_ts, text: $json.latestPreview }) }}",
  }, SLACK, { onError: "continueRegularOutput" });
  const updateParent = g.http("Slack: Update parent case", {
    method: "POST", url: "https://slack.com/api/chat.update", sendBody: true, specifyBody: "json",
    jsonBody: "={{ JSON.stringify(Object.assign({}, $('Build or update Slack case').first().json.card, { ts: $('Build or update Slack case').first().json.currentCase.slack_ts })) }}",
  }, SLACK, { onError: "continueRegularOutput" });
  const postParent = g.http("Slack: Open parent case", {
    method: "POST", url: "https://slack.com/api/chat.postMessage", sendBody: true, specifyBody: "json", jsonBody: "={{ JSON.stringify($json.card) }}",
  }, SLACK, { onError: "continueRegularOutput" });
  const caseCommitted = g.codeNode("Prepare case ledger commit", `
const b=$('Build or update Slack case').first().json; const response=$input.first().json||{}; const ts=b.currentCase.slack_ts||response.ts||'';
return [{json:{...b,slackTs:ts,slackChannel:b.currentCase.slack_channel||response.channel||b.card.channel,caseOk:Boolean(ts),caseError:ts?'':'Slack case write failed'}}];
`);
  const saveCase = g.dtUpsert("DT: Save case", DT_CASE, "case_key", "={{ $json.caseKey }}", {
    case_key: "={{ $json.caseKey }}", account_id: "={{ $json.event.accountId }}", chat_id: "={{ $json.event.chatId }}", reason: "={{ $json.reason }}",
    status: "waiting_review", person_id: "={{ $json.resolution?.candidate?.id || '' }}", candidate_ids: "={{ JSON.stringify(($json.resolution?.candidates || []).map(c => c.id)) }}",
    company_id: "={{ $json.resolution?.companyId || '' }}", slack_channel: "={{ $json.slackChannel }}", slack_ts: "={{ $json.slackTs }}",
    message_count: "={{ $json.messageCount }}", latest_preview: "={{ $json.latestPreview }}", event_keys: "={{ JSON.stringify($json.eventKeys) }}",
    resolution: "", updated_at: "={{ $now.toISO() }}", action_nonce: "", action_result: "",
    company_name: "={{ $json.companyName }}", company_domain: "={{ $json.companyDomain }}", company_evidence: "={{ $json.companyEvidence }}",
  });
  const markWaiting = g.dtUpsert("DT: Mark waiting review", DT_EVENT, "event_key", "={{ $('Build or update Slack case').first().json.event.eventKey }}", {
    event_key: "={{ $('Build or update Slack case').first().json.event.eventKey }}", status: "waiting_review", attempts: "={{ $('Build or update Slack case').first().json.attempts }}",
    completed_steps: "={{ JSON.stringify(['identity_resolved','case_opened']) }}", outputs: "={{ JSON.stringify({ caseKey: $('Build or update Slack case').first().json.caseKey, slackTs: $('Prepare case ledger commit').first().json.slackTs }) }}",
    last_error: "", normalized_event: "={{ JSON.stringify($('Build or update Slack case').first().json.event) }}", case_key: "={{ $('Build or update Slack case').first().json.caseKey }}",
    person_id: "={{ $('Build or update Slack case').first().json.resolution?.candidate?.id || '' }}", company_id: "={{ $('Build or update Slack case').first().json.resolution?.companyId || '' }}",
    updated_at: "={{ $now.toISO() }}", next_retry_at: "={{ $now.plus({ days: 365 }).toISO() }}", stale_after: "={{ $now.plus({ days: 365 }).toISO() }}",
  });
  const waitingResult = g.codeNode("Waiting-review result", `const b=$('Build or update Slack case').first().json;return [{json:{ok:true,status:'waiting_review',eventKey:b.event.eventKey,caseKey:b.caseKey,slackTs:$('Prepare case ledger commit').first().json.slackTs}}];`);
  const completeInput = g.codeNode("Prepare completion", `const b=$input.first().json;const result=b.mutationResult||{};return [{json:{...b,result,completionOk:result.ok!==false}}];`);
  const historyTruncated = g.ifNode("History truncated?", "Boolean($json.result.historyTruncated)");
  const truncationAlert = g.http("Slack: Alert history truncation", {
    method: "POST", url: "https://slack.com/api/chat.postMessage", sendBody: true, specifyBody: "json",
    jsonBody: "={{ JSON.stringify({ channel: 'C0BQ53M5JKF', text: 'LinkedIn history truncated at 10,000 messages', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: ':warning: *LinkedIn history truncated*\nChat `' + $json.event.chatId + '` exceeded 10,000 messages. The canonical transcript is flagged as truncated, not complete.' } }] }) }}",
  }, SLACK, { onError: "continueRegularOutput" });
  const markCompleted = g.dtUpsert("DT: Mark completed", DT_EVENT, "event_key", "={{ $json.event.eventKey }}", {
    event_key: "={{ $json.event.eventKey }}", status: "completed", attempts: "={{ $json.attempts }}",
    completed_steps: "={{ JSON.stringify($json.result.completedSteps || ['handled']) }}", outputs: "={{ JSON.stringify($json.result || {}) }}", last_error: "",
    normalized_event: "={{ JSON.stringify($json.event) }}", person_id: "={{ $json.result.personId || $json.resolution?.candidate?.id || '' }}",
    company_id: "={{ $json.result.companyId || $json.resolution?.companyId || '' }}", updated_at: "={{ $now.toISO() }}", next_retry_at: "={{ $now.toISO() }}", stale_after: "={{ $now.toISO() }}",
    cleanup_note_id: "={{ $json.result.cleanupNoteId || '' }}",
  });
  const completedResult = g.codeNode("Completed result", `const b=$('Prepare completion').first().json;return [{json:{ok:true,status:'completed',eventKey:b.event.eventKey,...b.result}}];`);

  g.link(trigger, normalize); g.link(normalize, proceed); g.link(proceed, getLedger, 0); g.link(proceed, ignored, 1);
  g.link(getLedger, gate); g.link(gate, shouldProcess); g.link(shouldProcess, markProcessing, 0); g.link(shouldProcess, duplicate, 1);
  g.link(markProcessing, prepareResolver); g.link(prepareResolver, callResolver); g.link(callResolver, route); g.link(route, switchRoute);
  g.link(switchRoute, prepareMutation, 0); g.link(switchRoute, prepareMutation, 1); g.link(switchRoute, caseInput, 2); g.link(switchRoute, waitNeeded, 3); g.link(switchRoute, prepareMutation, 4); g.link(switchRoute, completeInput, 5);
  g.link(prepareMutation, callMutation); g.link(callMutation, mutationOutcome); g.link(mutationOutcome, mutationOk); g.link(mutationOk, afterMutationCase, 0); g.link(mutationOk, markFailed, 1);
  g.link(markFailed, failedResult); g.link(afterMutationCase, caseInput, 0); g.link(afterMutationCase, syncAfterQualification, 1);
  g.link(syncAfterQualification, postQualificationInput, 0); g.link(syncAfterQualification, completeInput, 1);
  g.link(postQualificationInput, postQualificationMutation); g.link(postQualificationMutation, postQualificationOutcome); g.link(postQualificationOutcome, postQualificationOk);
  g.link(postQualificationOk, completeInput, 0); g.link(postQualificationOk, markFailed, 1);
  g.link(waitNeeded, wait, 0); g.link(waitNeeded, caseInput, 1); g.link(wait, recheckInput); g.link(recheckInput, recheckResolver); g.link(recheckResolver, recheckRoute); g.link(recheckRoute, recheckSwitch);
  g.link(recheckSwitch, prepareMutation, 0); g.link(recheckSwitch, caseInput, 1);
  g.link(caseInput, getCase); g.link(getCase, buildCase); g.link(buildCase, caseExists); g.link(caseExists, slackReply, 0); g.link(slackReply, updateParent); g.link(updateParent, caseCommitted);
  g.link(caseExists, postParent, 1); g.link(postParent, caseCommitted); g.link(caseCommitted, saveCase); g.link(saveCase, markWaiting); g.link(markWaiting, waitingResult);
  g.link(completeInput, historyTruncated); g.link(historyTruncated, truncationAlert, 0); g.link(historyTruncated, markCompleted, 1); g.link(truncationAlert, markCompleted); g.link(markCompleted, completedResult);
  return workflow("LinkedIn → Attio shared — durable event processor", g);
}

function buildLive(processorId, backup) {
  const g = graph("live");
  const original = backup.nodes.find((node) => node.name === "LinkedIn Message");
  g.nodes.push(original);
  const normalize = g.codeNode("Normalize event envelope", withCore(`const event=normalizeUnipileEvent($input.first().json);return [{json:{event,source:'live',proceed:event.proceed!==false}}];`));
  const proceed = g.ifNode("Allowed LinkedIn event?", "$json.proceed");
  const dispatch = g.execute("Process through shared saga", processorId);
  const ignored = g.noOp("Ignored");
  g.link("LinkedIn Message", normalize); g.link(normalize, proceed); g.link(proceed, dispatch, 0); g.link(proceed, ignored, 1);
  return workflow(backup.name, g, backup.settings);
}

function buildNightly(processorId, backup) {
  const g = graph("nightly");
  const dailyTrigger = backup.nodes.find((node) => node.name === "Nightly");
  const weeklyTrigger = backup.nodes.find((node) => node.name === "Weekly Sweep");
  g.nodes.push(dailyTrigger, weeklyTrigger);
  const daily = g.codeNode("Daily mode", `return [{json:{mode:'daily'}}];`);
  const weekly = g.codeNode("Weekly mode", `return [{json:{mode:'sweep',fromDaysAgo:0,toDaysAgo:92}}];`);
  const accounts = g.codeNode("Allowed accounts", withCore(`
const cfg=$input.first().json; const hours=cfg.mode==='sweep'?92*24:26; const since=new Date(Date.now()-hours*3600000).toISOString();
return Object.entries(LINKEDIN_ACCOUNTS).map(([accountId,a])=>({json:{accountId,repName:a.repName,selfId:a.selfId,since,mode:cfg.mode}}));
`), "runOnceForAllItems");
  const chats = g.http("Unipile: Paginate chats", {
    url: "=https://api8.unipile.com:13818/api/v1/chats?account_id={{ $json.accountId }}&after={{ $json.since }}&limit=100",
    options: { pagination: { pagination: { paginationMode: "updateAParameterInEachRequest", parameters: { parameters: [{ type: "qs", name: "cursor", value: "={{ $response.body.cursor }}" }] }, paginationCompleteWhen: "other", completeExpression: "={{ !$response.body.cursor }}", limitPagesFetched: true, maxRequests: 100 } } },
  }, UNIPILE);
  const flatten = g.codeNode("One-to-one chats", `
const accounts=$('Allowed accounts').all().map(i=>i.json);const out=[];
for(const page of $input.all()){for(const chat of page.json.items||[]){const a=accounts.find(x=>x.accountId===chat.account_id);if(a&&chat.type===0)out.push({json:{...a,chatId:chat.id,lastActivity:chat.timestamp}});}}
return out;
`, "runOnceForAllItems");
  const attendees = g.http("Unipile: Get attendees", { url: "=https://api8.unipile.com:13818/api/v1/chats/{{ $json.chatId }}/attendees" }, UNIPILE);
  const identity = g.codeNode("Attach counterpart identity", withCore(`
const chats=$('One-to-one chats').all();const out=[];
for(const response of $input.all()){
  const paired=Array.isArray(response.pairedItem)?response.pairedItem[0]:response.pairedItem;const index=Number(paired?.item||0);const chat=chats[index]?.json;if(!chat)continue;
  const other=(response.json.items||[]).find(a=>!a.is_self)||{};const raw=safeString(other.name||other.attendee_name);
  out.push({json:{...chat,counterpart:{urn:safeString(other.attendee_provider_id||other.provider_id),profileUrl:profileUrlOf(other),name:raw.replace(/\\s+/g,' '),originalName:raw,normalizedName:normalizeName(raw),occupation:attendeeOccupation(other)}}});
}
return out;
`));
  const history = g.http("Unipile: Paginate chat history", {
    url: "=https://api8.unipile.com:13818/api/v1/chats/{{ $json.chatId }}/messages?limit=100",
    options: { pagination: { pagination: { paginationMode: "updateAParameterInEachRequest", parameters: { parameters: [{ type: "qs", name: "cursor", value: "={{ $response.body.cursor }}" }] }, paginationCompleteWhen: "other", completeExpression: "={{ !$response.body.cursor }}", limitPagesFetched: true, maxRequests: 100, requestInterval: 100 } } },
  }, UNIPILE);
  const events = g.codeNode("Expand chronological events", withCore(`
const chats=$('Attach counterpart identity').all();const groups=new Map();
for(const page of $input.all()){
  const paired=Array.isArray(page.pairedItem)?page.pairedItem[0]:page.pairedItem;const index=Number(paired?.item||0);const chat=chats[index]?.json;if(!chat)continue;
  if(!groups.has(index))groups.set(index,{chat,pages:[]});groups.get(index).pages.push(page.json);
}
const out=[];
for(const {chat,pages} of groups.values()){
  const raw=pages.flatMap(p=>p.items||[]);const deduped=dedupeAndSortMessages(raw,{cap:10000});const truncated=deduped.truncated||Boolean(pages.at(-1)?.cursor);
  for(const m of deduped.messages)out.push({json:{source:'nightly',event:{proceed:true,eventKey:chat.accountId+':'+m.id,accountId:chat.accountId,chatId:chat.chatId,messageId:m.id,timestamp:new Date(m.timestamp).toISOString(),direction:m.is_sender===1?'outbound':'inbound',text:safeString(m.text)||attachmentLabel(m),repName:chat.repName,selfId:chat.selfId,counterpart:chat.counterpart,originalPayloadRef:{source:'nightly',accountId:chat.accountId,chatId:chat.chatId,messageId:m.id},historyTruncated:truncated}}});
}
return out;
`), "runOnceForAllItems");
  const processEvents = g.execute("Repair through shared saga", processorId);
  const recovery = g.node("DT: Failed and stale events", "n8n-nodes-base.dataTable", {
    resource: "row", operation: "get", dataTableId: { __rl: true, mode: "id", value: DT_EVENT }, matchType: "anyCondition",
    filters: { conditions: [{ keyName: "status", condition: "eq", keyValue: "failed" }, { keyName: "status", condition: "eq", keyValue: "processing" }] }, returnAll: true, options: {},
  }, { typeVersion: 1, alwaysOutputData: true });
  const recoverable = g.codeNode("Recover incomplete envelopes", `
const now=Date.now();const out=[];for(const item of $input.all()){const r=item.json;if(!r.normalized_event)continue;if(r.status==='processing'&&now-new Date(r.updated_at||0).valueOf()<10*60*1000)continue;try{out.push({json:{source:'nightly',event:JSON.parse(r.normalized_event)}});}catch{}}
return out;
`, "runOnceForAllItems");
  const processRecovery = g.execute("Resume incomplete through shared saga", processorId);
  g.link("Nightly", daily); g.link("Weekly Sweep", weekly); g.link(daily, accounts); g.link(weekly, accounts);
  g.link(accounts, chats); g.link(chats, flatten); g.link(flatten, attendees); g.link(attendees, identity); g.link(identity, history); g.link(history, events); g.link(events, processEvents);
  g.link("Nightly", recovery); g.link("Weekly Sweep", recovery); g.link(recovery, recoverable); g.link(recoverable, processRecovery);
  return workflow(backup.name, g, backup.settings);
}

function buildAction(processorId, backup) {
  const g = graph("action");
  const original = backup.nodes.find((node) => node.name === "Create Link");
  g.nodes.push(original);
  const parse = g.codeNode("Parse signed action", `
const q=$input.first().json.query||{};const allowed=['same_person','different_person','qualified','not_qualified'];let payload={};try{payload=JSON.parse(decodeURIComponent(q.p||''));}catch{}
const type=String(q.a||'');const caseKey=String(q.k||payload.caseKey||'');return [{json:{ok:Boolean(caseKey&&allowed.includes(type)),caseKey,eventKey:String(payload.eventKey||''),action:{type,candidateId:String(payload.candidateId||'')}}}];
`);
  const valid = g.ifNode("Valid action?", "$json.ok");
  const bad = g.node("Show bad action", "n8n-nodes-base.respondToWebhook", { respondWith: "text", responseBody: "This review link is invalid or incomplete.", options: { responseCode: 400 } }, { typeVersion: 1.4 });
  const getCase = g.dtGet("DT: Revalidate case", DT_CASE, "case_key", "={{ $json.caseKey }}");
  const caseGate = g.codeNode("Gate idempotent action", `
const request=$('Parse signed action').first().json;const rows=$input.all().map(i=>i.json).filter(r=>r.case_key);const c=rows.sort((a,b)=>new Date(b.updated_at||0)-new Date(a.updated_at||0))[0]||{};
return [{json:{...request,case:c,replay:c.status==='resolved',recorded:c.action_result||''}}];
`, "runOnceForAllItems");
  const replay = g.ifNode("Already resolved?", "$json.replay");
  const showReplay = g.node("Show recorded outcome", "n8n-nodes-base.respondToWebhook", { respondWith: "text", responseBody: "={{ $json.recorded || 'This decision was already recorded.' }}", options: { responseCode: 200 } }, { typeVersion: 1.4 });
  const claim = g.dtUpsert("DT: Claim action", DT_CASE, "case_key", "={{ $json.caseKey }}", {
    case_key: "={{ $json.caseKey }}", status: "processing_action", action_nonce: "={{ $execution.id }}", updated_at: "={{ $now.toISO() }}",
  });
  const settleClaim = g.node("Settle action claim", "n8n-nodes-base.wait", { amount: 1, unit: "seconds" }, { typeVersion: 1.1 });
  const recheckClaim = g.dtGet("DT: Recheck action claim", DT_CASE, "case_key", "={{ $('Gate idempotent action').first().json.caseKey }}");
  const ownsClaim = g.codeNode("Verify action claim", `const gate=$('Gate idempotent action').first().json;const row=$input.all().map(i=>i.json).find(r=>r.case_key)||{};return [{json:{...gate,ownsClaim:String(row.action_nonce||'')===String($execution.id)}}];`, "runOnceForAllItems");
  const claimOk = g.ifNode("Action claim acquired?", "$json.ownsClaim");
  const claimBusy = g.node("Show action in progress", "n8n-nodes-base.respondToWebhook", { respondWith: "text", responseBody: "Another decision for this case is already being processed. Refresh Slack for the recorded outcome.", options: { responseCode: 200 } }, { typeVersion: 1.4 });
  const getEvent = g.dtGet("DT: Load original event", DT_EVENT, "event_key", "={{ $('Gate idempotent action').first().json.eventKey || JSON.parse($('Gate idempotent action').first().json.case.event_keys || '[]')[0] }}");
  const prepare = g.codeNode("Resume reviewed event", `
const gate=$('Gate idempotent action').first().json;const row=$input.all().map(i=>i.json).find(r=>r.normalized_event);if(!row)throw new Error('Original event is unavailable');
return [{json:{source:'action',event:JSON.parse(row.normalized_event),action:gate.action,preferredCompanyId:gate.case.company_id||'',companyEvidence:{name:gate.case.company_name||'',domain:gate.case.company_domain||'',evidence:gate.case.company_evidence||''}}}];
`, "runOnceForAllItems");
  const processAction = g.execute("Revalidate and process action", processorId);
  const outcome = g.codeNode("Record action outcome", `
const gate=$('Gate idempotent action').first().json;const result=$input.first().json||{};const text=result.ok?'Decision recorded: '+gate.action.type.replaceAll('_',' '):'Decision could not be completed: '+(result.error||result.status||'unknown error');
return [{json:{...gate,result,text,ok:Boolean(result.ok)}}];
`);
  const save = g.dtUpsert("DT: Resolve case", DT_CASE, "case_key", "={{ $json.caseKey }}", {
    case_key: "={{ $json.caseKey }}", status: "={{ $json.ok ? 'resolved' : 'waiting_review' }}", resolution: "={{ $json.action.type }}",
    resolved_at: "={{ $json.ok ? $now.toISO() : null }}", updated_at: "={{ $now.toISO() }}", action_nonce: "={{ $execution.id }}", action_result: "={{ $json.text }}",
  });
  const updateSlack = g.http("Slack: Replace case with outcome", {
    method: "POST", url: "https://slack.com/api/chat.update", sendBody: true, specifyBody: "json",
    jsonBody: "={{ JSON.stringify({ channel: $('Gate idempotent action').first().json.case.slack_channel, ts: $('Gate idempotent action').first().json.case.slack_ts, text: $('Record action outcome').first().json.text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: ($('Record action outcome').first().json.ok ? ':white_check_mark: ' : ':warning: ') + $('Record action outcome').first().json.text } }] }) }}",
  }, SLACK, { onError: "continueRegularOutput" });
  const respond = g.node("Show action outcome", "n8n-nodes-base.respondToWebhook", { respondWith: "text", responseBody: "={{ $('Record action outcome').first().json.text }}", options: { responseCode: 200 } }, { typeVersion: 1.4 });
  g.link("Create Link", parse); g.link(parse, valid); g.link(valid, getCase, 0); g.link(valid, bad, 1); g.link(getCase, caseGate); g.link(caseGate, replay);
  g.link(replay, showReplay, 0); g.link(replay, claim, 1); g.link(claim, settleClaim); g.link(settleClaim, recheckClaim); g.link(recheckClaim, ownsClaim); g.link(ownsClaim, claimOk);
  g.link(claimOk, getEvent, 0); g.link(claimOk, claimBusy, 1); g.link(getEvent, prepare); g.link(prepare, processAction); g.link(processAction, outcome); g.link(outcome, save); g.link(save, updateSlack); g.link(updateSlack, respond);
  return workflow(backup.name, g, backup.settings);
}

function validateWorkflow(definition) {
  const names = definition.nodes.map((node) => node.name);
  if (new Set(names).size !== names.length) throw new Error(`${definition.name}: duplicate node names`);
  const known = new Set(names);
  for (const [from, outputs] of Object.entries(definition.connections)) {
    if (!known.has(from)) throw new Error(`${definition.name}: missing source ${from}`);
    for (const branch of outputs.main || []) for (const target of branch || []) if (!known.has(target.node)) throw new Error(`${definition.name}: missing target ${target.node}`);
  }
  return definition;
}

async function api(pathname, options = {}) {
  const response = await fetch(`${API}${pathname}`, {
    ...options,
    headers: { "X-N8N-API-KEY": API_KEY, Accept: "application/json", ...(options.body ? { "Content-Type": "application/json; charset=utf-8" } : {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || "GET"} ${pathname}: HTTP ${response.status} ${JSON.stringify(body).slice(0, 500)}`);
  return body;
}

async function saveWorkflow(key, definition, existingId = "") {
  validateWorkflow(definition);
  await mkdir(generatedDir, { recursive: true });
  await writeFile(path.join(generatedDir, `${key}.json`), `${JSON.stringify(definition, null, 2)}\n`, "utf8");
  if (DRY_RUN) return { id: existingId || `dry-${key}`, ...definition };
  const result = await api(`/workflows${existingId ? `/${existingId}` : ""}`, {
    method: existingId ? "PUT" : "POST",
    body: JSON.stringify(definition),
  });
  console.log(`${existingId ? "Updated" : "Created"} ${result.name} [${result.id}] (${definition.nodes.length} nodes)`);
  return result;
}

const resolver = await saveWorkflow("shared-resolver", buildResolver(), workflowManifest.sharedResolverId);
workflowManifest.sharedResolverId = resolver.id;
const mutation = await saveWorkflow("shared-mutation", buildMutation(), workflowManifest.sharedMutationId);
workflowManifest.sharedMutationId = mutation.id;
const processor = await saveWorkflow("shared-processor", buildProcessor(resolver.id, mutation.id), workflowManifest.sharedProcessorId);
workflowManifest.sharedProcessorId = processor.id;

if (APPLY_PRODUCTION) {
  const backupDir = "docs/integration/backups/2026-08-27-before-remediation";
  const liveBackup = JSON.parse(await readFile(`${backupDir}/linkedin-unipile-webhook_d6FagRZslhkj5Zyk.json`, "utf8"));
  const nightlyBackup = JSON.parse(await readFile(`${backupDir}/linkedin-nightly-reconciler_gw3u2a4xBbHltwZJ.json`, "utf8"));
  const actionBackup = JSON.parse(await readFile(`${backupDir}/linkedin-unmatched-create_o6HZL39NOaOASH2D.json`, "utf8"));
  const live = buildLive(processor.id, liveBackup);
  const nightly = buildNightly(processor.id, nightlyBackup);
  const action = buildAction(processor.id, actionBackup);
  const livePath = live.nodes.find((node) => node.type === "n8n-nodes-base.webhook")?.parameters?.path;
  const actionPath = action.nodes.find((node) => node.type === "n8n-nodes-base.webhook")?.parameters?.path;
  const originalSchedules = nightlyBackup.nodes.filter((node) => node.type === "n8n-nodes-base.scheduleTrigger").map((node) => JSON.stringify(node.parameters.rule)).sort();
  const newSchedules = nightly.nodes.filter((node) => node.type === "n8n-nodes-base.scheduleTrigger").map((node) => JSON.stringify(node.parameters.rule)).sort();
  if (livePath !== "unipile-linkedin-message" || actionPath !== "linkedin-create-lead" || JSON.stringify(originalSchedules) !== JSON.stringify(newSchedules)) {
    throw new Error("Webhook paths or schedules changed; refusing production update");
  }
  await saveWorkflow("production-live", live, "d6FagRZslhkj5Zyk");
  await saveWorkflow("production-nightly", nightly, "gw3u2a4xBbHltwZJ");
  await saveWorkflow("production-action", action, "o6HZL39NOaOASH2D");
  workflowManifest.productionUpdatedAt = new Date().toISOString();
}

if (!DRY_RUN) await writeFile(workflowManifestFile, `${JSON.stringify(workflowManifest, null, 2)}\n`, "utf8");
