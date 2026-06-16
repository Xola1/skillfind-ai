param(
  [string]$MigrationDir,
  [int]$DebounceMilliseconds = 1200
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $MigrationDir) {
  $MigrationDir = Join-Path $RepoRoot "supabase\migrations"
}

New-Item -ItemType Directory -Force -Path $MigrationDir | Out-Null

if (-not $env:SUPABASE_ACCESS_TOKEN) {
  Write-Host "Missing SUPABASE_ACCESS_TOKEN. Set it before starting this watcher."
  exit 1
}

if (-not $env:SUPABASE_PROJECT_REF) {
  Write-Host "Missing SUPABASE_PROJECT_REF. Set it before starting this watcher."
  exit 1
}

function Convert-ToMigrationName {
  param([string]$Path)

  $baseName = [IO.Path]::GetFileNameWithoutExtension($Path)
  $safeBaseName = ($baseName -replace "[^a-zA-Z0-9_]+", "_").Trim("_")
  if (-not $safeBaseName) {
    $safeBaseName = "migration"
  }

  return "$(Get-Date -Format 'yyyyMMddHHmmss')_$safeBaseName"
}

function Invoke-SupabaseMigration {
  param([string]$Path)

  $fullPath = [IO.Path]::GetFullPath($Path)
  $migrationName = Convert-ToMigrationName -Path $fullPath

  Write-Host "Applying Supabase migration: $migrationName"
  Write-Host "Source SQL: $fullPath"

  $prompt = @"
Apply this Supabase SQL migration using the configured Supabase MCP server.

File: $fullPath
Migration name: $migrationName

Rules:
- Read the SQL from the file path above.
- Use only the Supabase MCP server named supabase.
- Call apply_migration with the migration name and the SQL contents.
- Do not modify project files.
- Report success or failure concisely.
"@

  $codexOutput = & codex exec --cd $RepoRoot --sandbox read-only --skip-git-repo-check --ephemeral $prompt 2>&1
  $codexExitCode = $LASTEXITCODE
  $codexText = $codexOutput -join "`n"
  Write-Host $codexText

  $codexFailed = $false
  if ($codexExitCode -ne 0) { $codexFailed = $true }
  if ($codexText -match "Failed to apply") { $codexFailed = $true }
  if ($codexText -match "MCP startup failed") { $codexFailed = $true }
  if ($codexText -match "timed out handshaking") { $codexFailed = $true }
  if ($codexText -match "no .*apply_migration.*tool") { $codexFailed = $true }

  if ($codexFailed) {
    Write-Host "Migration failed: $migrationName"
    return
  }

  Write-Host "Migration applied: $migrationName"
}

$watcher = New-Object IO.FileSystemWatcher $MigrationDir, "*.sql"
$watcher.IncludeSubdirectories = $false
$watcher.NotifyFilter = [IO.NotifyFilters]'FileName, LastWrite, Size'
$watcher.EnableRaisingEvents = $true

$pending = @{}
$lastHashes = @{}

$changed = Register-ObjectEvent $watcher Changed -SourceIdentifier SupabaseSqlChanged
$created = Register-ObjectEvent $watcher Created -SourceIdentifier SupabaseSqlCreated
$renamed = Register-ObjectEvent $watcher Renamed -SourceIdentifier SupabaseSqlRenamed

Write-Host "Watching Supabase SQL migrations: $MigrationDir"
Write-Host "Save .sql files in this folder to apply them through Codex + Supabase MCP."

try {
  while ($true) {
    $event = Wait-Event -Timeout 1
    while ($event) {
      $path = $event.SourceEventArgs.FullPath
      if ($path -and $path.EndsWith(".sql", [StringComparison]::OrdinalIgnoreCase)) {
        $pending[$path] = Get-Date
      }

      Remove-Event -EventIdentifier $event.EventIdentifier
      $event = Wait-Event -Timeout 0
    }

    $now = Get-Date
    $ready = @(
      $pending.Keys | Where-Object {
        (($now - $pending[$_]).TotalMilliseconds -ge $DebounceMilliseconds)
      }
    )

    foreach ($path in $ready) {
      $pending.Remove($path)

      if (-not (Test-Path -LiteralPath $path)) {
        continue
      }

      try {
        $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
        if ($lastHashes.ContainsKey($path) -and $lastHashes[$path] -eq $hash) {
          continue
        }

        $lastHashes[$path] = $hash
        Invoke-SupabaseMigration -Path $path
      } catch {
        Write-Host "Could not apply SQL file: $path"
        Write-Host $_.Exception.Message
      }
    }
  }
} finally {
  $watcher.EnableRaisingEvents = $false
  Unregister-Event -SourceIdentifier SupabaseSqlChanged -ErrorAction SilentlyContinue
  Unregister-Event -SourceIdentifier SupabaseSqlCreated -ErrorAction SilentlyContinue
  Unregister-Event -SourceIdentifier SupabaseSqlRenamed -ErrorAction SilentlyContinue
  $changed | Remove-Job -Force -ErrorAction SilentlyContinue
  $created | Remove-Job -Force -ErrorAction SilentlyContinue
  $renamed | Remove-Job -Force -ErrorAction SilentlyContinue
  $watcher.Dispose()
}
