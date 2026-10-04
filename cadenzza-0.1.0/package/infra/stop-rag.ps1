<#
.SYNOPSIS
  Stop the local RAG services started by start-rag.ps1.
.DESCRIPTION
  MongoDB is shut down cleanly through its admin command. Qdrant and Ollama are stopped by PID.
  Only processes whose executable matches the expected binary are touched; anything else on
  those ports is reported and left alone. Never deletes data.
.PARAMETER Only
  Stop only these services (mongo, qdrant, ollama).
#>
param([string[]]$Only)
. "$PSScriptRoot\rag-env.ps1"

foreach ($name in $Services.Keys) {
  if ($Only -and ($Only -notcontains $name)) { continue }
  $svc = $Services[$name]
  $listeners = @(Get-Listeners $svc.Port)
  if (-not $listeners.Count) { "{0,-7} not running" -f $name; continue }

  $procId = $listeners[0].Pid
  $exe = Get-ProcPath $procId
  if ($exe -and ($exe -ne $svc.Exe)) {
    "{0,-7} SKIPPED  pid {1} is {2}, not {3}" -f $name, $procId, $exe, $svc.Exe
    continue
  }

  if ($name -eq 'mongo') {
    Push-Location $PkgDir
    try { node $MongoAdmin shutdown | Out-Null } finally { Pop-Location }
  } else {
    Stop-Process -Id $procId -Confirm:$false -ErrorAction SilentlyContinue
  }

  $gone = $false
  for ($i = 0; $i -lt 60; $i++) {
    if (-not (Get-Listeners $svc.Port)) { $gone = $true; break }
    Start-Sleep -Milliseconds 250
  }
  if ($gone) { "{0,-7} stopped  pid {1}" -f $name, $procId } else { "{0,-7} STILL RUNNING  pid {1}" -f $name, $procId }
  Remove-Item (Join-Path $RunDir "$name.pid") -ErrorAction SilentlyContinue
}
