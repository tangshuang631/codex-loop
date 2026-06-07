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

function Write-ProgressStep {
  param(
    [int]$Percent,
    [string]$Message
  )

  Write-Host ("[{0,3}%] {1}" -f $Percent, $Message)
}

function Write-Ok {
  param([string]$Message)
  Write-Host "[ok] $Message" -ForegroundColor Green
}

function Write-Fail {
  param([string]$Message)
  Write-Host "[error] $Message" -ForegroundColor Red
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

  $ids = @($ids)
  if (-not $ids.Count) {
    return
  }

  Write-Step "Stopping existing codex-loop dev processes: $($ids -join ', ')"
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
    $loopRoot
  }

  $workspaceRoot = (Resolve-Path $workspaceRoot).Path
  $hostName = if ($env:CODEX_LOOP_HOST) { $env:CODEX_LOOP_HOST } else { "127.0.0.1" }
  $apiPort = $null
  $webPort = $null

  $Host.UI.RawUI.WindowTitle = "codex-loop launcher"

  Write-Host ""
  Write-Host "codex-loop 启动器" -ForegroundColor White
  Write-Host "工作区: $workspaceRoot" -ForegroundColor DarkGray
  Write-Host ""

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "node was not found in PATH."
  }

  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm was not found in PATH."
  }

  if (-not (Test-Path (Join-Path $loopRoot "node_modules"))) {
    Write-ProgressStep -Percent 10 -Message "首次启动，正在准备依赖..."
    Invoke-CheckedCommand -FilePath "npm" -Arguments @("--prefix", $loopRoot, "install") -FailureMessage "Failed to install codex-loop dependencies."
  } else {
    Write-ProgressStep -Percent 10 -Message "依赖已就绪"
  }

  Write-ProgressStep -Percent 25 -Message "正在检查运行环境..."
  $checkResult = Invoke-JsonCommand -FilePath "node" -Arguments @(Join-Path $loopRoot "scripts\check-env.mjs") -FailureMessage "codex-loop environment check failed."
  $apiPort = [string]$checkResult.ports.apiPort
  $webPort = [string]$checkResult.ports.webPort

  if ($mode -ieq "check") {
    Write-ProgressStep -Percent 100 -Message "环境检查完成"
    exit 0
  }

  Write-ProgressStep -Percent 45 -Message "正在初始化 loop 运行区..."
  $initResult = Invoke-JsonCommand -FilePath "node" -Arguments @(Join-Path $loopRoot "scripts\init-run.mjs") -FailureMessage "Loop initialization failed."

  Write-ProgressStep -Percent 60 -Message "正在清理旧的控制台进程..."
  Stop-ExistingLoopProcesses -LoopRoot $loopRoot -Ports @([int]$apiPort, [int]$webPort)

  Write-ProgressStep -Percent 72 -Message "正在启动控制台服务..."

  $command = "chcp 65001>nul && cd /d `"$loopRoot`" && set `"CODEX_LOOP_HOST=$hostName`" && set `"CODEX_LOOP_PORT=$apiPort`" && set `"CODEX_LOOP_WEB_PORT=$webPort`" && npm run dev"
  Start-Process -FilePath "cmd.exe" -ArgumentList "/k", $command -WorkingDirectory $loopRoot -WindowStyle Normal | Out-Null

  Write-ProgressStep -Percent 86 -Message "正在等待控制台就绪..."
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
    Write-Host " 100%  codex-loop 控制台已启动" -ForegroundColor Green
    Write-Host " 实际访问地址: $resolvedUrl" -ForegroundColor Yellow
    if ($initResult -and $initResult.runtimeRoot) {
      Write-Host " 运行目录: $($initResult.runtimeRoot)" -ForegroundColor DarkGray
    }
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host ""
  }

  Write-Ok "浏览器即将打开控制台。"
  Write-Info "如果没有自动打开，请手动访问 $resolvedUrl"
  exit 0
} catch {
  Write-Fail $_.Exception.Message
  Write-Info "Run start-codex-loop.bat check for detailed diagnostics."
  exit 1
}
