[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host "[step] $Message"
}

function Write-Info {
  param([string]$Message)
  Write-Host "[info] $Message"
}

function Write-Ok {
  param([string]$Message)
  Write-Host "[ok] $Message" -ForegroundColor Green
}

function Write-Fail {
  param([string]$Message)
  Write-Host "[error] $Message" -ForegroundColor Red
}

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @(),
    [string]$FailureMessage = "Command failed."
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw $FailureMessage
  }
}

try {
  $mode = if ($args.Count -gt 0 -and $args[0]) { $args[0] } else { "start" }
  $loopRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
  $configPath = Join-Path $loopRoot "config.json"
  $localConfigPath = Join-Path $loopRoot "config.local.json"

  if (-not (Test-Path $configPath)) {
    throw "Missing codex-loop config.json in the tool root."
  }

  $config = Get-Content -Raw -Encoding UTF8 $configPath | ConvertFrom-Json
  $localConfig = if (Test-Path $localConfigPath) {
    Get-Content -Raw -Encoding UTF8 $localConfigPath | ConvertFrom-Json
  } else {
    $null
  }
  $workspaceRoot = if ($env:CODEX_LOOP_WORKSPACE_ROOT) {
    $env:CODEX_LOOP_WORKSPACE_ROOT
  } elseif ($localConfig -and $localConfig.workspaceRoot) {
    $localConfig.workspaceRoot
  } elseif ($config.workspaceRoot) {
    $config.workspaceRoot
  } else {
    throw "workspaceRoot is required in config.local.json or CODEX_LOOP_WORKSPACE_ROOT."
  }

  $workspaceRoot = (Resolve-Path $workspaceRoot).Path
  $hostName = if ($env:CODEX_LOOP_HOST) { $env:CODEX_LOOP_HOST } else { "127.0.0.1" }
  $webPort = if ($env:CODEX_LOOP_WEB_PORT) { $env:CODEX_LOOP_WEB_PORT } else { "3001" }

  $Host.UI.RawUI.WindowTitle = "codex-loop launcher"

  Write-Info "Tool root: $loopRoot"
  Write-Info "Workspace: $workspaceRoot"

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "node was not found in PATH."
  }

  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm was not found in PATH."
  }

  if (-not (Test-Path (Join-Path $loopRoot "node_modules"))) {
    Write-Step "Installing codex-loop dependencies..."
    Invoke-CheckedCommand -FilePath "npm" -Arguments @("--prefix", $loopRoot, "install") -FailureMessage "Failed to install codex-loop dependencies."
  } else {
    Write-Step "codex-loop dependencies detected."
  }

  Write-Step "Running environment check..."
  Invoke-CheckedCommand -FilePath "npm" -Arguments @("--prefix", $loopRoot, "run", "loop:check") -FailureMessage "codex-loop environment check failed."

  if ($mode -ieq "check") {
    Write-Ok "Environment check passed."
    exit 0
  }

  Write-Step "Initializing loop runtime..."
  Invoke-CheckedCommand -FilePath "npm" -Arguments @("--prefix", $loopRoot, "run", "loop:init") -FailureMessage "Loop initialization failed."

  Write-Info "Expected console URL: http://${hostName}:$webPort"
  Write-Info "Use one persistent Codex thread for this loop."
  Write-Info "Read these first in the target workspace:"
  Write-Host "        1. OPENCOW_CORE_RULES.md"
  Write-Host "        2. docs\v1.0"
  Write-Host "        3. 开发进度清单2026.6.6-22-48.md"
  Write-Step "Opening codex-loop console window..."

  $command = "chcp 65001>nul && cd /d `"$loopRoot`" && npm run dev"
  Start-Process -FilePath "cmd.exe" -ArgumentList "/k", $command -WorkingDirectory $loopRoot

  Write-Ok "codex-loop launch requested."
  Write-Info "If the browser does not open automatically, visit http://${hostName}:$webPort manually."
  exit 0
} catch {
  Write-Fail $_.Exception.Message
  Write-Info "Run start-codex-loop.bat check for detailed diagnostics."
  exit 1
}
