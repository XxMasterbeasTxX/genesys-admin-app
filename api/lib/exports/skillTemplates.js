/**
 * Export Handler — Skill/Role/Queue Templates
 *
 * Reads templates and assignments from Azure Table Storage and produces
 * a 6-sheet Excel workbook: Overview, Roles, Skills, Languages, Queues, Members.
 */

const XLSX = require("xlsx-js-style");
const { buildStyledWorkbook, addStyledSheet } = require("../excelStyles");
const templateStore = require("../templateStore");
const assignmentStore = require("../templateAssignmentStore");

function timestampedFilename(prefix, ext) {
  const d = new Date();
  const ts = d.toISOString().replace(/[:T]/g, "-").slice(0, 19);
  return `${prefix}_${ts}.${ext}`;
}

// ── Core export logic ───────────────────────────────────

async function execute(context, schedule) {
  const config = schedule?.exportConfig || {};
  const orgId = config.orgId;

  if (!orgId) {
    return { success: false, error: "No orgId specified in export config" };
  }

  const selectedNames = config.templates || [];

  context.log(`Skill Templates export for org ${orgId}`);

  try {
    // Fetch templates and assignments
    const [allTemplates, allAssignments] = await Promise.all([
      templateStore.listByOrg(orgId),
      assignmentStore.listByOrg(orgId),
    ]);

    // Filter to selected templates (if specified)
    const templates = selectedNames.length
      ? allTemplates.filter(t => selectedNames.includes(t.name))
      : allTemplates;

    if (!templates.length) {
      return { success: false, error: "No matching templates found" };
    }

    templates.sort((a, b) =>
      (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" })
    );

    // Build assignment lookup
    const templateIds = new Set(templates.map(t => t.id));
    const assignMap = new Map();
    for (const a of allAssignments) {
      if (!templateIds.has(a.templateId)) continue;
      if (!assignMap.has(a.templateId)) assignMap.set(a.templateId, []);
      assignMap.get(a.templateId).push(a);
    }

    context.log(`Processing ${templates.length} templates, ${allAssignments.length} total assignments`);

    // Sheet 1: Overview
    const overviewData = [["Template", "Roles", "Skills", "Languages", "Queues", "Users", "Groups", "Teams"]];
    for (const t of templates) {
      const assigns = assignMap.get(t.id) || [];
      const users  = assigns.filter(a => !a.type || a.type === "user").length;
      const groups = assigns.filter(a => a.type === "group").length;
      const teams  = assigns.filter(a => a.type === "workteam").length;
      overviewData.push([
        t.name,
        (t.roles || []).length,
        (t.skills || []).length,
        (t.languages || []).length,
        (t.queues || []).length,
        users,
        groups,
        teams,
      ]);
    }

    // Sheet 2: Roles (one row per role × division)
    const rolesData = [["Template", "Role", "Division"]];
    for (const t of templates) {
      for (const r of (t.roles || [])) {
        const roleName = r.roleName || r.name || String(r);
        const divs = r.divisions || [];
        if (divs.length) {
          for (const d of divs) {
            rolesData.push([t.name, roleName, d.divisionName || d.name || String(d)]);
          }
        } else {
          rolesData.push([t.name, roleName, ""]);
        }
      }
    }

    // Sheet 3: Skills
    const skillsData = [["Template", "Skill", "Proficiency"]];
    for (const t of templates) {
      for (const s of (t.skills || [])) {
        skillsData.push([t.name, s.skillName || s.name || String(s), s.proficiency ?? ""]);
      }
    }

    // Sheet 4: Languages
    const langsData = [["Template", "Language", "Proficiency"]];
    for (const t of templates) {
      for (const l of (t.languages || [])) {
        langsData.push([t.name, l.languageName || l.name || String(l), l.proficiency ?? ""]);
      }
    }

    // Sheet 5: Queues
    const queuesData = [["Template", "Queue"]];
    for (const t of templates) {
      for (const q of (t.queues || [])) {
        queuesData.push([t.name, q.queueName || q.name || String(q)]);
      }
    }

    // Sheet 6: Members
    const membersData = [["Template", "Type", "Name", "Assigned By"]];
    for (const t of templates) {
      for (const a of (assignMap.get(t.id) || [])) {
        const type = a.type || "user";
        const label = type === "group" ? "Group" : type === "workteam" ? "Work Team" : "User";
        const name  = type === "group" ? (a.groupName || a.groupId)
                    : type === "workteam" ? (a.workteamName || a.workteamId)
                    : (a.userName || a.userId);
        membersData.push([t.name, label, name, a.assignedBy || ""]);
      }
    }

    // Build multi-sheet workbook
    const wb = buildStyledWorkbook(overviewData, "Overview");
    addStyledSheet(wb, rolesData, "Roles");
    addStyledSheet(wb, skillsData, "Skills");
    addStyledSheet(wb, langsData, "Languages");
    addStyledSheet(wb, queuesData, "Queues");
    addStyledSheet(wb, membersData, "Members");

    const buf = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
    const base64 = Buffer.from(buf).toString("base64");
    const filename = timestampedFilename("SkillTemplates", "xlsx");

    const allAssigns = templates.flatMap(t => assignMap.get(t.id) || []);
    const uCt = allAssigns.filter(a => !a.type || a.type === "user").length;
    const gCt = allAssigns.filter(a => a.type === "group").length;
    const tCt = allAssigns.filter(a => a.type === "workteam").length;
    const summary = `${templates.length} template(s), ${uCt} user(s), ${gCt} group(s), ${tCt} team(s)`;

    return {
      success: true,
      filename,
      base64,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      summary,
    };
  } catch (err) {
    context.log.error(`Skill Templates export error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { execute };
