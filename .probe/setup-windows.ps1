# Probe 262: prepare non-default filesystem roots on windows-latest.
# Every step is best-effort: failures land in mount-status.txt.
$ErrorActionPreference = 'Continue'
$rt = $env:RUNNER_TEMP
$roots = Join-Path $rt 'roots.txt'
$status = Join-Path $rt 'mount-status.txt'
$base = Join-Path $rt 'probe262-roots'
Remove-Item $roots, $status -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $base 'local') | Out-Null
Add-Content $roots "local=$((Join-Path $base 'local'))"
Add-Content $status "local=ok"

# Long path policy, recorded rather than assumed.
$lp = Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -ErrorAction SilentlyContinue
Add-Content $status "longPathsEnabled=$($lp.LongPathsEnabled)"

# SMB share reached through a UNC path: driver-level UNC, not a mapped drive.
New-Item -ItemType Directory -Force -Path (Join-Path $base 'share') | Out-Null
try {
  New-SmbShare -Name 'probe262' -Path (Join-Path $base 'share') -FullAccess "$env:USERNAME" -ErrorAction Stop | Out-Null
  Add-Content $roots 'smb=\\localhost\probe262'
  Add-Content $status 'smb=ok'
} catch {
  Add-Content $status "smb=fail:$($_.Exception.Message)"
}

# An 8.3 short-path root, for the short-path contrast case.
$short = Join-Path $base 'short-root'
New-Item -ItemType Directory -Force -Path $short | Out-Null
$fso = New-Object -ComObject Scripting.FileSystemObject
try {
  $shortPath = $fso.GetFolder($short).ShortPath
  # Recorded, not probed: this runner's temp volume has 8.3 names disabled, so the
  # "short" path equals the long one and cannot exercise the abort.
  Add-Content $status "short=$shortPath"
} catch {
  Add-Content $status "short=fail:$($_.Exception.Message)"
}

# The same volume reached through the administrative share: UNC without SMB server.
$uncDir = Join-Path $env:SystemDrive 'probe262-unc'
New-Item -ItemType Directory -Force -Path $uncDir | Out-Null
$drive = $env:SystemDrive.TrimEnd(':')
Add-Content $roots ('unc=\\localhost\' + $drive + '$\probe262-unc')
Add-Content $status "unc=ok:$uncDir"

Write-Output '--- roots'; Get-Content $roots
Write-Output '--- status'; Get-Content $status
