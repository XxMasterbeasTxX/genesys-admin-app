/**
 * STA License tab.
 *
 * The analysis lives in [`addonLicense.js`](./addonLicense.js), shared with the
 * WEM tab; this file is the STA descriptor and nothing else.
 *
 * Measured against three live orgs on 2026-09-04 — 3C Retail (CX2 with a WEM
 * trial), Milestone (CX2, no trial) and Demo (CX3):
 *
 *   gcSTAupgrade carries 23 permissions, identical on both CX2 orgs, and is
 *   absent on CX3. Genesys documents why: speech and text analytics is included
 *   in the CX1/CX2 WEM add-ons and in the CX3 licence.
 *
 *   19 of those 23 are also in gc2WEMupgrade — every speechAndTextAnalytics:*
 *   permission. Only four are STA's alone: billing:user:staUpgrade and
 *   routing:transcriptionSettings:{view,add,edit}.
 *
 * Genesys gives each user one add-on and WEM outranks STA, so on an org holding
 * both, users who look like STA triggers are assigned WEM. That does NOT need
 * handling here: POST /api/v2/license/infer applies the precedence itself. The
 * same role — `Speech and Text Analytics Admin`, 3 STA-only permissions and 25
 * shared — infers gc2WEMupgrade on 3C Retail and gcSTAupgrade on Milestone, the
 * only difference being whether WEM is holdable. So this tab sees only users
 * STA actually covers, and `supersededBy` exists purely to explain the empty
 * result rather than to reclassify anyone.
 */

import { renderAddonContent } from "./addonLicense.js";

const STA = {
  name: "STA",
  longName: "Speech and Text Analytics",

  // Matches gcSTAupgrade, and a gc1STAupgrade/gc2STAupgrade pair if Genesys
  // ever ships one. NOT /sta\b/i — the id continues into "upgrade", so a word
  // boundary matches nothing and the tab would report "no STA add-on for this
  // org", which is indistinguishable on screen from a true negative. Plain
  // /sta/i would match, but it is tested against `description` too, where any
  // "standard" or "status" would be a false positive.
  hint: /STAupgrade|speech\s*(and|&)?\s*text/i,

  // CX3 and above bundle STA into the base licence, exactly as they do WEM.
  bundledFromTier: 3,

  // Explains an empty result on an org that also holds WEM; see the note above.
  supersededBy: /wem|workforce\s*engagement/i,

  domPrefix: "sta",
  filePrefix: "STA_License",
};

export function renderStaContent(container, ctx) {
  return renderAddonContent(container, ctx, STA);
}
