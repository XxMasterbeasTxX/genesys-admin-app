<#
.SYNOPSIS
  Onboarding POC harness — export one Architect asset from the DEMO org, strip the
  "Template - " prefix (rewriting all name-based references), and publish it into a
  CUSTOMER org via Archy.

.DESCRIPTION
  Proves the end-to-end engine for the Onboarding Deployment feature:
      archy export (demo)  →  transform.js  →  archy publish (customer)

  Credentials are supplied through Archy *options files* (YAML holding clientId /
  clientSecret / location) so no secrets appear on the command line or in git.
  Copy the *.example.yaml templates, fill in real client-credentials, and pass
  them with -DemoOptions / -CustomerOptions.

  DEPENDENCY ORDER: Architect publish binds references by name at publish time, so
  a flow's dependencies must already exist in the customer org. Run this harness
  for the leaf dependencies first, then the flows that use them:
      1. data tables + data actions   (create these first — see README)
      2. common modules   (-FlowType commonmodule)
      3. in-queue flow    (-FlowType inqueuecall)
      4. main callflow    (-FlowType inboundcall)

.PARAMETER FlowName
  The asset name in the DEMO org, including the "Template - " prefix.
  e.g. "Template - Inbound Voice"

.PARAMETER FlowType
  Archy flow type: inboundcall | inqueuecall | commonmodule | inboundchat |
  inboundemail | inboundshortmessage | workflow | bot ...

.PARAMETER Division
  Target division name in the CUSTOMER org (applied to the published flow).

.PARAMETER DemoOptions
  Path to the Archy options file with the DEMO org client-credentials + location.

.PARAMETER CustomerOptions
  Path to the Archy options file with the CUSTOMER org client-credentials + location.

.PARAMETER WorkDir
  Scratch directory for exported + transformed YAML. Defaults to ./work.

.EXAMPLE
  ./run-poc.ps1 -FlowName "Template - Inbound Voice" -FlowType inboundcall `
                -Division "Home" `
                -DemoOptions ./options.demo.yaml `
                -CustomerOptions ./options.customer.yaml
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$FlowName,
  [Parameter(Mandatory = $true)][string]$FlowType,
  [Parameter(Mandatory = $true)][string]$Division,
  [Parameter(Mandatory = $true)][string]$DemoOptions,
  [Parameter(Mandatory = $true)][string]$CustomerOptions,
  [string]$WorkDir = "$PSScriptRoot/work",
  [switch]$SkipPublish
)

$ErrorActionPreference = "Stop"

function Require-Command($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Required command '$name' not found on PATH. Install it and retry."
  }
}

function Require-File($path, $hint) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "File not found: $path`n$hint"
  }
}

Write-Host "== Onboarding POC ==" -ForegroundColor Cyan
Require-Command "archy"
Require-Command "node"
Require-File $DemoOptions     "Copy options.demo.example.yaml → fill in DEMO client-credentials."
Require-File $CustomerOptions "Copy options.customer.example.yaml → fill in CUSTOMER client-credentials."

# Fresh, isolated export dir so we can reliably pick up the produced YAML.
$exportDir = Join-Path $WorkDir "export"
if (Test-Path -LiteralPath $exportDir) { Remove-Item -LiteralPath $exportDir -Recurse -Force }
New-Item -ItemType Directory -Path $exportDir -Force | Out-Null

# ── 1. Export from the DEMO org ─────────────────────────────────────────────────
Write-Host "`n[1/3] Exporting '$FlowName' ($FlowType) from demo org…" -ForegroundColor Yellow
& archy export `
  --optionsFile $DemoOptions `
  --flowName $FlowName `
  --flowType $FlowType `
  --exportType yaml `
  --outputDir $exportDir `
  --overwriteFile true
if ($LASTEXITCODE -ne 0) { throw "archy export failed (exit $LASTEXITCODE)." }

$exported = Get-ChildItem -LiteralPath $exportDir -Filter *.yaml |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $exported) { throw "No YAML produced in $exportDir." }
Write-Host "      exported → $($exported.Name)"

# ── 2. Transform (strip prefix + set division) ─────────────────────────────────
Write-Host "`n[2/3] Transforming (strip 'Template - ', division → '$Division')…" -ForegroundColor Yellow
$transformed = Join-Path $WorkDir ("publish-" + $exported.Name)
& node "$PSScriptRoot/transform.js" $exported.FullName --out $transformed --division $Division
if ($LASTEXITCODE -ne 0) { throw "transform.js failed (exit $LASTEXITCODE)." }

# ── 3. Publish into the CUSTOMER org ───────────────────────────────────────────
if ($SkipPublish) {
  Write-Host "`n[3/3] -SkipPublish set — stopping before publish." -ForegroundColor Yellow
  Write-Host "      review → $transformed"
  return
}

Write-Host "`n[3/3] Publishing into customer org…" -ForegroundColor Yellow
& archy publish `
  --optionsFile $CustomerOptions `
  --file $transformed `
  --forceUnlock true
if ($LASTEXITCODE -ne 0) { throw "archy publish failed (exit $LASTEXITCODE). If it names a missing dependency (data table / data action / common module), deploy that first — see README dependency order." }

Write-Host "`n✓ Done. '$FlowName' published as its stripped name into the customer org." -ForegroundColor Green
