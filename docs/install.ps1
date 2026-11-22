# Collie Windows installer — https://github.com/Tdcle/collie
#
#   安装 collie 命令：
#     powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Tdcle/collie/main/docs/install.ps1)))"
#
#   把这台 Windows 电脑加入 hub，并作为后台服务常驻（登录后自动启动）：
#     powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Tdcle/collie/main/docs/install.ps1))) node --hub http://<hub>:7788 --code <配对码>"
#
#   让这台 Windows 电脑做 hub，并作为后台服务常驻：
#     powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Tdcle/collie/main/docs/install.ps1))) hub"
#
#   从源码安装（需要 Go 1.25+）：在仓库里运行这个脚本，会用本地源码编译，不下载：
#     git clone https://github.com/Tdcle/collie.git $HOME\collie; cd $HOME\collie
#     powershell -ExecutionPolicy Bypass -File docs\install.ps1 node --hub http://<hub>:7788 --code <配对码>
#
# 环境变量：COLLIE_REPO（默认 Tdcle/collie）、COLLIE_BIN_DIR（默认 ~/.local/bin）、
# COLLIE_BINARY（直接安装这个现成的文件）、COLLIE_VERSION（默认 latest）、COLLIE_NO_HERDR=1。

$ErrorActionPreference = "Stop"

$Repo    = if ($env:COLLIE_REPO)    { $env:COLLIE_REPO }    else { "Tdcle/collie" }
$Version = if ($env:COLLIE_VERSION) { $env:COLLIE_VERSION } else { "latest" }
$BinDir  = if ($env:COLLIE_BIN_DIR) { $env:COLLIE_BIN_DIR } else { Join-Path $HOME ".local\bin" }
$Bin     = Join-Path $BinDir "collie.exe"

function Say([string]$Msg)  { Write-Host $Msg }
function Step([string]$Msg) { Write-Host "==> " -ForegroundColor Cyan -NoNewline; Write-Host $Msg }
function Warn([string]$Msg) { Write-Host "! " -ForegroundColor Yellow -NoNewline; Write-Host $Msg }
function Die([string]$Msg)  { Write-Host "collie: $Msg" -ForegroundColor Red; exit 1 }

# ------------------------------------------------------------------ platform
$rawArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$Arch = switch -Regex ($rawArch) {
  "^(AMD64|x86_64)$" { "amd64"; break }
  "^ARM64$"          { "arm64"; break }
  default            { Die "暂时只支持 Windows amd64 和 arm64（这台是 $rawArch）" }
}

function Get-Checkout {
  if (-not $PSCommandPath) { return $null }
  try {
    $root = (Resolve-Path (Join-Path (Split-Path -Parent $PSCommandPath) "..")).Path
    $gomod = Join-Path $root "go.mod"
    if ((Test-Path $gomod) -and (Select-String -Path $gomod -Pattern "^module github\.com/.+/collie$" -Quiet)) {
      return $root
    }
  } catch {}
  return $null
}

function Ensure-UserPath([string]$Dir) {
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = @()
  if ($userPath) { $parts = $userPath -split ";" | Where-Object { $_ -ne "" } }
  $norm = $Dir.TrimEnd("\")
  $exists = $parts | Where-Object { $_.TrimEnd("\") -ieq $norm }
  if (-not $exists) {
    $newUserPath = if ($userPath) { "$Dir;$userPath" } else { $Dir }
    [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
    Step "已把 $Dir 加入当前用户的 PATH"
  }
  if (-not (($env:Path -split ";") | Where-Object { $_.TrimEnd("\") -ieq $norm })) {
    $env:Path = "$Dir;$env:Path"
  }
}

function Replace-Exe([string]$TmpExe, [string]$DestExe) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $DestExe) | Out-Null
  $oldExe = "$DestExe.old"
  Remove-Item -Force $oldExe -ErrorAction SilentlyContinue
  $hadOld = $false
  if (Test-Path $DestExe) {
    try {
      Move-Item -Force $DestExe $oldExe
      $hadOld = $true
    } catch {
      Die "无法替换 $DestExe（请先运行 collie daemon stop node / hub 后重试）：$_"
    }
  }
  try {
    Move-Item -Force $TmpExe $DestExe
  } catch {
    if ($hadOld -and (Test-Path $oldExe)) { Move-Item -Force $oldExe $DestExe -ErrorAction SilentlyContinue }
    throw
  }
  Remove-Item -Force $oldExe -ErrorAction SilentlyContinue
}

function Build-FromGitHubSource([string]$TmpDir) {
  if (-not (Get-Command go -ErrorAction SilentlyContinue)) { return $false }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return $false }
  $src = Join-Path $TmpDir "src"
  Step "没有找到预编译的 Windows Release，正在使用本机 Go 从 https://github.com/$Repo 编译…"
  & git clone --depth 1 "https://github.com/$Repo.git" $src
  if ($LASTEXITCODE -ne 0) { return $false }
  $v = "dev"
  try {
    $desc = (& git -C $src describe --tags --always --dirty 2>$null)
    if ($LASTEXITCODE -eq 0 -and $desc) { $v = "$desc".Trim() }
  } catch {}
  $out = Join-Path $TmpDir "collie-built.exe"
  Push-Location $src
  try {
    $env:CGO_ENABLED = "0"
    & go build -trimpath -ldflags "-s -w -X main.version=$v" -o $out .
    if ($LASTEXITCODE -ne 0) { return $false }
  } finally {
    Pop-Location
  }
  return $out
}

function Install-Binary([string]$MirrorUrl = "") {
  $asset = "collie-windows-$Arch.exe"
  $base = if ($Version -eq "latest") {
    "https://github.com/$Repo/releases/latest/download"
  } else {
    "https://github.com/$Repo/releases/download/$Version"
  }
  $mirrorBase = ""
  if ($MirrorUrl) {
    $mirrorBase = $MirrorUrl.TrimEnd("/") + "/dl"
  } elseif ($env:COLLIE_HUB_MIRROR) {
    $mirrorBase = $env:COLLIE_HUB_MIRROR.TrimEnd("/") + "/dl"
  } elseif (Test-Path (Join-Path $HOME ".collie\node.json")) {
    try {
      $nj = Get-Content (Join-Path $HOME ".collie\node.json") -Raw | ConvertFrom-Json
      if ($nj.hub) { $mirrorBase = ([string]$nj.hub).TrimEnd("/") + "/dl" }
    } catch {}
  }

  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("collie-install-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    $tmpExe = Join-Path $tmp $asset
    $checkout = Get-Checkout

    if ($env:COLLIE_BINARY) {
      Copy-Item -Force $env:COLLIE_BINARY $tmpExe
    } elseif ($checkout) {
      if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
        Die "从源码安装需要 Go 1.25+：https://go.dev/dl/"
      }
      $v = "dev"
      if (Get-Command git -ErrorAction SilentlyContinue) {
        $desc = (& git -C $checkout describe --tags --always --dirty 2>$null)
        if ($LASTEXITCODE -eq 0 -and $desc) { $v = "$desc".Trim() }
      }
      Step "从本地源码编译（$checkout，$v）"
      Push-Location $checkout
      try {
        $env:CGO_ENABLED = "0"
        & go build -trimpath -ldflags "-s -w -X main.version=$v" -o $tmpExe .
        if ($LASTEXITCODE -ne 0) { Die "编译失败" }
      } finally {
        Pop-Location
      }
    } else {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      $downloaded = $false
      $usedBase = $base
      if ($mirrorBase -and $Version -eq "latest") {
        try {
          Step "从 Hub 镜像快速下载 $asset"
          Invoke-WebRequest -UseBasicParsing -Uri "$mirrorBase/$asset" -OutFile $tmpExe
          if ((Test-Path $tmpExe) -and ((Get-Item $tmpExe).Length -gt 1048576)) {
            $downloaded = $true
            $usedBase = $mirrorBase
          }
        } catch {
          Remove-Item -Force $tmpExe -ErrorAction SilentlyContinue
        }
      }
      if (-not $downloaded) {
        Step "下载 $asset（$Version）"
        try {
          Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $tmpExe
          $downloaded = $true
          $usedBase = $base
        } catch {
          $built = Build-FromGitHubSource $tmp
          if ($built -and (Test-Path $built)) {
            Copy-Item -Force $built $tmpExe
          } else {
            Die "下载失败（$base/$asset），且本机没有 git + Go 1.25+ 可供源码编译。"
          }
        }
      }
      if ($downloaded) {
        $sumFile = Join-Path $tmp "checksums.txt"
        try {
          Invoke-WebRequest -UseBasicParsing -Uri "$usedBase/checksums.txt" -OutFile $sumFile
          $want = ""
          foreach ($line in Get-Content $sumFile) {
            $f = $line.Trim() -split "\s+"
            if ($f.Count -ge 2 -and $f[1] -eq $asset) { $want = $f[0].ToLower(); break }
          }
          if (-not $want) { Die "checksums.txt 里没有 $asset" }
          $got = (Get-FileHash -Algorithm SHA256 $tmpExe).Hash.ToLower()
          if ($got -ne $want) { Die "SHA-256 校验对不上，已取消安装" }
        } catch {
          if ($_.Exception.Message -match "校验|checksums") { throw }
        }
      }
    }

    Replace-Exe $tmpExe $Bin
    Ensure-UserPath $BinDir
    $ver = try { (& $Bin version 2>$null) -join " " } catch { "collie" }
    Step "已安装 $ver -> $Bin"
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

# ------------------------------------------------------------------ background service + autostart
function Quote-CmdArg([string]$Arg) {
  if ($Arg -match '[\s"]') {
    return '"' + ($Arg -replace '"', '\"') + '"'
  }
  return $Arg
}

function Register-AutoStart([string]$Name, [string[]]$SubArgs) {
  $cmdParts = @("daemon", "start", $Name, "--") + $SubArgs
  $argStr = ($cmdParts | ForEach-Object { Quote-CmdArg $_ }) -join " "
  $cmdLine = '"' + $Bin + '" ' + $argStr
  $colDir = Join-Path $HOME ".collie"
  New-Item -ItemType Directory -Force -Path $colDir | Out-Null
  $vbsPath = Join-Path $colDir "autostart-$Name.vbs"
  $vbsContent = 'CreateObject("WScript.Shell").Run "' + ($cmdLine -replace '"', '""') + '", 0, False' + "`r`n"
  $runVal = 'wscript.exe //B //Nologo "' + $vbsPath + '"'
  $regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  if ($env:COLLIE_DRY_SERVICE) {
    Say "$regPath -> Collie-$Name = $runVal"
    return
  }
  try {
    [System.IO.File]::WriteAllText($vbsPath, $vbsContent, [System.Text.Encoding]::UTF8)
    New-Item -Path $regPath -Force | Out-Null
    Set-ItemProperty -Path $regPath -Name "Collie-$Name" -Value $runVal
  } catch {
    Warn "无法写入开机自启注册表项：$_"
  }
  $daArgs = @("daemon", "restart", $Name, "--") + $SubArgs
  & $Bin @daArgs
  if ($LASTEXITCODE -ne 0) {
    Die "后台服务启动失败，请查看 $HOME\.collie\$Name.log"
  }
  Step "已作为后台常驻守护进程运行，并已注册无窗口开机/登录自启（HKCU Run: Collie-$Name）"
  Say "    日志：Get-Content -Wait `"$HOME\.collie\$Name.log`""
  Say "    管理：collie daemon status|restart|stop $Name"
}

# ------------------------------------------------------------------ herdr
function Find-Herdr {
  $c = Get-Command herdr -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $cands = @(
    (Join-Path $HOME ".local\bin\herdr.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Herdr\bin\herdr.exe"),
    (Join-Path $HOME ".herdr\packages\standalone\current\herdr.exe")
  )
  foreach ($p in $cands) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  return $null
}

function Check-Herdr([string]$Note = "") {
  $hb = Find-Herdr
  if (-not $hb -and -not $env:COLLIE_NO_HERDR) {
    Step "安装 herdr（Collie 通过它看到和管理 agent；不想装可设 `$env:COLLIE_NO_HERDR=1）"
    try {
      $script = Invoke-RestMethod -UseBasicParsing -Uri "https://herdr.dev/install.ps1"
      & ([scriptblock]::Create($script)) | Out-Null
      $hb = Find-Herdr
    } catch {
      Warn "herdr 自动安装未成功，可稍后手动运行：irm https://herdr.dev/install.ps1 | iex"
    }
  }
  if (-not $hb) {
    $suffix = if ($Note) { "（$Note）" } else { "" }
    Warn "没找到 herdr：没有它，这台电脑上的 agent 不会出现在 Collie 里$suffix。"
    Say "    安装：irm https://herdr.dev/install.ps1 | iex"
    return
  }
  $hbDir = Split-Path -Parent $hb
  Ensure-UserPath $hbDir

  $stOut = ""
  try { $stOut = (& $hb status 2>$null) -join "`n" } catch {}
  if ($stOut -notmatch "status:\s*running") {
    Start-Process -FilePath $hb -ArgumentList @("server") -WindowStyle Hidden
    Start-Sleep -Seconds 2
    try { $stOut = (& $hb status 2>$null) -join "`n" } catch {}
    if ($stOut -match "status:\s*running") {
      Step "已在后台启动 herdr 服务端（herdr server）"
    } else {
      Warn "herdr 服务端没起来：请运行一次 herdr 或 herdr server。"
    }
  }

  $intOut = ""
  try { $intOut = (& $hb integration status 2>$null) -join "`n" } catch { return }
  $missing = @()
  foreach ($pair in @(@("claude","claude"), @("codex","codex"), @("agy","antigravity-cli"))) {
    if (-not (Get-Command $pair[0] -ErrorAction SilentlyContinue)) { continue }
    $target = $pair[1]
    $line = ($intOut -split "`r?`n" | Where-Object { $_ -like "${target}:*" } | Select-Object -First 1)
    if ($line -and ($line -notlike "*: current*")) {
      $missing += $target
    }
  }
  if ($missing.Count -gt 0) {
    Warn "这些 agent 还没装 herdr 集成：运行下面的命令让 herdr 能识别它们："
    foreach ($t in $missing) { Say "      herdr integration install $t" }
  }
}

# ------------------------------------------------------------------ main
$Mode = if ($args.Count -gt 0) { $args[0] } else { "" }
$Rest = if ($args.Count -gt 1) { @($args[1..($args.Count - 1)]) } else { @() }

switch ($Mode) {
  "" {
    Install-Binary
    Say ""
    Say "下一步："
    Say "  让这台电脑做 hub：   collie -url http://<本机内网 IP>:7788"
    Say "  把电脑加入 hub：     collie node --hub http://<hub>:7788 --code <配对码>"
    Say "  （加 node / hub 参数运行本脚本，会顺便配置后台常驻与登录自启）"
    Check-Herdr
  }
  "node" {
    $hubArg = ""
    for ($i = 0; $i -lt $Rest.Count; $i++) {
      if ($Rest[$i] -eq "--hub" -and ($i + 1 -lt $Rest.Count)) { $hubArg = $Rest[$i + 1]; break }
      if ($Rest[$i] -like "--hub=*") { $hubArg = $Rest[$i].Substring(6); break }
    }
    if (Test-Path $Bin) {
      try { & $Bin daemon stop node 2>$null | Out-Null } catch {}
    }
    Install-Binary $hubArg
    $hasCode = $false
    foreach ($a in $Rest) {
      if ($a -eq "--code" -or $a -like "--code=*") { $hasCode = $true; break }
    }
    if ($hasCode) {
      Step "加入 hub"
      $pairArgs = @("node", "--pair-only") + $Rest
      & $Bin @pairArgs
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } else {
      $nodeJson = Join-Path $HOME ".collie\node.json"
      if (-not (Test-Path $nodeJson)) {
        Die "第一次加入需要带上 --hub http://<hub>:7788 --code <配对码>（在 hub 的「设备 → 连接一台电脑」里获取）。"
      }
    }
    $svcArgs = @()
    for ($i = 0; $i -lt $Rest.Count; $i++) {
      $a = $Rest[$i]
      if ($a -eq "--name" -or $a -eq "--socket" -or $a -eq "--ui") {
        if ($i + 1 -lt $Rest.Count) {
          $svcArgs += @($a, $Rest[$i + 1])
          $i++
        }
      } elseif ($a -like "--name=*" -or $a -like "--socket=*" -or $a -like "--ui=*") {
        $svcArgs += $a
      } elseif ($a -eq "--hub" -or $a -eq "--code") {
        $i++
      }
    }
    Register-AutoStart "node" $svcArgs
    Say "    在 hub 的侧栏里能看到这台 Windows 电脑了。"
    Say "    本机界面：http://127.0.0.1:17788（用 Chrome/Edge 打开可以安装成桌面应用）"
    Check-Herdr
  }
  "hub" {
    Install-Binary
    Register-AutoStart "hub" $Rest
    Say "    打开 hub 的地址；手机配对：collie pair（或在「设备」页扫码）。"
    Say "    首次登录的令牌在 $HOME\.collie\token。"
    Check-Herdr "hub 本身照常能用"
  }
  default {
    Die "不认识的参数：$Mode（可以是 node、hub，或者不带参数）"
  }
}
