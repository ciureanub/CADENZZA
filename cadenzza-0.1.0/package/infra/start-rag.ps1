<#
.SYNOPSIS
  Start the local RAG services (MongoDB, Qdrant, Ollama) on 127.0.0.1.
.DESCRIPTION
  Idempotent: a service that is already listening on its port is left alone and reported.
  Creates data/log dirs under CADENZZA_HOME\rag. Never deletes anything.
#>
. "$PSScriptRoot\rag-env.ps1"

foreach ($d in @($RunDir, $LogDir, (Join-Path $RagDir 'mongo'), (Join-Path $RagDir 'qdrant\storage'), (Join-Path $RagDir 'qdrant\snapshots'))) {
  New-Item -ItemType Directory -Force $d | Out-Null
}

# Run $Exe hidden with extra env vars set only for the child; return the process.
function Start-Child($Name, $Exe, $ArgList, $EnvVars, $WorkDir) {
  $saved = @{}
  foreach ($k in $EnvVars.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process'); [Environment]::SetEnvironmentVariable($k, $EnvVars[$k], 'Process') }
  try {
    $p = Start-Process -FilePath $Exe -ArgumentList $ArgList -WorkingDirectory $WorkDir -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput (Join-Path $LogDir "$Name.out.log") -RedirectStandardError (Join-Path $LogDir "$Name.err.log")
  } finally {
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
  }
  Set-Content -Path (Join-Path $RunDir "$Name.pid") -Value $p.Id -Encoding ascii
  return $p
}

function Wait-Port([int]$Port, [int]$Seconds) {
  for ($i = 0; $i -lt ($Seconds * 4); $i++) {
    if (Get-Listeners $Port) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

$failed = $false
foreach ($name in $Services.Keys) {
  $svc = $Services[$name]
  $existing = @(Get-Listeners $svc.Port)
  if ($existing.Count) {
    "{0,-7} already running  pid {1,-6} {2}" -f $name, $existing[0].Pid, (($existing | ForEach-Object { "$($_.Address):$($_.Port)" }) -join ', ')
    continue
  }
  if (-not (Test-Path $svc.Exe)) { "{0,-7} MISSING  {1}" -f $name, $svc.Exe; $failed = $true; continue }

  switch ($name) {
    'mongo' {
      $argList = @('--dbpath', "`"$(Join-Path $RagDir 'mongo')`"", '--bind_ip', '127.0.0.1', '--port', '27017',
                   '--replSet', 'cadenzza', '--logpath', "`"$(Join-Path $LogDir 'mongod.log')`"", '--logappend')
      $p = Start-Child $name $svc.Exe $argList @{} $RagDir
    }
    'qdrant' {
      $envVars = @{
        QDRANT__SERVICE__HOST            = '127.0.0.1'
        QDRANT__SERVICE__HTTP_PORT       = '6333'
        QDRANT__SERVICE__GRPC_PORT       = '6334'
        QDRANT__STORAGE__STORAGE_PATH    = (Join-Path $RagDir 'qdrant\storage')
        QDRANT__STORAGE__SNAPSHOTS_PATH  = (Join-Path $RagDir 'qdrant\snapshots')
        QDRANT__TELEMETRY_DISABLED       = 'true'
      }
      $p = Start-Child $name $svc.Exe @('--disable-telemetry') $envVars (Join-Path $RagDir 'qdrant')
    }
    'ollama' {
      $envVars = @{ OLLAMA_HOST = '127.0.0.1:11434'; OLLAMA_NO_CLOUD = '1' }
      $p = Start-Child $name $svc.Exe @('serve') $envVars $RagDir
    }
  }

  if (Wait-Port $svc.Port 30) {
    $l = @(Get-Listeners $svc.Port)
    "{0,-7} started          pid {1,-6} {2}" -f $name, $p.Id, (($l | ForEach-Object { "$($_.Address):$($_.Port)" }) -join ', ')
  } else {
    "{0,-7} FAILED to listen on {1} within 30 s - see {2}" -f $name, $svc.Port, $LogDir
    $failed = $true
  }
}

# Single-node replica set: enables multi-document transactions for atomic re-ingest.
if (Get-Listeners 27017) {
  Push-Location $PkgDir
  try { node $MongoAdmin init-rs } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { $failed = $true }
}

if ($failed) { exit 1 }
