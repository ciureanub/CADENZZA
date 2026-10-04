# Shared settings for start/stop/status-rag.ps1. Dot-source this file; do not run it.
# Everything binds to 127.0.0.1. Data lives under CADENZZA_HOME\rag (back it up, never commit it).

$CadHome = if ($env:CADENZZA_HOME) { $env:CADENZZA_HOME } else { Join-Path $env:USERPROFILE '.cadenzza' }
$RagDir  = Join-Path $CadHome 'rag'
$RunDir  = Join-Path $RagDir 'run'
$LogDir  = Join-Path $RagDir 'logs'
$BinDir  = if ($env:CADENZZA_BIN) { $env:CADENZZA_BIN } else { Join-Path $env:LOCALAPPDATA 'cadenzza\bin' }
$PkgDir  = Split-Path $PSScriptRoot -Parent
$MongoAdmin = Join-Path $PSScriptRoot 'mongo-admin.mjs'

$Services = [ordered]@{
  mongo  = @{ Port = 27017; Exe = (Join-Path $BinDir 'mongod.exe') }
  qdrant = @{ Port = 6333;  Exe = (Join-Path $BinDir 'qdrant.exe') }
  ollama = @{ Port = 11434; Exe = (Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe') }
}

# Every TCP listener on a port, IPv4 and IPv6: @{ Address; Port; Pid }
function Get-Listeners([int]$Port) {
  foreach ($line in (netstat -ano)) {
    if ($line -match "^\s*TCP\s+(\S+):$Port\s+\S+\s+LISTENING\s+(\d+)\s*$") {
      [pscustomobject]@{ Address = $Matches[1]; Port = $Port; Pid = [int]$Matches[2] }
    }
  }
}

function Test-Loopback([string]$Address) {
  return ($Address -like '127.*' -or $Address -eq '[::1]')
}

function Get-ProcPath([int]$ProcId) {
  $p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
  if ($p) { return $p.Path } else { return $null }
}
