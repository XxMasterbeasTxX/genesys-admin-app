import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  let $typeSelect = null;

  return renderDivisionPage(ctx, {
    objectType : "FLOW",
    label      : "Flows",
    fetchFn    : (api, orgId, opts) => gc.fetchAllFlows(api, orgId, opts),
    columns    : [
      { header: "Name",  get: i => i.name  || "—" },
      { header: "Type",  get: i => i.type  || "—" },
    ],

    extraFilters: `
      <div class="di-control-group">
        <label class="di-label">Type</label>
        <select class="input dv-filter-select" id="dvFlowType">
          <option value="">(All types)</option>
        </select>
      </div>`,

    onExtraFilterSetup(el) {
      $typeSelect = el.querySelector("#dvFlowType");
      const $search = el.querySelector("#dvSearch");
      $typeSelect.addEventListener("change", () =>
        $search.dispatchEvent(new Event("input"))
      );
    },

    onItemsLoaded(items) {
      if (!$typeSelect) return;
      const types = [...new Set(items.map(i => i.type).filter(Boolean))].sort();
      const prev = $typeSelect.value;
      $typeSelect.innerHTML =
        `<option value="">(All types)</option>` +
        types.map(t => `<option value="${t}">${t}</option>`).join("");
      if (prev && types.includes(prev)) $typeSelect.value = prev;
    },

    extraFilterFn: (item) => {
      if (!$typeSelect?.value) return true;
      return (item.type || "") === $typeSelect.value;
    },
  });
}
