[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host "[step] $Message" -ForegroundColor Cyan
}

function Write-Info {
  param([string]$Message)
  Write-Host "[info] $Message" -ForegroundColor DarkGray
}

function Write-Ok {
  param([string]$Message)
  Write-Host "[ok] $Message" -ForegroundColor Green
}

function Write-Fail {
  param([string]$Message)
  Write-Host "[error] $Message" -ForegroundColor Red
}

function Write-ProgressStep {
  param(
    [int]$Percent,
    [string]$Message
  )

  Write-Host ("[{0,3}%] {1}" -f $Percent, $Message) -ForegroundColor White
}

function Stop-ProcessTreeById {
  param([int]$ProcessId)

  if ($ProcessId -le 0 -or $ProcessId -eq $PID) {
    return
  }

  cmd /c "taskkill /PID $ProcessId /T /F >nul 2>nul" | Out-Null
}

function Read-LauncherStatus {
  param([Parameter(Mandatory = $true)][string]$LoopRoot)

  $statusPath = Join-Path $LoopRoot "settings\launcher-status.json"
  if (-not (Test-Path $statusPath)) {
    return $null
  }

  try {
    return Get-Content -Raw -Encoding UTF8 $statusPath | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Wait-LauncherReady {
  param(
    [Parameter(Mandatory = $true)][string]$LoopRoot,
    [int]$TimeoutSeconds = 25
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $status = Read-LauncherStatus -LoopRoot $LoopRoot
    if ($status -and $status.phase -eq "ready" -and $status.webUrl) {
      return $status
    }

    Start-Sleep -Milliseconds 500
  }

  return Read-LauncherStatus -LoopRoot $LoopRoot
}

function Get-PortOwnerIds {
  param([int[]]$Ports = @())

  $ownerIds = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($port in $Ports) {
    if ($port -le 0) {
      continue
    }

    try {
      $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
      foreach ($connection in $connections) {
        $null = $ownerIds.Add([int]$connection.OwningProcess)
      }
    } catch {
      continue
    }
  }

  return @($ownerIds)
}

function Get-CodexLoopProcessIds {
  param([Parameter(Mandatory = $true)][string]$LoopRoot)

  $ids = [System.Collections.Generic.HashSet[int]]::new()
  $escapedRoot = [Regex]::Escape($LoopRoot)
  $patterns = @(
    "scripts\\dev\.mjs",
    "app/server/index\.mjs",
    "app/web/vite\.config\.mjs",
    "app\\web\\vite\.config\.mjs"
  )

  try {
    $processes = Get-CimInstance Win32_Process -ErrorAction Stop
  } catch {
    return @()
  }

  foreach ($process in $processes) {
    $commandLine = [string]$process.CommandLine
    if (-not $commandLine) {
      continue
    }

    $processName = [string]$process.Name
    if ($processName -match "^(powershell|pwsh)(\.exe)?$") {
      continue
    }

    if ($commandLine -notmatch $escapedRoot) {
      continue
    }

    $matchesCodexLoop = $false
    foreach ($pattern in $patterns) {
      if ($commandLine -match $pattern) {
        $matchesCodexLoop = $true
        break
      }
    }

    if (-not $matchesCodexLoop) {
      continue
    }

    $numericId = [int]$process.ProcessId
    if ($numericId -gt 0 -and $numericId -ne $PID) {
      $null = $ids.Add($numericId)
    }
  }

  return @($ids)
}

function Normalize-PortNumber {
  param(
    [Parameter(ValueFromPipeline = $true)]
    $Value,
    [int]$Fallback
  )

  $numeric = 0
  if ([int]::TryParse([string]$Value, [ref]$numeric) -and $numeric -gt 0) {
    return $numeric
  }

  return $Fallback
}

function Get-StartupCandidatePorts {
  param([Parameter(Mandatory = $true)][string]$LoopRoot)

  $status = Read-LauncherStatus -LoopRoot $LoopRoot
  $ports = [System.Collections.Generic.HashSet[int]]::new()
  $preferredApiPort = Normalize-PortNumber -Value $env:CODEX_LOOP_PORT -Fallback 3000
  $preferredWebPort = Normalize-PortNumber -Value $env:CODEX_LOOP_WEB_PORT -Fallback 3001

  foreach ($candidate in @(
      $preferredApiPort,
      $preferredWebPort,
      $status.apiPort,
      $status.webPort
    )) {
    $numeric = Normalize-PortNumber -Value $candidate -Fallback 0
    if ($numeric -gt 0) {
      $null = $ports.Add($numeric)
    }
  }

  return @($ports)
}

function Wait-PortsReleased {
  param(
    [int[]]$Ports = @(),
    [int]$TimeoutSeconds = 8
  )

  if (-not $Ports.Count) {
    return
  }

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $remaining = Get-PortOwnerIds -Ports $Ports
    if (-not $remaining.Count) {
      return
    }

    Start-Sleep -Milliseconds 400
  } while ((Get-Date) -lt $deadline)
}

function Stop-ExistingLoopProcesses {
  param(
    [Parameter(Mandatory = $true)][string]$LoopRoot,
    [int[]]$Ports = @()
  )

  $ids = [System.Collections.Generic.HashSet[int]]::new()
  $status = Read-LauncherStatus -LoopRoot $LoopRoot
  if ($status) {
    foreach ($candidateId in @($status.launcherPid, $status.serverPid, $status.webPid)) {
      $numericId = [int]($candidateId | ForEach-Object { $_ })
      if ($numericId -gt 0 -and $numericId -ne $PID) {
        $null = $ids.Add($numericId)
      }
    }
  }

  foreach ($ownerId in Get-PortOwnerIds -Ports $Ports) {
    if ($ownerId -gt 0 -and $ownerId -ne $PID) {
      $null = $ids.Add([int]$ownerId)
    }
  }

  foreach ($processId in Get-CodexLoopProcessIds -LoopRoot $LoopRoot) {
    if ($processId -gt 0 -and $processId -ne $PID) {
      $null = $ids.Add([int]$processId)
    }
  }

  $ids = @($ids)
  if (-not $ids.Count) {
    return
  }

  Write-Step "Stopping existing codex-loop processes: $($ids -join ', ')"
  foreach ($id in $ids) {
    Stop-ProcessTreeById -ProcessId $id
  }
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

function Invoke-JsonCommand {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @(),
    [string]$FailureMessage = "Command failed."
  )

  $output = & $FilePath @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    if ($output) {
      Write-Host ($output -join [Environment]::NewLine)
    }
    throw $FailureMessage
  }

  $text = ($output -join [Environment]::NewLine).Trim()
  if (-not $text) {
    return $null
  }

  return $text | ConvertFrom-Json
}

function Resolve-CodexCliPath {
  $candidates = @()

  if ($env:CODEX_CLI_PATH) {
    $candidates += $env:CODEX_CLI_PATH
  }

  try {
    $command = Get-Command codex -ErrorAction Stop
    if ($command -and $command.Path) {
      $candidates += $command.Path
    }
  } catch {
  }

  try {
    $command = Get-Command codex.exe -ErrorAction Stop
    if ($command -and $command.Path) {
      $candidates += $command.Path
    }
  } catch {
  }

  foreach ($candidate in $candidates | Where-Object { $_ } | Select-Object -Unique) {
    if (Test-Path $candidate) {
      return (Resolve-Path $candidate).Path
    }
  }

  return ""
}

try {
  $mode = if ($args.Count -gt 0 -and $args[0]) { $args[0] } else { "start" }
  $loopRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
  $configPath = Join-Path $loopRoot "config.json"

  if (-not (Test-Path $configPath)) {
    throw "Missing codex-loop config.json in the tool root."
  }

  $config = Get-Content -Raw -Encoding UTF8 $configPath | ConvertFrom-Json
  $consoleRoot = $loopRoot
  $hostName = if ($env:CODEX_LOOP_HOST) { $env:CODEX_LOOP_HOST } else { "127.0.0.1" }
  $apiPort = $null
  $webPort = $null
  $codexCliPath = Resolve-CodexCliPath

  $Host.UI.RawUI.WindowTitle = "codex-loop launcher"

  Write-Host ""
  Write-Host "codex-loop launcher" -ForegroundColor White
  Write-Host "console: $consoleRoot" -ForegroundColor DarkGray
  Write-Host ""

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "node was not found in PATH."
  }

  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm was not found in PATH."
  }

  if (-not (Test-Path (Join-Path $loopRoot "node_modules"))) {
    Write-ProgressStep -Percent 10 -Message "Installing dependencies..."
    Invoke-CheckedCommand -FilePath "npm" -Arguments @("--prefix", $loopRoot, "install") -FailureMessage "Failed to install codex-loop dependencies."
  } else {
    Write-ProgressStep -Percent 10 -Message "Dependencies ready"
  }

  $cleanupPorts = Get-StartupCandidatePorts -LoopRoot $loopRoot

  Write-ProgressStep -Percent 20 -Message "Cleaning previous processes..."
  Stop-ExistingLoopProcesses -LoopRoot $loopRoot -Ports $cleanupPorts
  Wait-PortsReleased -Ports $cleanupPorts

  Write-ProgressStep -Percent 25 -Message "Checking environment..."
  $checkResult = Invoke-JsonCommand -FilePath "node" -Arguments @(Join-Path $loopRoot "scripts\\check-env.mjs") -FailureMessage "codex-loop environment check failed."
  $apiPort = [string]$checkResult.ports.apiPort
  $webPort = [string]$checkResult.ports.webPort

  if ($mode -ieq "check") {
    Write-ProgressStep -Percent 100 -Message "Environment check complete"
    exit 0
  }

  Write-ProgressStep -Percent 45 -Message "Initializing loop runtime..."
  $initResult = Invoke-JsonCommand -FilePath "node" -Arguments @(Join-Path $loopRoot "scripts\\init-run.mjs") -FailureMessage "Loop initialization failed."

  Write-ProgressStep -Percent 60 -Message "Cleaning previous processes..."
  Stop-ExistingLoopProcesses -LoopRoot $loopRoot -Ports @([int]$apiPort, [int]$webPort)
  Wait-PortsReleased -Ports @([int]$apiPort, [int]$webPort)

  Write-ProgressStep -Percent 72 -Message "Starting dashboard services..."
  $launchCommand = @(
    "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new(`$false)",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(`$false)",
    "`$OutputEncoding = [System.Text.UTF8Encoding]::new(`$false)",
    "`$env:CODEX_LOOP_HOST = '$hostName'",
    "`$env:CODEX_LOOP_PORT = '$apiPort'",
    "`$env:CODEX_LOOP_WEB_PORT = '$webPort'",
    "`$env:CODEX_CLI_PATH = '$codexCliPath'",
    "Set-Location '$loopRoot'",
    "node scripts/dev.mjs"
  ) -join "; "
  Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $launchCommand `
    -WorkingDirectory $loopRoot `
    -WindowStyle Hidden | Out-Null

  Write-ProgressStep -Percent 86 -Message "Waiting for dashboard..."
  $readyStatus = Wait-LauncherReady -LoopRoot $loopRoot
  $resolvedUrl = if ($readyStatus -and $readyStatus.phase -eq "ready" -and $readyStatus.webUrl) {
    [string]$readyStatus.webUrl
  } else {
    "http://${hostName}:$webPort"
  }

  if ($resolvedUrl) {
    Start-Process -FilePath $resolvedUrl | Out-Null
    Write-Host ""
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host " 100%  codex-loop dashboard started" -ForegroundColor Green
    Write-Host " url: $resolvedUrl" -ForegroundColor Yellow
    if ($initResult -and $initResult.runtimeRoot) {
      Write-Host " runtime: $($initResult.runtimeRoot)" -ForegroundColor DarkGray
    }
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host ""
  }

  Write-Ok "Dashboard should now be available."
  Write-Info "If it does not open automatically, visit $resolvedUrl"
  exit 0
} catch {
  Write-Fail $_.Exception.Message
  Write-Info "Run start-codex-loop.bat check for diagnostics."
  exit 1
}
