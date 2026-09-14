/**
 * GDPR — Article 15 - Export Reader
 *
 * Turns a Genesys GDPR Access export archive into a readable Excel workbook,
 * entirely in the browser. Nothing in the archive is uploaded or proxied.
 *
 * What Genesys delivers is a ZIP of flat `service!identifier` files: no
 * folders, no index, mostly no extension, and 96–99% of them are ~600-byte
 * analytics acknowledgement receipts with no content. The content that
 * matters — message and email transcripts (zips inside the zip), call audio,
 * journey sessions, the subject record — is what this page pulls out. The
 * archive shapes were characterised from five real exports, three for
 * external contacts and two for Genesys users; docs/gdpr-export-reader-design.md
 * is the catalogue this parser follows.
 *
 * Design decisions agreed 2026-09-14:
 *   - counterpart names and email addresses are reproduced (they are the
 *     subject's correspondence); phone numbers in from/to are withheld
 *   - HTML-only email bodies are stripped to text; HTML is never reproduced
 *   - the user's internal colleague chat goes on Messages as "Internal chat"
 *   - performance points are a sheet; metric ids stay ids (no API lookup)
 *   - calls are listed with duration and whether Genesys transcribed them;
 *     the transcript text is not in the archive and nothing is transcribed here
 */
import { escapeHtml, makeStatus, downloadWorkbook, downloadBase64, downloadDeferred } from "../../utils.js";
import { addStyledSheet } from "../../utils/excelStyles.js";
import { logAction } from "../../services/activityLogService.js";

const ROW_CAP = 100000;

/** WEM containers: prefix → { label, the top-level arrays that hold rows }. */
const WEM_CONTAINERS = {
  "adjustments-service":                        { label: "Time-off adjustments",   keys: ["entities"] },
  "alternative-shifts":                         { label: "Shift trades & offers",  keys: ["trades", "offers"] },
  "wem-coaching":                               { label: "Coaching",               keys: ["appointments", "annotations"] },
  "wem-recognition-service":                    { label: "Recognitions",           keys: ["recognitions.sender", "recognitions.receiver"] },
  "wfm-self-scheduling":                        { label: "Activity moves",         keys: ["activityMoves"] },
  "workforce-management-adherence-explanations": { label: "Adherence explanations", keys: ["explanations"] },
  "PUSH":                                       { label: "Push notifications",     keys: ["notificationIds", "deviceTokens"] },
};

/**
 * Receipt topics whose `externalId` is a conversation id. `ConversationEvent`
 * is the authoritative set — every conversation the subject took part in;
 * the others add a fact about one of those conversations. Verified on the
 * user and contact exports, with one exception: `TranscriptsEvent` ids are
 * sometimes a *communication* id inside the conversation rather than the
 * conversation itself (96 of 179 in one export), and those cannot be
 * attributed to a conversation with certainty, so they are counted and
 * reported on the Summary rather than guessed at. The remaining topics key
 * on the user (UserActivityEvents, PresenceEvents), a knowledge document, a
 * work item, or nothing at all.
 */
const CONVERSATION_TOPICS = {
  ConversationEvent:                  "events",
  ProviderCallEventSubmitted:         "provider",
  AnalyticsDetailEvents:              "detail",
  TranscriptsEvent:                   "transcribed",
  ConversationSummaryEvents:          "summarised",
  ConversationSummaryEngagementEvents: "summarised",
  ConversationSuggestionEvents:       "suggestions",
  StaMetricsEvent:                    "sta",
  ResolutionEvents:                   "resolution",
  VoicemailEvent:                     "voicemail",
  SurveyUpdated:                      "survey",
};

const PHONE_RE = /^\s*(tel:)?\+?\d[\d\s().-]{5,}\d\s*$/;
// A bare Genesys id — participant, deployment, 32-hex message id — names nobody.
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9a-f]{24,32}$/i;

/** Sections on the Subject sheet, in the order a reader wants them. */
const SUBJECT_ORDER = ["User profile", "External contact", "Login", "Station", "Call forwarding", "Contact notes"];

export default function renderExportReader({ me, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  el.innerHTML = `
    <h2>GDPR — Article 15 - Export Reader</h2>
    <p class="page-desc">
      Turn a completed Access export into a readable Excel workbook. Download the archive from
      <strong>Request Status</strong>, then drop it here. The file is read in your browser and
      nothing in it leaves your machine.
    </p>

    <div class="gdpr-expect">
      <p class="gdpr-expect-title">What you get</p>
      <ul class="gdpr-expect-list">
        <li><strong>One workbook, one sheet per kind of data</strong>: the subject record, emails,
            messages, calls, conversation outlines, journey sessions, attachments, surveys, billing references
            and &mdash; for a Genesys user &mdash; performance points and workforce-management records.
            A sheet with nothing in it is left out and the Summary says so.</li>
        <li><strong>Calls are listed, not transcribed.</strong> The archive holds the audio and, where
            Genesys transcribed or summarised the call, an acknowledgement that it did &mdash; never the
            text. The Calls sheet gives each recording's duration and whether a transcript or summary
            existed. Where Speech &amp; Text Analytics wrote an outline of a conversation &mdash; call or
            messaging &mdash; it is on the Conversation outlines sheet.</li>
        <li><strong>A Conversations index</strong> is assembled from the thousands of acknowledgement
            receipts: every conversation they name, when its first and last event happened, and what
            the archive holds for it. Genesys exports no participant, queue or wrap-up detail; this is
            as close as the archive gets.</li>
        <li><strong>Audio and attachments</strong> can be saved all at once as a zip &mdash; audio in one
            folder, attachments in a folder per conversation &mdash; or one at a time from the list below.</li>
        <li><strong>Other people's phone numbers are withheld</strong> from the message and email
            rows; their names and email addresses are kept, because they are the correspondence.</li>
        <li>The workbook is a rendering of what Genesys exported, not a certified copy.</li>
      </ul>
    </div>

    <div class="gdpr-drop" id="gdprDrop" tabindex="0" role="button" aria-label="Choose an export archive">
      <input type="file" id="gdprFile" accept=".zip,application/zip" style="display:none" />
      <p class="gdpr-drop-title">Drop the export archive here, or click to choose</p>
      <p class="gdpr-drop-sub">results-&lt;request id&gt;-&lt;timestamp&gt;.zip, as downloaded from Request Status</p>
    </div>

    <div class="te-status" id="gdprReaderStatus"></div>
    <div id="gdprReaderResult" style="margin-top:12px"></div>
  `;

  const $drop   = el.querySelector("#gdprDrop");
  const $file   = el.querySelector("#gdprFile");
  const $result = el.querySelector("#gdprReaderResult");
  const setStatus = makeStatus(el.querySelector("#gdprReaderStatus"), "te-status");

  let model = null;
  let busy = false;

  $drop.addEventListener("click", () => { if (!busy) $file.click(); });
  $drop.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && !busy) { e.preventDefault(); $file.click(); }
  });
  $drop.addEventListener("dragover", (e) => { e.preventDefault(); $drop.classList.add("gdpr-drop--over"); });
  $drop.addEventListener("dragleave", () => $drop.classList.remove("gdpr-drop--over"));
  $drop.addEventListener("drop", (e) => {
    e.preventDefault();
    $drop.classList.remove("gdpr-drop--over");
    const f = e.dataTransfer?.files?.[0];
    if (f) readFile(f);
  });
  $file.addEventListener("change", () => {
    const f = $file.files?.[0];
    if (f) readFile(f);
    $file.value = "";
  });

  async function readFile(file) {
    if (busy) return;
    if (typeof JSZip === "undefined") {
      setStatus("ZIP library not loaded. Please reload the page.", "error");
      return;
    }
    busy = true;
    $drop.classList.add("gdpr-drop--busy");
    $result.innerHTML = "";
    model = null;
    try {
      model = await parseArchive(file, (msg) => setStatus(msg));
      setStatus(`Read ${model.fileCount.toLocaleString()} files.`, "success");
      renderResult();
      const org = orgContext?.getDetails?.();
      logAction({ me, orgId: org?.id, orgName: org?.name || "",
        action: "gdpr_export_read",
        description: `Read GDPR Access export archive for request ${model.requestId || "(unknown)"}`,
        count: model.fileCount });
    } catch (err) {
      // JSZip's own message for a non-zip ends in a documentation URL; say it plainly.
      const why = /central directory/i.test(err.message) ? `${file.name} is not a ZIP archive.` : err.message;
      setStatus(`Could not read the archive: ${why}`, "error");
    } finally {
      busy = false;
      $drop.classList.remove("gdpr-drop--busy");
    }
  }

  // ── Result panel ──────────────────────────────────────────────────
  function renderResult() {
    const m = model;
    const counts = [
      ["Subject",            m.subjectRows.length ? 1 : 0],
      ["Emails",             m.emails.length],
      ["Messages",           m.messages.length],
      ["Conversations",      m.conversationRows.length],
      ["Calls",              m.calls.length],
      ["Conversation outlines", m.outlines.length],
      ["Journey sessions",   m.journeys.length],
      ["Attachments",        m.attachments.length],
      ["Performance points", m.points.length],
      ["WEM records",        m.wem.length],
      ["Surveys",            m.surveys.length],
      ["Billing references", m.billing.length],
      ["Receipts",           m.receiptTotal],
    ];
    const present = counts.filter(([, n]) => n > 0);
    const absent  = counts.filter(([, n]) => n === 0).map(([k]) => k);

    // The 27-byte placeholder recordings are on the Calls sheet as "empty";
    // there is nothing in them to save.
    const files = [...m.audio, ...m.attachments].filter((f) => f.size > 0 && !f.empty);

    $result.innerHTML = `
      <div class="gdpr-reader-summary">
        <table class="gdpr-reader-kv">
          <tr><th>Subject</th><td>${escapeHtml(m.subjectName || "(not in archive)")}
            <span class="gdpr-reader-kind">${escapeHtml(m.subjectKindLabel)}</span></td></tr>
          <tr><th>Request</th><td>${escapeHtml(m.requestId || "unknown")}</td></tr>
          <tr><th>Exported</th><td>${escapeHtml(m.exportedAt || "unknown")}</td></tr>
          <tr><th>Archive</th><td>${escapeHtml(m.fileName)} &mdash; ${m.fileCount.toLocaleString()} files</td></tr>
        </table>
        <table class="gdpr-reader-counts">
          ${present.map(([k, n]) => `<tr><th>${escapeHtml(k)}</th><td>${n.toLocaleString()}</td></tr>`).join("")}
        </table>
        ${absent.length ? `<p class="gdpr-reader-absent">Nothing for: ${absent.map(escapeHtml).join(", ")}.</p>` : ""}
        ${m.unknown.size ? `<p class="gdpr-reader-absent gdpr-reader-unknown">Not recognised (listed on the Summary sheet): ${[...m.unknown.keys()].map(escapeHtml).join(", ")}.</p>` : ""}
      </div>
      <div class="te-actions">
        <button class="btn te-btn-export" id="gdprReaderSave">Save workbook</button>
        ${files.length ? `<button class="btn te-btn-export" id="gdprReaderSaveAll">Save all audio &amp; attachments (.zip, ${fmtSize(files.reduce((a, f) => a + f.size, 0))})</button>` : ""}
      </div>
      ${files.length ? `
        <details class="gdpr-reader-files">
          <summary>Audio and attachments (${files.length})</summary>
          <div class="gdpr-table-wrap">
            <table class="gdpr-table">
              <thead><tr><th>Kind</th><th>File</th><th>Conversation</th><th>Size</th><th></th></tr></thead>
              <tbody>
                ${files.map((f, i) => `
                  <tr>
                    <td>${escapeHtml(f.kind)}</td>
                    <td class="gdpr-reader-mono">${escapeHtml(f.fileName)}</td>
                    <td class="gdpr-reader-mono">${escapeHtml(f.conversationId || "")}</td>
                    <td>${fmtSize(f.size)}</td>
                    <td><button class="btn btn-sm" data-save="${i}">Save</button></td>
                  </tr>`).join("")}
              </tbody>
            </table>
          </div>
        </details>` : ""}
    `;

    $result.querySelector("#gdprReaderSave").addEventListener("click", () => {
      try {
        downloadWorkbook(buildWorkbook(m), workbookName(m));
      } catch (err) {
        setStatus(err.message, "error");
      }
    });

    const $saveAll = $result.querySelector("#gdprReaderSaveAll");
    if ($saveAll) $saveAll.addEventListener("click", async () => {
      $saveAll.disabled = true;
      try {
        await downloadDeferred(filesZipName(m), (report) => buildFilesZip(files, report));
        setStatus("");
      } catch (err) {
        setStatus(err.message, "error");
      } finally {
        $saveAll.disabled = false;
      }
    });

    $result.querySelectorAll("[data-save]").forEach(($b) => {
      $b.addEventListener("click", async () => {
        const f = files[Number($b.dataset.save)];
        $b.disabled = true;
        try {
          const b64 = await f.entry.async("base64");
          downloadBase64(f.fileName, b64);
        } catch (err) {
          setStatus(err.message, "error");
        } finally {
          $b.disabled = false;
        }
      });
    });
  }

  return el;
}

// ═══════════════════════════════════════════════════════════════════
// Parsing
// ═══════════════════════════════════════════════════════════════════

/**
 * Read the archive into a model of plain rows, one array per sheet.
 *
 * Entries are classified by their `service!` prefix. Receipts are opened
 * only for their topic and conversation id and then dropped, so 37,000 of
 * them cost time, not memory. Audio is read once for its last Ogg page and
 * the bytes released; the Save buttons read again on demand.
 */
async function parseArchive(file, progress) {
  progress("Opening archive…");
  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files).filter((e) => !e.dir);

  const nameMatch = /^results-([0-9a-f-]{36})-(\d{4}-\d\d-\d\dT[\d_]+(?:\.\d+)?Z)/i.exec(file.name);
  const m = {
    fileName:   file.name,
    fileCount:  entries.length,
    requestId:  nameMatch ? nameMatch[1] : "",
    exportedAt: nameMatch ? nameMatch[2].replace(/_/g, ":") : "",
    subjectKind: "unknown", subjectKindLabel: "", subjectName: "", subjectRows: [],
    emails: [], messages: [], calls: [], outlines: [], journeys: [], attachments: [],
    points: [], personalBests: [], wem: [], surveys: [], billing: [],
    receipts: new Map(), receiptTotal: 0,
    // conversation id → what the receipts say happened to it
    conversations: new Map(),
    emptyCategories: [], deployments: [],
    unknown: new Map(),
    audio: [],
    notes: [],
  };

  let hasContact = false, hasUser = false;
  let done = 0;
  const total = entries.length;
  const tick = () => {
    done++;
    if (done % 500 === 0 || done === total) progress(`Reading… ${done.toLocaleString()} / ${total.toLocaleString()}`);
  };

  for (const entry of entries) {
    const name = entry.name;
    const bang = name.indexOf("!");
    const prefix = bang > 0 ? name.slice(0, bang) : "";
    const rest   = bang > 0 ? name.slice(bang + 1) : name;

    try {
      switch (prefix) {
        case "analytics": {
          const j = await readJson(entry);
          const topic = j?.topic || j?.name || "(unnamed)";
          m.receipts.set(topic, (m.receipts.get(topic) || 0) + 1);
          m.receiptTotal++;
          const flag = CONVERSATION_TOPICS[topic];
          if (flag && typeof j?.externalId === "string") {
            let c = m.conversations.get(j.externalId);
            if (!c) { c = { id: j.externalId, first: Infinity, last: -Infinity, events: 0, flags: new Set() }; m.conversations.set(j.externalId, c); }
            const ts = j.eventTimestamp;
            if (typeof ts === "number") { if (ts < c.first) c.first = ts; if (ts > c.last) c.last = ts; }
            if (flag === "events") c.events++; else c.flags.add(flag);
          }
          break;
        }
        case "recording":
          await readRecording(entry, rest, m);
          break;
        case "contacts-service": {
          const j = await readJson(entry);
          if (/notes/i.test(rest)) {
            if (isEmptyish(j)) m.emptyCategories.push("Contact notes");
            else m.subjectRows.push(...flatten(j, "Contact notes"));
          } else if (j && typeof j === "object") {
            hasContact = true;
            m.subjectName = m.subjectName || [j.firstName, j.lastName].filter(Boolean).join(" ");
            m.subjectRows.push(...flatten(j, "External contact"));
          }
          break;
        }
        case "journey-session-store": {
          const j = await readJson(entry);
          if (j) m.journeys.push({
            id: j.id, subject: j.conversationSubject || "", direction: j.originatingDirection || "",
            channels: (j.channels || []).join("; "), type: j.type || "",
            started: epochToIso(j.createdDate), ended: epochToIso(j.endedDate),
            durationSec: j.durationInSeconds ?? "", outcome: j.lastAcdOutcome || "",
            queue: j.lastConnectedQueue || "", user: j.lastConnectedUser || "",
            events: j.eventCount ?? "", externalContactId: j.externalContactId || "",
          });
          break;
        }
        case "billing-service": {
          const j = await readJson(entry);
          for (const block of asArray(j)) {
            const notes = Array.isArray(block?.notes) ? block.notes.join(" ") : (block?.notes || "");
            for (const d of asArray(block?.data)) m.billing.push({ source: block?.source || "", id: d?.id ?? String(d), notes });
          }
          break;
        }
        case "quality": {
          const j = await readJson(entry);
          for (const s of asArray(j)) readSurvey(s, m);
          break;
        }
        case "venue": {
          const j = await readJson(entry);
          hasUser = true;
          const nm = asArray(j?.name)[0];
          if (nm) m.subjectName = m.subjectName || nm;
          m.subjectRows.push(...flatten(j, "User profile"));
          break;
        }
        case "auth-api": {
          const t = (await entry.async("string")).trim();
          hasUser = true;
          if (t) m.subjectRows.push(["Login", "email", t]);
          break;
        }
        case "edge-config-user": {
          const j = await readJson(entry);
          hasUser = true;
          m.subjectRows.push(...flatten(j, /callForwarding/i.test(rest) ? "Call forwarding" : "Station"));
          break;
        }
        case "REALTIME": {
          const t = await entry.async("string");
          for (const line of t.split(/\r?\n/)) {
            const mm = /^created:\s*(\S+),\s*message:\s?(.*)$/.exec(line);
            if (mm) m.messages.push({
              conversationId: "", time: mm[1], channel: "Internal chat", direction: "sent",
              from: "(the subject)", to: "", text: mm[2], status: "",
            });
          }
          break;
        }
        case "postino-service": {
          const j = await readJson(entry);
          const convId = j?.conversationId || rest;
          const comms = asArray(j?.communications);
          const direction = comms.find((c) => c?.direction)?.direction || "";
          for (const msg of asArray(j?.messages)) {
            if (msg?.messageID === "draft") continue;
            m.emails.push({
              conversationId: convId, recordingId: "", source: "Email record (headers only)",
              time: normaliseTime(msg.time), direction,
              from: addr(msg.from), to: asArray(msg.to).map(addr).join("; "),
              cc: asArray(msg.cc).map(addr).join("; "),
              subject: msg.subject || "", body: "(body not in export)",
              attachments: asArray(msg.attachments).map((a) => a?.name || a?.contentPath || "").filter(Boolean).join("; "),
            });
          }
          break;
        }
        case "sta-transcript-outliner": {
          const j = await readJson(entry);
          const ids = /^([0-9a-f-]{36})_([0-9a-f-]{36})/i.exec(rest);
          for (const s of asArray(j?.segments)) m.outlines.push({
            conversationId: ids ? ids[1] : rest, communicationId: ids ? ids[2] : "",
            header: s?.header || "", description: s?.description || "",
            start: epochToIso(s?.firstPhraseStartTimeMs), end: epochToIso(s?.lastPhraseStartTimeMs),
          });
          break;
        }
        case "gamification-service": {
          const j = await readJson(entry);
          const tz = j?.timezones || {};
          for (const [day, items] of Object.entries(j?.workdays || {})) {
            const status = asArray(items).find((i) => i?.status)?.status || "";
            const zone = asArray(tz[day]).find((t) => t?.timezone)?.timezone || "";
            for (const it of asArray(items)) {
              if (!it || it.metricId === undefined) continue;
              m.points.push({ date: day, status, timezone: zone, metricId: it.metricId,
                points: it.points ?? "", maxPoints: it.maxPoints ?? "", value: it.value ?? "" });
            }
          }
          for (const pb of asArray(j?.personal_bests)) m.personalBests.push(pb);
          if (!m.points.length && !m.personalBests.length) m.emptyCategories.push("Performance points");
          break;
        }
        case "squonk-service": {
          const j = await readJson(entry);
          for (const d of asArray(j?.deployments)) m.deployments.push(`${d?.name || d?.id || "?"} (${d?.status || "status unknown"})`);
          for (const c of asArray(j?.configVersions)) m.deployments.push(`config: ${c?.name || c?.id || "?"} v${c?.version ?? "?"}`);
          break;
        }
        default: {
          if (WEM_CONTAINERS[prefix]) {
            const j = await readJson(entry);
            const { label, keys } = WEM_CONTAINERS[prefix];
            let any = 0;
            for (const k of keys) {
              const rows = asArray(getPath(j, k));
              for (const r of rows) { m.wem.push({ category: label, group: k, details: flatLine(r) }); any++; }
            }
            if (!any) m.emptyCategories.push(label);
          } else {
            const u = m.unknown.get(prefix || "(no prefix)") || { count: 0, keys: "" };
            u.count++;
            if (!u.keys) {
              const j = await readJson(entry).catch(() => null);
              u.keys = j && typeof j === "object" ? Object.keys(Array.isArray(j) ? (j[0] || {}) : j).slice(0, 15).join(", ") : "(not JSON)";
            }
            m.unknown.set(prefix || "(no prefix)", u);
          }
        }
      }
    } catch (err) {
      m.notes.push(`${name}: ${err.message}`);
    }
    tick();
  }

  // Cross-references that need the whole archive read first.
  const outlineByConv = new Map();
  for (const o of m.outlines) {
    if (!outlineByConv.has(o.conversationId)) outlineByConv.set(o.conversationId, []);
    outlineByConv.get(o.conversationId).push(o.header);
  }
  for (const c of m.calls) {
    const conv = m.conversations.get(c.conversationId);
    c.transcribed = conv?.flags.has("transcribed") ? "Yes — text not in export" : "No";
    c.summarised  = conv?.flags.has("summarised")  ? "Yes — text not in export" : "No";
    c.outline = (outlineByConv.get(c.conversationId) || []).join(" › ");
  }

  // The Conversations index: one row per conversation the receipts name,
  // joined to whatever the archive actually holds for it. This is the
  // closest thing the export has to conversation detail — Genesys ships no
  // participant, queue or wrap-up record, only these acknowledgements.
  const count = (list, key = "conversationId") => {
    const out = new Map();
    for (const r of list) { const k = r[key]; if (k) out.set(k, (out.get(k) || 0) + 1); }
    return out;
  };
  const nCalls = count(m.calls), nMsgs = count(m.messages), nEmails = count(m.emails),
        nOutl = count(m.outlines), nSurv = count(m.surveys), nJourney = count(m.journeys, "id");
  const yes = (v) => (v ? "Yes" : "");
  // Only ids that ConversationEvent names are conversations; an id seen
  // solely under another topic is a communication or something else.
  m.unattributed = new Map();
  for (const c of m.conversations.values()) {
    if (c.events > 0) continue;
    for (const f of c.flags) m.unattributed.set(f, (m.unattributed.get(f) || 0) + 1);
  }
  m.conversationRows = [...m.conversations.values()]
    .filter((c) => c.events > 0)
    .sort((a, b) => a.first - b.first)
    .map((c) => ({
      id: c.id,
      first: epochToIso(c.first === Infinity ? 0 : c.first),
      last:  epochToIso(c.last === -Infinity ? 0 : c.last),
      events: c.events,
      recordings: nCalls.get(c.id) || 0,
      transcribed: yes(c.flags.has("transcribed")),
      summarised: yes(c.flags.has("summarised")),
      outlined: nOutl.get(c.id) || 0,
      messages: nMsgs.get(c.id) || 0,
      emails: nEmails.get(c.id) || 0,
      journey: yes(nJourney.has(c.id)),
      survey: yes(c.flags.has("survey") || nSurv.has(c.id)),
      voicemail: yes(c.flags.has("voicemail")),
      resolution: yes(c.flags.has("resolution")),
    }));

  m.subjectRows.sort((a, b) => {
    const ra = SUBJECT_ORDER.indexOf(a[0]), rb = SUBJECT_ORDER.indexOf(b[0]);
    return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
  });
  m.subjectKind = hasContact && hasUser ? "both" : hasContact ? "contact" : hasUser ? "user" : "unknown";
  m.subjectKindLabel = { both: "Genesys user and external contact", contact: "External contact",
    user: "Genesys user", unknown: "No subject record in archive" }[m.subjectKind];

  for (const list of ["conversationRows", "emails", "messages", "calls", "outlines", "journeys", "attachments", "points", "wem", "surveys", "billing"]) {
    if (m[list].length > ROW_CAP) {
      m.notes.push(`${list}: ${m[list].length.toLocaleString()} rows, only the first ${ROW_CAP.toLocaleString()} are in the workbook.`);
      m[list].length = ROW_CAP;
    }
  }
  return m;
}

/** A `recording!` entry: a transcript bundle, a loose legacy chat JSON, or call audio. */
async function readRecording(entry, rest, m) {
  const ids = /Conv_([0-9a-f-]{36})_Rec_([0-9a-f-]{36})/i.exec(rest);
  const conversationId = ids ? ids[1] : "";
  const recordingId    = ids ? ids[2] : "";
  const lower = rest.toLowerCase();

  if (lower.endsWith(".opus")) {
    const bytes = await entry.async("uint8array");
    const empty = bytes.length <= 64;
    m.calls.push({
      conversationId, recordingId, fileName: rest, size: bytes.length,
      durationSec: empty ? "" : oggDurationSeconds(bytes),
      state: empty ? "empty" : "audio", transcribed: "", summarised: "", outline: "",
    });
    m.audio.push({ kind: "Call audio", fileName: rest, conversationId, size: bytes.length, entry, empty });
    return;
  }

  if (lower.endsWith(".zip")) {
    const inner = await JSZip.loadAsync(await entry.async("uint8array"));
    const files = Object.values(inner.files).filter((e) => !e.dir);
    let owner = "";
    for (const f of files) {
      const base = f.name.split("/").pop();
      if (/^EmailTranscript.*\.json$/i.test(base)) {
        const j = await readJson(f);
        owner = j?.subject || base;
        m.emails.push({
          conversationId, recordingId, source: "Email transcript",
          time: normaliseTime(j?.time), direction: "",
          from: addr(j?.from), to: asArray(j?.to).map(addr).join("; "),
          cc: asArray(j?.cc).map(addr).join("; "),
          subject: j?.subject || "", body: emailBody(j),
          attachments: asArray(j?.attachments).map((a) => a?.name || a?.contentPath || "").filter(Boolean).join("; "),
        });
      } else if (/^MessageTranscript.*\.json$/i.test(base)) {
        const j = await readJson(f);
        for (const r of asArray(j)) m.messages.push(messageRow(r, conversationId));
      }
    }
    for (const f of files) {
      const base = f.name.split("/").pop();
      if (/^(Email|Message)Transcript.*\.json$/i.test(base)) continue;
      const size = (await f.async("uint8array")).length;
      m.attachments.push({ kind: "Attachment", conversationId, recordingId, belongsTo: owner || recordingId,
        fileName: base, size, entry: f });
    }
    return;
  }

  if (lower.endsWith(".json")) {
    // Legacy ACD chat (2020): a flat list of member-join / standard / member-leave rows.
    const j = await readJson(entry);
    for (const r of asArray(j)) {
      const kind = r?.bodyType || "";
      const who = r?.from || (r?.participantPurpose ? `(${r.participantPurpose})` : "");
      m.messages.push({
        conversationId: r?.chat || conversationId, time: normaliseTime(r?.utc),
        channel: "Chat (legacy)", direction: r?.participantPurpose || "",
        from: withholdPhone(who), to: "",
        text: kind === "standard" ? (r?.body ?? "") : kind === "member-join" ? "joined" : kind === "member-leave" ? "left" : kind,
        status: "",
      });
    }
    return;
  }

  const size = (await entry.async("uint8array")).length;
  m.attachments.push({ kind: "Recording file", conversationId, recordingId, belongsTo: recordingId,
    fileName: rest, size, entry });
}

function messageRow(r, conversationId) {
  const c = r?.fromContactsContact;
  const fromName = r?.fromUser?.name || r?.fromUser?.displayName
    || (c ? [c.firstName, c.lastName].filter(Boolean).join(" ") : "");
  const from = fromName ? `${fromName} (${r?.purpose || "?"})` : party(r?.from, r?.purpose);
  let text = r?.messageText ?? "";
  if (text === "" && Array.isArray(r?.events)) {
    // Rows with no text are presence and co-browse events; they are kept as
    // one line each so a conversation's shape survives, not dropped.
    text = r.events.map((e) => {
      if (e?.eventType === "Presence") {
        const t = e.presence?.type;
        return t === "Join" ? "[joined]" : t === "Disconnect" ? "[left]" : `[presence: ${t || "?"}]`;
      }
      if (e?.eventType === "CoBrowse") return `[co-browse ${e.coBrowse?.type || ""}]`.replace(" ]", "]");
      return `[${e?.eventType || "event"}]`;
    }).join(" ");
  }
  return {
    conversationId, time: normaliseTime(r?.timestamp), channel: "Messaging",
    direction: r?.purpose || "", from, to: party(r?.to, ""),
    text, status: r?.status || "",
  };
}

function readSurvey(s, m) {
  if (!s || typeof s !== "object") return;
  const base = {
    surveyId: s.surveyId || "", conversationId: s.conversationId || "", status: s.status || "",
    completed: normaliseTime(s.completedDate), sentTo: s.surveyInviteInfo?.targetAddress || "",
    totalScore: s.answers?.totalScore ?? "",
  };
  const groups = asArray(s.answers?.questionGroupScores);
  let any = false;
  for (const g of groups) {
    for (const q of asArray(g?.questionScores)) {
      any = true;
      m.surveys.push({ ...base, questionGroupId: g?.questionGroupId || "", questionId: q?.questionId || "",
        answerId: q?.answerId || "", score: q?.score ?? "", freeText: q?.freeTextAnswer || "" });
    }
  }
  if (!any) m.surveys.push({ ...base, questionGroupId: "", questionId: "", answerId: "", score: "", freeText: "" });
}

// ═══════════════════════════════════════════════════════════════════
// Workbook
// ═══════════════════════════════════════════════════════════════════

function buildWorkbook(m) {
  const wb = XLSX.utils.book_new();

  // Summary is built last so it can list what was omitted, but must be the
  // first tab; SheetJS appends in order, so the rest are collected first.
  const pending = [];
  const queue = (name, headers, rows) => pending.push([name, headers, rows]);

  queue("Subject", ["Section", "Field", "Value"], m.subjectRows);

  queue("Emails", ["Conversation", "Recording", "Source", "Time", "Direction", "From", "To", "Cc", "Subject", "Body", "Attachments"],
    m.emails.map((e) => [e.conversationId, e.recordingId, e.source, e.time, e.direction, e.from, e.to, e.cc, e.subject, e.body, e.attachments]));

  queue("Messages", ["Conversation", "Time", "Channel", "Direction", "From", "To", "Text", "Status"],
    m.messages.map((r) => [r.conversationId, r.time, r.channel, r.direction, r.from, r.to, r.text, r.status]));

  queue("Calls", ["Conversation", "Recording", "Duration", "Seconds", "Size", "State", "Transcribed by Genesys", "Summarised by Genesys", "Outline", "File"],
    m.calls.map((c) => [c.conversationId, c.recordingId, c.durationSec === "" ? "" : fmtDuration(c.durationSec),
      c.durationSec === "" ? "" : Math.round(c.durationSec), c.size, c.state, c.transcribed, c.summarised, c.outline, c.fileName]));

  queue("Conversations", ["Conversation", "First event", "Last event", "Events", "Recordings", "Transcribed", "Summarised", "Outline segments", "Messages", "Emails", "Journey session", "Survey", "Voicemail", "Resolution"],
    m.conversationRows.map((c) => [c.id, c.first, c.last, c.events, c.recordings, c.transcribed, c.summarised, c.outlined, c.messages, c.emails, c.journey, c.survey, c.voicemail, c.resolution]));

  queue("Conversation outlines", ["Conversation", "Communication", "Segment", "Description", "Start", "End"],
    m.outlines.map((o) => [o.conversationId, o.communicationId, o.header, o.description, o.start, o.end]));

  queue("Journey sessions", ["Session", "Type", "Subject", "Direction", "Channels", "Started", "Ended", "Duration (s)", "Outcome", "Queue", "Last user", "Events", "External contact"],
    m.journeys.map((j) => [j.id, j.type, j.subject, j.direction, j.channels, j.started, j.ended, j.durationSec, j.outcome, j.queue, j.user, j.events, j.externalContactId]));

  queue("Attachments", ["Conversation", "Recording", "Belongs to", "File", "Size"],
    m.attachments.map((a) => [a.conversationId, a.recordingId, a.belongsTo, a.fileName, a.size]));

  queue("Performance points", ["Workday", "Status", "Timezone", "Metric id", "Points", "Max points", "Value"],
    [...m.points.map((p) => [p.date, p.status, p.timezone, p.metricId, p.points, p.maxPoints, p.value]),
     ...m.personalBests.map((pb) => [pb?.endWorkday || "", "PERSONAL BEST", "", pb?.granularity || "", pb?.points ?? "", "", ""])]);

  queue("WEM", ["Category", "Group", "Details"], m.wem.map((w) => [w.category, w.group, w.details]));

  queue("Surveys", ["Survey", "Conversation", "Status", "Completed", "Sent to", "Total score", "Question group", "Question", "Answer", "Score", "Free text"],
    m.surveys.map((s) => [s.surveyId, s.conversationId, s.status, s.completed, s.sentTo, s.totalScore, s.questionGroupId, s.questionId, s.answerId, s.score, s.freeText]));

  queue("Billing", ["Source", "Invoice id", "Note"], m.billing.map((b) => [b.source, b.id, b.notes]));

  const receiptRows = [...m.receipts.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => [t, n]);
  queue("Receipts", ["Analytics topic", "Acknowledgements"], receiptRows);

  const omitted = pending.filter(([, , rows]) => !rows.length).map(([name]) => name);

  // ── Summary ──
  const s = [];
  s.push(["Subject", m.subjectName || "(no name in archive)"]);
  s.push(["Subject kind", m.subjectKindLabel]);
  s.push(["Export request id", m.requestId || "unknown (archive was renamed)"]);
  s.push(["Exported at", m.exportedAt || "unknown (archive was renamed)"]);
  s.push(["Archive", m.fileName]);
  s.push(["Files in archive", m.fileCount]);
  s.push(["", ""]);
  s.push(["Conversations named by the receipts", m.conversationRows.length]);
  s.push(["Emails", m.emails.length]);
  s.push(["Messages", m.messages.length]);
  s.push(["Calls (audio files)", m.calls.length]);
  s.push(["  of which empty", m.calls.filter((c) => c.state === "empty").length]);
  s.push(["  of which transcribed by Genesys", m.calls.filter((c) => c.transcribed.startsWith("Yes")).length]);
  s.push(["Conversation outline segments", m.outlines.length]);
  s.push(["Journey sessions", m.journeys.length]);
  s.push(["Attachments", m.attachments.length]);
  s.push(["Performance point rows", m.points.length]);
  s.push(["WEM records", m.wem.length]);
  s.push(["Survey answer rows", m.surveys.length]);
  s.push(["Billing references", m.billing.length]);
  s.push(["Analytics receipts", `${m.receiptTotal} across ${m.receipts.size} topics`]);
  s.push(["", ""]);
  if (omitted.length) s.push(["Sheets left out (nothing to show)", omitted.join(", ")]);
  if (m.unattributed.get("transcribed")) s.push(["Transcript acknowledgements not attributed", `${m.unattributed.get("transcribed")} name a communication inside a conversation rather than the conversation, so they are not on the Conversations sheet; the count of transcribed conversations is therefore a floor, not a total.`]);
  if (m.emptyCategories.length) s.push(["Present but empty in the archive", [...new Set(m.emptyCategories)].join(", ")]);
  if (m.deployments.length) s.push(["Web Messenger deployments naming the subject as last editor", m.deployments.join("; ")]);
  for (const [prefix, u] of m.unknown) s.push([`Not recognised: ${prefix}!`, `${u.count} file(s); keys: ${u.keys}`]);
  for (const n of m.notes) s.push(["Note", n]);
  s.push(["", ""]);
  s.push(["About this workbook", "A rendering of the Genesys GDPR Access export, produced in the browser from the archive above. It is not a certified copy."]);
  s.push(["Calls", "Genesys exports call audio and, where it transcribed the call, an acknowledgement that it did. The transcript text is not in the archive and nothing here is transcribed. Conversation outlines are Genesys's own AI summary of a conversation (Speech & Text Analytics), for calls and messaging alike."]);
  s.push(["Receipts", "The analytics! files are acknowledgements that each analytics topic processed the request. They carry ids and timestamps, no content."]);
  s.push(["Conversations", "Built from those receipts: every conversation id they name, with the time of its first and last event and which Genesys services touched it. Genesys exports no participant, queue or wrap-up detail for a conversation; this index and the transcript, call and journey sheets are all the archive holds about one."]);
  s.push(["Other people's details", "Names and email addresses of counterparts are reproduced because they are the subject's correspondence. Phone numbers in message and email rows are withheld."]);
  s.push(["Email bodies", "Text bodies are reproduced. An email with only an HTML body is shown as text with the markup removed. Email records from the routing service carry headers only; the archive has no body for them."]);

  addStyledSheet(wb, [["Item", "Value"], ...s], "Summary");
  for (const [name, headers, rows] of pending) if (rows.length) addStyledSheet(wb, [headers, ...rows], name);
  return wb;
}

/**
 * Every audio file and attachment as one zip: `audio/<file>` and
 * `attachments/<conversation>/<file>`. Inline images repeat their names
 * (image001.png in every signature), so a clash within a folder gets a
 * counter. Stored, not deflated — Opus and images do not compress, and a
 * 30 MB archive should not spend ten seconds proving it.
 */
async function buildFilesZip(files, report) {
  const zip = new JSZip();
  const used = new Set();
  for (const f of files) {
    const dir = f.kind === "Call audio" ? "audio" : `attachments/${f.conversationId || "unknown"}`;
    let path = `${dir}/${f.fileName}`;
    for (let n = 2; used.has(path); n++) path = `${dir}/${f.fileName.replace(/(\.[^.]*)?$/, `_${n}$1`)}`;
    used.add(path);
    zip.file(path, await f.entry.async("uint8array"));
  }
  return zip.generateAsync(
    { type: "uint8array", compression: "STORE" },
    (meta) => report(`Packing… ${Math.round(meta.percent)}%`),
  );
}

function filesZipName(m) {
  return workbookName(m).replace(/\.xlsx$/, "_files.zip");
}

function workbookName(m) {
  const who = (m.subjectName || "subject").replace(/[^\p{L}\p{N}.-]+/gu, "_");
  const req = m.requestId ? m.requestId.slice(0, 8) : "export";
  return `GDPR_Access_${who}_${req}.xlsx`;
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

async function readJson(entry) {
  const t = await entry.async("string");
  return t.trim() ? JSON.parse(t) : null;
}

function asArray(v) { return Array.isArray(v) ? v : v == null ? [] : [v]; }

function isEmptyish(j) {
  if (j == null) return true;
  if (Array.isArray(j)) return j.length === 0;
  if (typeof j === "object") return Object.values(j).every(isEmptyish);
  return j === "";
}

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Flatten an object to [section, field, value] rows; nested objects dot their keys. */
function flatten(obj, section, prefix = "", out = []) {
  if (obj == null) return out;
  if (Array.isArray(obj)) {
    if (obj.every((v) => v == null || typeof v !== "object")) out.push([section, prefix, obj.join("; ")]);
    else obj.forEach((v, i) => flatten(v, section, prefix ? `${prefix}[${i}]` : `[${i}]`, out));
    return out;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) flatten(v, section, prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  out.push([section, prefix, String(obj)]);
  return out;
}

/** One line of `key: value; key: value` for a row whose shape is not known. */
function flatLine(r) {
  if (r == null || typeof r !== "object") return String(r ?? "");
  return flatten(r, "").map(([, k, v]) => `${k}: ${v}`).join("; ");
}

function addr(a) {
  if (!a) return "";
  if (typeof a === "string") return withholdPhone(a);
  const email = a.email || "";
  const name  = a.name && a.name !== email ? a.name : "";
  return name ? `${name} <${email}>` : email;
}

function withholdPhone(v) {
  return PHONE_RE.test(String(v)) ? "(phone number withheld)" : String(v);
}

/**
 * A message party for the From/To columns: a phone number is withheld, a
 * bare id is replaced by the participant's role (customer, agent, workflow)
 * because the id names nobody, and anything else — an email, a handle — is
 * kept as it is.
 */
function party(v, purpose) {
  const s = String(v ?? "").trim();
  if (!s) return purpose ? `(${purpose})` : "";
  if (PHONE_RE.test(s)) return "(phone number withheld)";
  if (ID_RE.test(s)) return purpose ? `(${purpose})` : "";
  return s;
}

function emailBody(j) {
  const t = (j?.textBody || "").trim();
  if (t) return t;
  const h = j?.htmlBody || "";
  if (!h) return "";
  return h
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normaliseTime(v) {
  if (v == null || v === "") return "";
  if (typeof v === "number") return epochToIso(v);
  const s = String(v);
  return s.replace(/\.(\d{3})\+0000$/, ".$1Z").replace(/\+0000$/, "Z");
}

function epochToIso(ms) {
  if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return "";
  try { return new Date(ms).toISOString(); } catch { return ""; }
}

/**
 * Duration of an Ogg Opus file from its last page's granule position
 * (48 kHz sample clock), less the pre-skip declared in OpusHead. No
 * decoding; the container is read, not the codec.
 */
function oggDurationSeconds(bytes) {
  const n = bytes.length;
  let i = n - 27;
  while (i >= 0 && !(bytes[i] === 0x4f && bytes[i + 1] === 0x67 && bytes[i + 2] === 0x67 && bytes[i + 3] === 0x53)) i--;
  if (i < 0) return "";
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const granule = Number(dv.getBigInt64(i + 6, true));
  let preSkip = 0;
  // "OpusHead" sits in the first page; pre-skip is the uint16 after version+channels.
  for (let k = 0; k < Math.min(n - 12, 200); k++) {
    if (bytes[k] === 0x4f && bytes[k + 1] === 0x70 && bytes[k + 2] === 0x75 && bytes[k + 3] === 0x73
      && bytes[k + 4] === 0x48 && bytes[k + 5] === 0x65 && bytes[k + 6] === 0x61 && bytes[k + 7] === 0x64) {
      preSkip = dv.getUint16(k + 10, true);
      break;
    }
  }
  const sec = (granule - preSkip) / 48000;
  return sec > 0 ? sec : "";
}

function fmtDuration(sec) {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${mm}:${String(ss).padStart(2, "0")}`;
}

function fmtSize(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
