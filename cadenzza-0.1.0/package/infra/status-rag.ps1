<#
.SYNOPSIS
  Report the local RAG services: PID, bound addresses, loopback-only, health. Read-only.
#>
. "$PSScriptRoot\rag-env.ps1"

$exitCode = 0
foreach ($name in $Services.Keys) {
  $svc = $Services[$name]
  $ports = @($svc.Port)
  if ($name -eq 'qdrant') { $ports += 6334 }
  $listeners = @($ports | ForEach-Object { Get-Listeners $_ })

  if (-not $listeners.Count) { "{0,-7} DOWN" -f $name; $exitCode = 1; continue }

  $exposed = @($listeners | Where-Object { -not (Test-Loopback $_.Address) })
  $bind = ($listeners | ForEach-Object { "$($_.Address):$($_.Port)" }) -join ', '
  $health = switch ($name) {
    'mongo'  { Push-Location $PkgDir; try { (node $MongoAdmin ping 2>&1) -join ' ' } finally { Pop-Location } }
    'qdrant' { try { $r = Invoke-RestMethod 'http://127.0.0.1:6333/' -TimeoutSec 3; "ok qdrant $($r.version)" } catch { "FAIL $($_.Exception.Message)" } }
    'ollama' { try { $r = Invoke-RestMethod 'http://127.0.0.1:11434/api/version' -TimeoutSec 3; "ok ollama $($r.version)" } catch { "FAIL $($_.Exception.Message)" } }
  }
  $loop = if ($exposed.Count) { 'EXPOSED' } else { 'loopback' }
  "{0,-7} pid {1,-6} {2,-8} {3,-40} {4}" -f $name, $listeners[0].Pid, $loop, $bind, $health
  if ($exposed.Count -or $health -notlike 'ok*') { $exitCode = 1 }
}
"data: $RagDir"
exit $exitCode
