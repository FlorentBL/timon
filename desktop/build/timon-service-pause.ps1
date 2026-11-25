# Pauses the Timon background service while the installer replaces its files.
# Run by installer.nsh (timonPauseService), never by hand: elevated when
# Windows grants it, and once more without elevation when it does not.
#
# Why elevated: the service runs under a Task Scheduler S4U logon, in session 0.
# The per-user installer sees those Timon.exe processes (same user) but cannot
# end them, and looped on "Timon cannot be closed" (0.1.2-rc.2 update,
# 27/09/2026). The task is disabled first: its 5-minute repeating trigger would
# otherwise start the daemon again from half-replaced files.
#
# Why it also runs unelevated: an account Windows refuses S4U for (a standard
# account on an Entra-joined PC) gets an Interactive task, which runs the daemon
# in the user's own session; that user may disable the task and end the daemon
# without elevation. Left running, the daemon kept its files open while the
# installer replaced them, and the next launch failed on a missing `ffmpeg.dll`
# (0.1.5 update, 21/10/2026).
#
# The first run (stop phase) ends the service and starts a detached copy of
# itself (resume phase), which waits for the installer to exit and then enables
# and starts the task again if it still exists: an uninstall deletes it.
#
# The stop phase answers the installer with its exit code: 0 when nothing of
# Timon runs any more, 5 when something still does. The installer then asks
# to try again or stops, and never replaces the files of a running daemon.
param(
  # The installer's process: the resume waits for it, and its owner is the
  # account whose Timon this is.
  [Parameter(Mandatory = $true)][int]$InstallerPid,
  [Parameter(Mandatory = $true)][string]$Exe,
  # The application directory: what remains of this installation is found by
  # the paths under it on a command line. Empty: only the daemon is ended.
  [string]$InstallDir = '',
  # The data directory of the account that runs the installer, which names it:
  # under another account's elevation, this script's own profile is not it.
  [string]$TimonHome = '',
  # The profile directory of the account that started the installer, resolved
  # by the installer before it asked for elevation. The daemon token is only
  # read under it, and only when Windows records it for that account's SID.
  [string]$UserProfile = '',
  # The journal of both phases. The stop phase computes it and hands it to the
  # resume phase, whose environment comes from WMI, not from the installer.
  [string]$Log = '',
  [switch]$Resume
)
$task = 'TimonOrchestrator'
# Exit code of the stop phase when something of Timon still runs. The installer
# (installer.nsh, TIMON_SERVICE_STILL_RUNNING) and the host adapter
# (PROCESSES_REMAIN) read the same number.
$stillRunning = 5
if (-not $TimonHome -and $env:USERPROFILE) { $TimonHome = Join-Path $env:USERPROFILE '.timon' }
if (-not $Log -and $TimonHome) { $Log = Join-Path $TimonHome 'tmp\timon-service-pause.log' }
$note = {
  param([string]$text)
  if (-not $Log) { return }
  try {
    $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Log) -ErrorAction Stop
    # UTF-8: Windows PowerShell appends in the ANSI code page otherwise, and the
    # diagnostic report reads this file as UTF-8.
    Add-Content -LiteralPath $Log -Value ('{0} {1}' -f (Get-Date -Format o), $text) -Encoding UTF8 -ErrorAction Stop
  } catch { }
}
$taskState = {
  try {
    [string](Get-ScheduledTask -TaskName $task -TaskPath '\' -ErrorAction Stop).State
  } catch {
    if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { 'not registered' } else { "unreadable ($($_.Exception.Message))" }
  }
}

# Not under SilentlyContinue: it hid why a killed installer left the task
# Disabled and the daemon stopped (VM, 06/11/2026). Each call reports its own
# error, is tried again, and the last failure is written to $Log.
if ($Resume) {
  Wait-Process -Id $InstallerPid -ErrorAction Ignore
  # Wait-Process gives up at once on a process it may not open (an elevated
  # installer seen from an unelevated resume): poll until no installer runs.
  while (Get-Process -Id $InstallerPid -ErrorAction Ignore) { Start-Sleep -Seconds 2 }
  $failure = ''
  foreach ($attempt in 1..3) {
    try {
      $state = (Get-ScheduledTask -TaskName $task -TaskPath '\' -ErrorAction Stop).State
      # The state is read, not assumed: a task an earlier pause left Disabled
      # is enabled too, and a running one is not started twice.
      if ($state -eq 'Disabled') { Enable-ScheduledTask -TaskName $task -TaskPath '\' -ErrorAction Stop | Out-Null }
      if ($state -ne 'Running') { Start-ScheduledTask -TaskName $task -TaskPath '\' -ErrorAction Stop }
      if ((Get-ScheduledTask -TaskName $task -TaskPath '\' -ErrorAction Stop).State -eq 'Disabled') { throw 'the task is still disabled' }
      $failure = ''
      break
    } catch {
      # An uninstall deleted the task: nothing to resume.
      if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { $failure = ''; break }
      $failure = "attempt $attempt`: $($_.Exception.Message)"
      if ($attempt -lt 3) { Start-Sleep -Seconds 5 }
    }
  }
  if ($failure) { & $note "resume: could not enable and start $task ($failure)" } else { & $note ("resume: the installer exited, task {0} is {1}" -f $task, (& $taskState)) }
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction Ignore
  exit 0
}

# The stop phase writes what it found and what it did to $Log, call by call.
# It used to run with every error silenced and every output discarded: when it
# ended nothing at all on a tester's PC (0.1.7 to 0.1.8 update), no file said
# so, and the cause had to be read out of the installer. A call that fails is
# written down and the phase goes on: the net at its end decides.
# Kept small: one run of the installer writes a few dozen lines.
if ($Log) {
  try {
    if ((Get-Item -LiteralPath $Log -ErrorAction Stop).Length -gt 1MB) { Remove-Item -LiteralPath $Log -Force -ErrorAction Stop }
  } catch { }
}
$elevated = $false
try {
  $elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }

# Whose Timon this is: the owner of the installer's process, by SID. Never a
# name. The installer passed `-User` built from the NSIS form that is replaced
# when the installer is COMPILED, so every installer carried the account of the
# build machine: on a tester's PC the comparison was always false, nothing was
# ended, and the previous daemon outlived the update holding its port
# (0.1.7 to 0.1.8). A SID also holds for a Microsoft Entra account, and for an
# elevation granted by another account, where this script runs as the
# administrator while the installer still belongs to the user.
$sidOf = {
  param($process)
  try { (Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop).Sid } catch { $null }
}
$account = $null
$accountSource = 'the installer process'
$installer = $null
try { $installer = Get-CimInstance Win32_Process -Filter "ProcessId=$InstallerPid" -ErrorAction Stop } catch { }
if ($installer) { $account = & $sidOf $installer }
# The installer could not be read (it is elevated, this run is not): this
# process then runs as the very account that started it.
if (-not $account) {
  $account = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $accountSource = 'this process, the installer could not be read'
}
$mine = { param($process) $account -and ((& $sidOf $process) -eq $account) }
# The installation, lower-cased: what runs from under it is Timon's.
$root = $InstallDir.TrimEnd('\').ToLowerInvariant()
& $note ("pause: start, elevated: {0}, installer pid {1}, account SID {2} (from {3}), installation '{4}', data '{5}', profile '{6}'" -f $elevated, $InstallerPid, $account, $accountSource, $InstallDir, $TimonHome, $UserProfile)

# Disabled first: its 5-minute repeating trigger would otherwise start the
# daemon again from half-replaced files.
& $note ("pause: task {0} is {1}" -f $task, (& $taskState))
try {
  $null = Disable-ScheduledTask -TaskName $task -TaskPath '\' -ErrorAction Stop
  & $note 'pause: task disabled'
} catch { & $note "pause: task not disabled: $($_.Exception.Message)" }
# The daemon's port: this home's configuration, else the packaged default.
$port = 3010
$portSource = 'the packaged default'
if ($TimonHome) {
  try {
    $config = Get-Content -LiteralPath (Join-Path $TimonHome 'timon.config.json') -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $configured = [int]$config.daemon.listen.port
    if ($configured -gt 0) { $port = $configured; $portSource = 'timon.config.json' }
  } catch { $portSource = "the packaged default, timon.config.json could not be read ($($_.Exception.Message))" }
}

# Asked first, ended by force only when it does not go: taskkill /F runs no
# handler, so the next start read the previous run as `unknown`. The same
# request as `timon service stop` (host/cooperative-stop.ts), with the same
# wait: TIMON_COOPERATIVE_STOP_MS, 10 s by default, 120 s at most, 0 to skip
# it (desktop/src/packaging.test.ts holds the three values to that file).
# Only a service's daemon is asked, after its task was disabled: the launcher
# ends once its daemon exits 0, while a desktop without a service restarts the
# daemon it embeds.
#
# This script may run elevated, under another account's administrator, and it
# holds the daemon token: whoever receives it drives Timon. So the request is
# an improvement, never a condition to install. Unless every guard below is
# proven, nothing is sent and the forced stop that follows does the work, as
# it did before the request existed:
# - the token is this account's: the installer named its profile before the
#   elevation (-UserProfile), it is the profile Windows records for the SID
#   that owns the installer, the data directory lies under it, and the token
#   file, read through the handle that was checked, is owned by that SID;
# - the listener is this data directory's daemon: the pid it wrote, the only
#   process on the port, run from this installation by this account, and the
#   process at the other end of the very connection the token goes through;
# - one deadline, on a monotonic clock, bounds connecting, sending and reading,
#   and the answer is read up to its status line only, within a fixed size.
# The token never reaches the journal or a command line.
$stopWaitMs = 10000
$stopWaitMaxMs = 120000
$stopWaitRaw = "$env:TIMON_COOPERATIVE_STOP_MS".Trim()
if ($stopWaitRaw -match '^[0-9]+$') { $stopWaitMs = [int][Math]::Min([double]$stopWaitRaw, $stopWaitMaxMs) }
$requestMs = 3000
$answerMaxBytes = 4096
$loopback = "http://127.0.0.1:$port"
# Carries no token: it only tells whether something still answers.
$localRequest = {
  param([string]$method, [string]$path, [int]$timeoutMs)
  $request = [Net.HttpWebRequest]::Create("$loopback$path")
  $request.Method = $method
  $request.Proxy = $null
  $request.AllowAutoRedirect = $false
  $request.Timeout = $timeoutMs
  $request.ReadWriteTimeout = $timeoutMs
  $request
}
# The HTTP answer an error carries, if any: a status other than 2xx is thrown
# as a WebException, which a method call wraps once more.
$httpAnswer = {
  param($failure)
  while ($failure -and -not ($failure -is [Net.WebException])) { $failure = $failure.InnerException }
  if ($failure) { $failure.Response } else { $null }
}
# Any HTTP answer means a listener; only a failed connection or a timeout means none.
$answers = {
  try {
    $response = (& $localRequest 'GET' '/api/health' 1000).GetResponse()
    $response.Close()
    $true
  } catch {
    $answer = & $httpAnswer $_.Exception
    if ($answer) { $answer.Close(); $true } else { $false }
  }
}
$fullPath = {
  param([string]$path)
  if (-not $path) { return '' }
  try { [IO.Path]::GetFullPath($path).TrimEnd('\') } catch { '' }
}
# The text of a file of the data directory, or $null when it is not this
# account's. The owner is read from the handle the text is read through, not
# from the path: a file swapped between a check and a read, or a link to
# another account's file, is never the one that was checked.
$readOwned = {
  param([string]$path, [int]$limit)
  $file = $null
  try {
    $file = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    $owner = $file.GetAccessControl().GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -ne $account) { return $null }
    if ($file.Length -gt $limit) { return $null }
    $bytes = New-Object byte[] ([int]$file.Length)
    $count = 0
    while ($count -lt $bytes.Length) {
      $read = $file.Read($bytes, $count, $bytes.Length - $count)
      if ($read -le 0) { break }
      $count += $read
    }
    [Text.Encoding]::UTF8.GetString($bytes, 0, $count)
  } catch { $null } finally { if ($file) { $file.Dispose() } }
}
# Why the token is not proven to be this account's, or nothing.
$tokenRefusal = {
  if ($elevated -and -not $installer) { return 'the installer process could not be read, whose token this is is not proven' }
  if ("$account" -notmatch '^S-1-[0-9]+(-[0-9]+)+$') { return 'no account SID' }
  if (-not $UserProfile) { return 'the installer named no user profile' }
  # The 64-bit view: the installer starts the 32-bit PowerShell, whose view of
  # the machine's registry may be redirected.
  $recorded = ''
  try {
    $machine = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
    $key = $machine.OpenSubKey("SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$account")
    if ($key) { $recorded = "$($key.GetValue('ProfileImagePath'))"; $key.Close() }
    $machine.Close()
  } catch { }
  $profileDir = & $fullPath $recorded
  if (-not $profileDir) { return 'Windows records no profile for the account' }
  if ($profileDir -ne (& $fullPath $UserProfile)) { return "the profile the installer named is not the account's" }
  $dataDir = & $fullPath $TimonHome
  if (-not $dataDir.StartsWith("$profileDir\", [StringComparison]::OrdinalIgnoreCase)) { return "the data directory is not under the account's profile" }
  ''
}
# Why the process on the port is not this data directory's daemon, or nothing.
$listenerRefusal = {
  param([int]$expected)
  $owners = @()
  try { $owners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique) } catch { return 'nothing listens on the port' }
  if ($owners.Count -ne 1 -or [int]$owners[0] -ne $expected) {
    return ("the port is held by pid {0}, not only by the daemon of this data directory (pid {1})" -f ($owners -join ', '), $expected)
  }
  $listener = $null
  try { $listener = Get-CimInstance Win32_Process -Filter "ProcessId=$expected" -ErrorAction Stop } catch { }
  if (-not $listener) { return 'the listener could not be read' }
  if (-not $root -or -not $listener.ExecutablePath -or -not $listener.ExecutablePath.ToLowerInvariant().StartsWith("$root\")) {
    return 'the listener does not run from this installation'
  }
  if ((& $sidOf $listener) -ne $account) { return "the listener is not this account's" }
  ''
}
# POST /api/daemon/shutdown over a socket whose other end is checked before
# the token is written. Answers the HTTP status, or 0 with the reason.
$askToStop = {
  param([string]$bearer, [int]$expected)
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $remaining = { [int][Math]::Max(0, $requestMs - $clock.ElapsedMilliseconds) }
  $client = $null
  $payload = $null
  try {
    $client = New-Object -TypeName Net.Sockets.TcpClient -ArgumentList ([Net.Sockets.AddressFamily]::InterNetwork)
    $connecting = $client.BeginConnect([Net.IPAddress]::Loopback, $port, $null, $null)
    if (-not $connecting.AsyncWaitHandle.WaitOne((& $remaining))) { return @{ status = 0; why = 'the connection timed out' } }
    $client.EndConnect($connecting)
    # The accepted end of this connection belongs to the process that listens:
    # it must be the daemon checked above, not whoever took the port since.
    $ours = ([Net.IPEndPoint]$client.Client.LocalEndPoint).Port
    $peers = @()
    try {
      $peers = @(Get-NetTCPConnection -State Established -LocalAddress '127.0.0.1' -LocalPort $port -RemoteAddress '127.0.0.1' -RemotePort $ours -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
    } catch { }
    if ($peers.Count -ne 1 -or [int]$peers[0] -ne $expected) { return @{ status = 0; why = 'the connection does not end at the daemon' } }
    $left = & $remaining
    if ($left -le 0) { return @{ status = 0; why = 'the deadline passed before sending' } }
    $client.SendTimeout = $left
    $payload = [Text.Encoding]::ASCII.GetBytes("POST /api/daemon/shutdown HTTP/1.1`r`nHost: 127.0.0.1:$port`r`nAuthorization: Bearer $bearer`r`nContent-Length: 0`r`nConnection: close`r`n`r`n")
    $stream = $client.GetStream()
    $stream.Write($payload, 0, $payload.Length)
    # Only the status line is wanted: an answer that never ends, or ends
    # slowly, is cut at the deadline or at the size, whichever comes first.
    $received = New-Object IO.MemoryStream
    $buffer = New-Object byte[] 512
    while ($received.Length -lt $answerMaxBytes) {
      $left = & $remaining
      if ($left -le 0) { return @{ status = 0; why = 'no status line before the deadline' } }
      $client.ReceiveTimeout = $left
      $read = $stream.Read($buffer, 0, [int][Math]::Min($buffer.Length, $answerMaxBytes - $received.Length))
      if ($read -le 0) { break }
      $received.Write($buffer, 0, $read)
      $text = [Text.Encoding]::ASCII.GetString($received.ToArray())
      if ($text -match '^HTTP/1\.[01] ([0-9]{3})[^\r\n]*\r?\n') { return @{ status = [int]$Matches[1]; why = '' } }
    }
    @{ status = 0; why = 'no status line in the answer' }
  } catch {
    @{ status = 0; why = 'the connection failed' }
  } finally {
    if ($payload) { [Array]::Clear($payload, 0, $payload.Length) }
    if ($client) { $client.Close() }
  }
}
$stopOutcome = 'skipped'
if ((& $taskState) -eq 'not registered') {
  & $note 'pause: no service task, its daemon is not asked to stop'
} elseif ($stopWaitMs -le 0) {
  & $note 'pause: daemon not asked to stop (TIMON_COOPERATIVE_STOP_MS=0)'
} else {
  $daemonPid = 0
  $token = $null
  $why = & $tokenRefusal
  $dataDir = & $fullPath $TimonHome
  if (-not $why) {
    # The pid the daemon of this data directory wrote when it took it (home-lock.ts).
    $holder = $null
    try { $holder = (& $readOwned (Join-Path $dataDir 'daemon.lock.json') 4096) | ConvertFrom-Json -ErrorAction Stop } catch { }
    if ($holder -and "$($holder.pid)" -match '^[0-9]+$') { $daemonPid = [int]$holder.pid }
    if ($daemonPid -le 0) {
      $why = 'no daemon pid of this account in the data directory'
    } elseif ($holder.port -and "$($holder.port)" -ne "$port") {
      $why = "the daemon of the data directory listens on port $($holder.port), not $port"
    }
  }
  if (-not $why) { $why = & $listenerRefusal $daemonPid }
  if (-not $why) {
    $token = "$(& $readOwned (Join-Path $dataDir 'daemon-token') 4096)".Trim()
    if (-not $token) { $why = 'no daemon token of this account' }
  }
  if ($why) {
    $token = $null
    & $note ("pause: daemon not asked to stop: {0}; it is ended by force" -f $why)
  } else {
    $asked = & $askToStop $token $daemonPid
    $token = $null
    $status = [int]$asked.status
    if ($status -eq 0) {
      $stopOutcome = 'unreachable'
      & $note ("pause: no daemon answered the stop request on port {0} ({1})" -f $port, $asked.why)
    } elseif ($status -ne 202) {
      $stopOutcome = 'refused'
      & $note ("pause: the daemon did not accept to stop (HTTP {0}): ending it" -f $status)
    } else {
      $stopOutcome = 'timeout'
      $waited = [Diagnostics.Stopwatch]::StartNew()
      while ($true) {
        $alive = [bool](Get-Process -Id $daemonPid -ErrorAction Ignore)
        if (-not $alive -and -not (& $answers)) { $stopOutcome = 'stopped'; break }
        if ($waited.ElapsedMilliseconds -ge $stopWaitMs) { break }
        Start-Sleep -Milliseconds 250
      }
      if ($stopOutcome -eq 'stopped') {
        & $note ("pause: the daemon (pid {0}) stopped on request" -f $daemonPid)
      } else {
        & $note ("pause: the daemon (pid {0}) still runs {1} s after the stop request: ending it" -f $daemonPid, [Math]::Round($stopWaitMs / 1000))
      }
    }
  }
}

try {
  Stop-ScheduledTask -TaskName $task -TaskPath '\' -ErrorAction Stop
  & $note 'pause: task stopped'
} catch { & $note "pause: task not stopped: $($_.Exception.Message)" }
& $note ("pause: task {0} is now {1}" -f $task, (& $taskState))

# The daemon runs on the Node the package ships (resources\node\node.exe);
# a package before it ran it on $Exe as Node. An update from one to the other
# finds either, so both are ours.
$runtimes = @($Exe, 'node.exe')
# The path, never the command line: a command line can carry a secret.
$describe = {
  param($process)
  $path = 'path unreadable'
  if ($process.ExecutablePath) { $path = $process.ExecutablePath }
  "pid $($process.ProcessId), $($process.Name), session $($process.SessionId), $path"
}
$processes = {
  try {
    @(Get-CimInstance Win32_Process -ErrorAction Stop)
  } catch {
    & $note "pause: the process list could not be read: $($_.Exception.Message)"
    @()
  }
}
$end = {
  param($process, [string]$what)
  & $note ("pause: found {0}: {1}" -f $what, (& $describe $process))
  $said = (& taskkill.exe /F /T /PID $process.ProcessId 2>&1 | ForEach-Object { "$_".Trim() }) -join ' '
  & $note ("pause: taskkill of pid {0} ended with {1}: {2}" -f $process.ProcessId, $LASTEXITCODE, $said)
}

# Stop-ScheduledTask ends the launcher and leaves its daemon orphaned: end the
# launcher's tree, then every daemon of this account it left behind, in
# whatever session it runs (session 0 for S4U, the user's own for an
# Interactive task) and wherever it is installed. The daemon names its entry
# point on its command line; the window (no boot.js) is left to the installer's
# own "close the application".
# A launcher is the batch of task revisions 2 to 5 (cmd.exe), or, since
# revision 6, the program whose command line names the launcher configuration:
# the Node of the launcher script, or Timon.exe --timon-service in the session
# (LAUNCHER_PROGRAMS, host/service-install.ts). Never this script itself.
$launcherPrograms = @('cmd.exe', 'node.exe', 'timon.exe', 'powershell.exe', 'electron.exe')
$launchers = @(& $processes | Where-Object {
  $launcherPrograms -contains $_.Name -and $_.ProcessId -ne $PID -and $_.CommandLine -and
  ($_.CommandLine.ToLowerInvariant().Contains('\run\timon-service.cmd') -or
   $_.CommandLine.ToLowerInvariant().Contains('\run\timon-service.json')) -and (& $mine $_)
})
& $note ("pause: {0} service launcher(s) of this account" -f $launchers.Count)
$launchers | ForEach-Object { & $end $_ 'a service launcher' }
$daemons = @(& $processes | Where-Object {
  $runtimes -contains $_.Name -and $_.CommandLine -and
  $_.CommandLine.ToLowerInvariant().Contains('\dist\boot.js')
})
& $note ("pause: {0} daemon(s) by entry point" -f $daemons.Count)
foreach ($daemon in $daemons) {
  if (& $mine $daemon) {
    & $end $daemon 'a daemon of this account'
  } else {
    # Written down: an owner that does not match is how the pause once ended nothing.
    & $note ("pause: not this account's (owner SID {0}), left to the installation sweep: {1}" -f (& $sidOf $daemon), (& $describe $daemon))
  }
}

# What runs from THIS installation is ended whoever owns it: the installer is
# about to replace those very files, and the path alone says they are Timon's.
# That is the Node the package ships, wherever its script lives, and $Exe or
# node.exe running a file of the installation as Node: the daemon, its web
# server (resources\app\...\server.cjs), the browser helper of a mission
# (bin\browser-mcp.mjs), the terminal host (detached on purpose). No tree
# reaches the last three once the daemon is gone, and they kept the installer
# looping on "Timon cannot be closed" after the user had quit the app (0.1.5
# update, 22/10/2026). The window and Electron's own helpers (--type=) carry
# none of these paths. Two passes: a child whose parent went first in a pass
# has no tree left to be ended with.
$shipped = "$root\resources\node\"
$needles = @("$root\resources\orchestrator\", "$root\resources\app\")
$fromInstallation = {
  param($process)
  if (-not $root -or $process.ProcessId -eq $PID) { return $false }
  if ($process.ExecutablePath -and $process.ExecutablePath.ToLowerInvariant().StartsWith($shipped)) { return $true }
  if ($runtimes -notcontains $process.Name -or -not $process.CommandLine -or $process.CommandLine.Contains('--type=')) { return $false }
  $line = $process.CommandLine.ToLowerInvariant()
  foreach ($needle in $needles) { if ($line.Contains($needle)) { return $true } }
  $false
}
$ofInstallation = { & $processes | Where-Object { & $fromInstallation $_ } }
foreach ($pass in 1..2) {
  $found = @(& $ofInstallation)
  & $note ("pause: installation sweep {0}: {1} process(es)" -f $pass, $found.Count)
  if ($found.Count -eq 0) { break }
  $found | ForEach-Object { & $end $_ 'a process of this installation' }
  Start-Sleep -Seconds 1
}

# The installer deletes its plugins directory on exit: the resume phase runs
# from its own copy.
$copy = Join-Path ([IO.Path]::GetTempPath()) ("timon-service-resume-{0}.ps1" -f $InstallerPid)
# "Retry" in the installer runs this phase again: one resume already waits for
# that installer, and a second would only do the same thing twice.
$waiting = @(& $processes | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -and $_.CommandLine.Contains($copy) })
if ($waiting.Count -gt 0) {
  & $note ("pause: the resume already waits for the installer (pid {0})" -f $waiting[0].ProcessId)
} else {
  try {
    Copy-Item -LiteralPath $PSCommandPath -Destination $copy -Force -ErrorAction Stop
  } catch { & $note "pause: the resume script could not be copied: $($_.Exception.Message)" }
  $powershell = Join-Path $PSHOME 'powershell.exe'
  $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$copy`" -Resume " +
    "-InstallerPid $InstallerPid -Exe `"$Exe`""
  # An empty quoted value is dropped from a -File command line, and -Log would
  # then swallow nothing and fail the whole resume.
  if ($Log) { $arguments += " -Log `"$Log`"" }
  # A child of this process stays in its job object and dies with it: an SSH
  # session's job took the waiting resume down with it (VM, 06/11/2026). WMI
  # creates the process from its own service, outside any job, with this
  # process's token (the elevation it holds) and its window hidden from the start.
  $created = $null
  try {
    $startup = New-CimInstance -CimClass (Get-CimClass -ClassName Win32_ProcessStartup) -Property @{ ShowWindow = [uint16]0 } -ClientOnly
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -ErrorAction Stop -Arguments @{
      CommandLine = "`"$powershell`" $arguments"; ProcessStartupInformation = $startup
    }
  } catch { & $note "pause: WMI could not start the resume: $($_.Exception.Message)" }
  if ($created -and $created.ReturnValue -eq 0) {
    & $note ("pause: resume started (pid {0})" -f $created.ProcessId)
  } else {
    $result = 'no answer'
    if ($created) { $result = $created.ReturnValue }
    & $note ("pause: WMI could not start the resume (result {0}), started as a child" -f $result)
    try {
      Start-Process -WindowStyle Hidden -FilePath $powershell -ArgumentList $arguments -ErrorAction Stop
    } catch { & $note "pause: the resume could not be started at all, the task stays disabled: $($_.Exception.Message)" }
  }
}

# The net. Everything above can miss: an elevation that was refused leaves a
# session-0 daemon out of reach, and a filter can be wrong again. Before the
# installer replaces a single file, what is left is listed once more: the
# processes of this installation, and whoever listens on the daemon's port.
# Windows renames a running executable without complaint, so a daemon left
# alive keeps serving the old version from memory, holds the port and the data
# directory, and the new one never starts (0.1.7 to 0.1.8 update).
$remaining = {
  $left = @(& $ofInstallation)
  $owners = @()
  # Read without elevation too, unlike a command line: it is what still sees a
  # session-0 daemon from an installer that was refused its elevation. No
  # listener at all is an error to this command, and the expected answer here.
  try { $owners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique) } catch { }
  foreach ($id in $owners) {
    $listener = $null
    try { $listener = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction Stop } catch { }
    if (-not $listener -or $runtimes -notcontains $listener.Name) { continue }
    if (@($left | Where-Object { $_.ProcessId -eq $listener.ProcessId }).Count -gt 0) { continue }
    # A command line that cannot be read is a process of session 0 seen without
    # elevation: on this port and under this name, the daemon. One that can be
    # read counts when it is a daemon, unless it is proven to be another
    # account's; a foreign program on the port is not Timon's to wait for.
    if (-not $listener.CommandLine) { $left += $listener; continue }
    if (-not $listener.CommandLine.ToLowerInvariant().Contains('\dist\boot.js')) { continue }
    $owner = & $sidOf $listener
    if (-not $owner -or $owner -eq $account) { $left += $listener }
  }
  $left
}
& $note ("pause: checking what is left, daemon port {0} (from {1})" -f $port, $portSource)
$left = @()
foreach ($check in 1..5) {
  $left = @(& $remaining)
  if ($left.Count -eq 0) { break }
  # A process that was just ended takes a moment to leave the list.
  if ($check -lt 5) { Start-Sleep -Seconds 1 }
}
if ($left.Count -gt 0) {
  foreach ($process in $left) { & $note ("pause: still running: {0}" -f (& $describe $process)) }
  & $note ("pause: exit {0}, {1} process(es) of Timon still run: the installer must not go on" -f $stillRunning, $left.Count)
  exit $stillRunning
}
& $note 'pause: exit 0, nothing of Timon runs any more'
exit 0
