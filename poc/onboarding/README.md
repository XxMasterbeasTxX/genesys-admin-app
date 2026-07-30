# Onboarding Deployment — POC

Proves the engine for the Onboarding Deployment feature (see
[../../docs/onboarding-deployment-design.md](../../docs/onboarding-deployment-design.md)):

```
export (demo)  →  transform.js (strip "Template - " + set division)  →  publish (customer)
```

Because every Architect reference is by **name** (common modules, data tables,
data actions, in-queue flow), stripping the shared `Template - ` prefix rewrites
all references at once. The published flow then binds to the renamed customer-org
objects automatically.

## Engine: Flow Scripting SDK (no Archy)

The shipped engine is the **Genesys Flow Scripting SDK**
(`purecloud-flow-scripting-api-sdk-javascript`) — an npm package (Node 20+), the
same engine Archy is built on, but **no CLI, no binary, no container**. Introspection
confirmed it can load a live flow, export it to YAML, import YAML, and publish:
`loadFlowByFlowNameAsync` → `exportToObjectAsync('yaml')` → transform → create
matching flow + `importFromContentAsync` → `validateAsync` → `publishAsync`.

The SDK spike lives in [`sdk-spike/`](sdk-spike). A Scripting session is one org,
so export (demo) and publish (customer) run as two processes — matching the
production background runner. **The SDK is published as Alpha; pin the version.**
The Archy harness (below) is kept only as a fallback.

```powershell
cd sdk-spike
npm install
Copy-Item options.demo.example.json     options.demo.json      # fill in demo creds
Copy-Item options.customer.example.json options.customer.json  # fill in customer creds
# deploy dependencies first (see order below), then:
./run-sdk-poc.ps1 -FlowName "Template - Inbound Voice" -FlowType inboundcall `
                  -Division "Home" `
                  -DemoOptions ./options.demo.json -CustomerOptions ./options.customer.json
```

## What's here

| File | Purpose |
|---|---|
| `deps.js` | Dependency resolver: parses a callflow YAML and auto-discovers referenced common modules, in-queue flows, data tables, and data actions. Exposes `resolveDeps(yaml)` for recursive (transitive) resolution. **Validated** against a real export. |
| `transform.js` | Dependency-free Node transform: strips the prefix, sets the flow division, reports renames + warnings. **Already validated** against a real export. |
| `sdk-spike/` | **Primary engine.** Flow Scripting SDK export/publish scripts + harness (`sdk-export.js`, `sdk-publish.js`, `run-sdk-poc.ps1`). |
| `run-poc.ps1` | **Fallback engine.** Archy CLI harness: export → transform → publish, one asset at a time. |
| `options.*.example.yaml` | Templates for Archy credentials (copy → fill → don't commit). |

## Auto-discover dependencies from a callflow (no creds needed)

```powershell
node deps.js "C:\path\to\Template - Inbound Voice_v1-0.yaml"        # human-readable
node deps.js "C:\path\to\Template - Inbound Voice_v1-0.yaml" --json # machine-readable
```

The real feature recurses: it exports each discovered common module / in-queue
flow and re-runs the resolver on it, so nested dependencies are caught too.

### Full transitive closure over a folder of exports

Point `--recurse` at a folder of exported YAMLs. It indexes them by flow name,
walks the closure from the callflows (or specify `--root`), prints the full
deploy order (dependencies first, topologically sorted so a module used by
another module publishes first), and lists any referenced flow whose YAML is not
in the folder yet — i.e. what still needs exporting.

```powershell
node deps.js --recurse .\work\exported                       # roots = all callflows found
node deps.js --recurse .\work\exported --root "Template - Inbound Voice"
node deps.js --recurse .\work\exported --json                # machine-readable closure
```

Iterate: export the flagged flows into the same folder and re-run until it
reports "Closure complete."

## Prerequisites

1. **Node** (already used by this repo).
2. **Archy** installed and on PATH — https://developer.genesys.cloud/devapps/archy/install
3. An **OAuth client-credentials** grant in **each** org (demo + customer) with
   Architect + integration scopes. These are the same kind of credentials the app
   already stores per org.

## One-time setup

```powershell
cd poc/onboarding
Copy-Item options.demo.example.yaml     options.demo.yaml
Copy-Item options.customer.example.yaml options.customer.yaml
# edit both: set clientId / clientSecret / location (region) for each org
```

`location` is the Archy region id (e.g. `prod_eu_west_1` for mypurecloud.ie). If
unsure, run `archy dump` or check the Archy docs for the region matching each org.

## Run — transform only (no creds needed)

Validate the rewrite against any exported YAML without touching an org:

```powershell
node transform.js "C:\path\to\Template - Inbound Voice_v1-0.yaml" `
     --out ".\work\Inbound Voice.yaml" --division "Home"
```

## Run — full export → transform → publish

Publish binds references by name, so **deploy dependencies first**, in this order:

1. **Data tables + data actions** — create these in the customer org first
   (rename by dropping `Template - `). For the POC you can create them by hand, or
   use the app's existing *Data Tables › Copy - Between Orgs* and
   *Data Actions › Copy - Between Orgs* pages. (The real feature automates this.)
2. **Common modules:**
   ```powershell
   ./run-poc.ps1 -FlowName "Template - CM - Play and Collect Digits" -FlowType commonmodule -Division "Home" -DemoOptions ./options.demo.yaml -CustomerOptions ./options.customer.yaml
   # repeat for: CM - Scheduled Phrases, CM - Check - No Agents, CM - Overflow
   ```
3. **In-queue flow:**
   ```powershell
   ./run-poc.ps1 -FlowName "Template - In Queue" -FlowType inqueuecall -Division "Home" -DemoOptions ./options.demo.yaml -CustomerOptions ./options.customer.yaml
   ```
4. **Main callflow:**
   ```powershell
   ./run-poc.ps1 -FlowName "Template - Inbound Voice" -FlowType inboundcall -Division "Home" -DemoOptions ./options.demo.yaml -CustomerOptions ./options.customer.yaml
   ```

Add `-SkipPublish` to stop after the transform and inspect the YAML that *would*
be published (`work/publish-*.yaml`).

## Success criteria

- Each publish returns exit code 0.
- The main callflow publishes without "unresolved reference" errors — meaning all
  common modules, data tables, the data action, and the in-queue flow bound by
  name in the customer org.
- Opening the flow in the customer org's Architect shows the references pointing
  at the customer's (un-prefixed) objects.

## Known POC limitations (handled in the real feature, see design)

- Dependencies (tables/actions/modules) are deployed manually here; the feature
  automates the ordered pipeline.
- Hardcoded demo literals (e.g. a default queue `TDCerhverv_test`) and dynamic
  user prompts are surfaced as warnings, not rewritten.
- Division must already exist in the customer org (it's chosen from the live list
  in the real UI).
