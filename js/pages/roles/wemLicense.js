/**
 * WEM License tab.
 *
 * The analysis lives in [`addonLicense.js`](./addonLicense.js), which is shared
 * with the STA tab; this file is the WEM descriptor and nothing else. The two
 * add-ons ask the same question of the same three endpoints and differ only in
 * which licence definitions count, so a second copy of 900 lines would only
 * guarantee that the next fix landed in one of them.
 *
 * `renderWemContent` keeps its name and signature so search.js is unchanged.
 */

import { renderAddonContent } from "./addonLicense.js";

const WEM = {
  name: "WEM",
  longName: "Workforce Engagement Management",

  // Matches gc1WEMupgrade (CX1) and gc2WEMupgrade (CX2) by substring, and any
  // definition whose description spells the product out. Matched 2/2 on the
  // first live orgs. Note there is no `\b` after "wem" — the id continues into
  // "upgrade", so a word boundary would match nothing at all.
  hint: /wem|workforce\s*engagement/i,

  // CX3 and above bundle WEM into the base licence, so no separate SKU is
  // returned and its absence is the answer rather than a lookup failure.
  bundledFromTier: 3,

  // Unchanged from before the extraction: the element ids and export filenames
  // this tab produced are exactly what it produces now.
  domPrefix: "wem",
  filePrefix: "WEM_License",
};

export function renderWemContent(container, ctx) {
  return renderAddonContent(container, ctx, WEM);
}
