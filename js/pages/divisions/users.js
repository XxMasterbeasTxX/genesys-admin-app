import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  let currentStatus = "active";

  return renderDivisionPage(ctx, {
    objectType : "USER",
    label      : "Users",

    extraFilters: `
      <div class="di-control-group">
        <label class="di-label">Status</label>
        <select class="input dv-filter-select" id="dvUserStatus">
          <option value="active" selected>Active</option>
          <option value="inactive">Inactive</option>
          <option value="both">Both</option>
        </select>
      </div>`,

    onExtraFilterSetup: (el) => {
      el.querySelector("#dvUserStatus").addEventListener("change", e => {
        currentStatus = e.target.value;
      });
    },

    fetchFn: async (api, orgId, opts) => {
      if (currentStatus === "both") {
        const [active, inactive] = await Promise.all([
          gc.fetchAllUsers(api, orgId, { state: "active" }),
          gc.fetchAllUsers(api, orgId, { state: "inactive" }),
        ]);
        return [...active, ...inactive];
      }
      return gc.fetchAllUsers(api, orgId, { state: currentStatus, ...opts });
    },

    searchFn: (item, q) =>
      (item.name  || "").toLowerCase().includes(q) ||
      (item.email || "").toLowerCase().includes(q),

    columns: [
      { header: "Name",       get: i => i.name       || "—" },
      { header: "Email",      get: i => i.email      || "—" },
      { header: "Department", get: i => i.department || "—" },
      { header: "Status",     get: i => i.state === "inactive" ? "Inactive" : "Active" },
    ],
  });
}
