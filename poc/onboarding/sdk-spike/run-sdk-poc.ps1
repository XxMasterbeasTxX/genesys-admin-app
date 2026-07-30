<#
.SYNOPSIS
  Onboarding POC (SDK engine) — export one flow from the DEMO org, strip the
  "Template - " prefix + set division, and publish it into a CUSTOMER org, using
  the Genesys Flow Scripting SDK. No Archy, no CLI.

.DESCRIPTION
  Pipeline:  sdk-export.js (demo)  →  ../transform.js  →  sdk-publish.js (customer)

  Each SDK step is its own Node process because a Scripting session authenticates
  to a single org. This mirrors the production background runner.

  Credentials live in JSON options files (copy the *.example.json templates and
  fill in real client-credentials). Never commit the real files.

  DEPENDENCY ORDER: publish binds references by name, so deploy leaves first:
    data tables + data actions (REST, existing app pages)  →  common modules
    →  in-queue flow  →  main callflow. Run this harness per asset in that order.

.EXAMPLE
  ./run-sdk-poc.ps1 -FlowName "Template - Inbound Voice" -FlowType inboundcall `
                    -Division "Home" `
                    -DemoOptions ./options.demo.json `
                    -CustomerOptions ./options.customer.json
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

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "node not found on PATH." }
foreach ($f in @($DemoOptions, $CustomerOptions)) {
  if (-not (Test-Path -LiteralPath $f)) { throw "Options file not found: $f (copy the *.example.json template and fill it in)." }
}

$exportDir = Join-Path $WorkDir "export"
if (Test-Path -LiteralPath $exportDir) { Remove-Item -LiteralPath $exportDir -Recurse -Force }
New-Item -ItemType Directory -Path $exportDir -Force | Out-Null

Write-Host "== Onboarding POC (SDK engine) ==" -ForegroundColor Cyan

# ── 1. Export from DEMO ─────────────────────────────────────────────────────────
Write-Host "`n[1/3] Export '$FlowName' ($FlowType) from demo org…" -ForegroundColor Yellow
node "$PSScriptRoot/sdk-export.js" --options $DemoOptions --flowName $FlowName --flowType $FlowType --outDir $exportDir
if ($LASTEXITCODE -ne 0) { throw "sdk-export.js failed (exit $LASTEXITCODE)." }

$exported = Get-ChildItem -LiteralPath $exportDir -Filter *.yaml |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $exported) { throw "No YAML produced in $exportDir." }
Write-Host "      exported → $($exported.Name)"

# ── 2. Transform ───────────────────────────────────────────────────────────────
Write-Host "`n[2/3] Transform (strip 'Template - ', division → '$Division')…" -ForegroundColor Yellow
$transformed = Join-Path $WorkDir ("publish-" + $exported.Name)
node "$PSScriptRoot/../transform.js" $exported.FullName --out $transformed --division $Division
if ($LASTEXITCODE -ne 0) { throw "transform.js failed (exit $LASTEXITCODE)." }

# ── 3. Publish to CUSTOMER ─────────────────────────────────────────────────────
if ($SkipPublish) {
  Write-Host "`n[3/3] -SkipPublish set — review → $transformed" -ForegroundColor Yellow
  return
}
Write-Host "`n[3/3] Import + publish into customer org…" -ForegroundColor Yellow
node "$PSScriptRoot/sdk-publish.js" --options $CustomerOptions --file $transformed
if ($LASTEXITCODE -ne 0) { throw "sdk-publish.js failed (exit $LASTEXITCODE). If it names a missing dependency, deploy that first (see README dependency order)." }

Write-Host "`n✓ Done — '$FlowName' published as its stripped name into the customer org." -ForegroundColor Green
