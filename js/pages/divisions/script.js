import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  let $statusSelect = null;

  return renderDivisionPage(ctx, {
    objectType : "SCRIPT",
    label      : "Scripts",
    fetchFn    : (api, orgId, opts) => gc.fetchAllScripts(api, orgId, opts),
    columns    : [
      { header: "Name",   get: i => i.name          || "—" },
      { header: "Status", get: i => i.publishedDate ? "Published" : "Draft" },
    ],

    extraFilters: `
      <div class="di-control-group">
        <label class="di-label">Status</label>
        <select class="input dv-filter-select" id="dvScriptStatus">
          <option value="">(All)</option>
          <option value="Published">Published</option>
          <option value="Draft">Draft</option>
        </select>
      </div>`,

    onExtraFilterSetup(el) {
      $statusSelect = el.querySelector("#dvScriptStatus");
      const $search = el.querySelector("#dvSearch");
      $statusSelect.addEventListener("change", () =>
        $search.dispatchEvent(new Event("input"))
      );
    },

    extraFilterFn: (item) => {
      if (!$statusSelect?.value) return true;
      const status = item.publishedDate ? "Published" : "Draft";
      return status === $statusSelect.value;
    },
  });
}
