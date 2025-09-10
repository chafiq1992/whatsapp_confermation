# Requires: gcloud CLI installed and authenticated
# Usage:
#   ./scripts/export_cloud_run_env.ps1 -ProjectId <PROJECT_ID> -Region <REGION> -Service <SERVICE_NAME>
# It will create/update a .env.local-cloudrun file at repo root with the Cloud Run env vars.

param(
    [Parameter(Mandatory=$true)][string]$ProjectId,
    [Parameter(Mandatory=$true)][string]$Region,
    [Parameter(Mandatory=$true)][string]$Service
)

$ErrorActionPreference = "Stop"

Write-Host "Reading env vars from Cloud Run service '$Service' in $ProjectId/$Region..."

$describe = gcloud run services describe $Service --region $Region --project $ProjectId --format json | ConvertFrom-Json

if (-not $describe) {
    throw "Failed to read Cloud Run service description."
}

# Collect env from template and latest revision (if present)
$envList = @()
if ($describe.spec.template.spec.containers[0].env) {
    $envList += $describe.spec.template.spec.containers[0].env
}
if ($describe.status.template.spec.containers[0].env) {
    $envList += $describe.status.template.spec.containers[0].env
}

# Deduplicate by name, prefer later entries
$envMap = @{}
foreach ($e in $envList) {
    if ($e.name -and $e.value) {
        $envMap[$e.name] = $e.value
    }
}

# Write to .env.local-cloudrun at repo root
$repoRoot = Split-Path -Parent $PSScriptRoot
$outPath = Join-Path $repoRoot ".env.local-cloudrun"

Write-Host "Writing $($envMap.Keys.Count) keys to $outPath"

$lines = @()
$lines += "# Generated from Cloud Run ($ProjectId/$Region/$Service) on $(Get-Date -Format o)"
foreach ($key in $envMap.Keys | Sort-Object) {
    $val = $envMap[$key]
    # Normalize newlines to literal \n for dotenv
    $val = $val -replace "`r`n",'\n' -replace "`n",'\n' -replace "`r",'\n'
    # Escape double quotes
    $val = $val -replace '"','\"'
    # Quote only if contains spaces, #, or =
    if ($val -match '[\s#=]') {
        $lines += "$key=""$val"""
    } else {
        $lines += "$key=$val"
    }
}

Set-Content -Path $outPath -Value ($lines -join "`n") -Encoding UTF8

Write-Host "Done. Created $outPath"
Write-Host "Use it locally with:"
Write-Host "  docker compose --env-file $([IO.Path]::GetFileName($outPath)) up --build"
Write-Host "Or run backend directly:"
Write-Host "  set -a; source $([IO.Path]::GetFileName($outPath)); set +a  # (in bash). In PowerShell, use:"
Write-Host "  Get-Content $([IO.Path]::GetFileName($outPath)) | foreach { if ($_ -match '^(.*?)=(.*)$') { [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2]) } }"


