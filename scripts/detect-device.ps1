<#
.SYNOPSIS
  Find an Ajazz AKP03 / Mirabox N3-family deck and report its PID.

.DESCRIPTION
  opendeck-akp03 keys off USB PID, and the AKP03 ships under several. Run this
  with the deck plugged in; the PID it prints is what must appear in the
  plugin's supported list. If your PID is NOT listed as known below, that is the
  single most likely reason OpenDeck never sees the device.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\detect-device.ps1
#>

# PIDs claimed by 4ndv/opendeck-akp03 as of v0.4.x.
$known = @{
  '0300:1001' = 'Ajazz AKP03'
  '0300:1002' = 'Ajazz AKP03E'
  '0300:1003' = 'Ajazz AKP03R'
  '0300:3002' = 'Ajazz AKP03E (rev 2)'
  '0300:3003' = 'Ajazz AKP03R (rev 2)'
  '6602:1002' = 'Mirabox N3'
  '6603:1002' = 'Mirabox N3EN'
  '6603:1003' = 'Mirabox N3 (variant)'
  '1500:3001' = 'Mirabox HSV293S'
  '0B00:1001' = 'Ajazz (rebrand)'
  '5548:1001' = 'Soomfon Stream Controller SE'
  '0200:2000' = 'Redragon Skyrider SS-551'
}

$vendors = '0300|6602|6603|1500|0B00|5548|0200'
$found = Get-PnpDevice -PresentOnly |
  Where-Object { $_.InstanceId -match "VID_($vendors)" } |
  ForEach-Object {
    if ($_.InstanceId -match 'VID_([0-9A-F]{4})&PID_([0-9A-F]{4})') {
      [pscustomobject]@{
        Id      = "$($Matches[1]):$($Matches[2])".ToUpper()
        Name    = $_.FriendlyName
        Status  = $_.Status
        Class   = $_.Class
      }
    }
  } | Sort-Object Id -Unique

if (-not $found) {
  Write-Host "No AKP03-family device found." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Check, in order:"
  Write-Host "  1. Deck plugged in via a DATA cable (charge-only cables enumerate nothing)"
  Write-Host "  2. Try a port directly on the machine, not through a hub"
  Write-Host "  3. Close the official Ajazz software — it can hold the HID handle open"
  exit 1
}

Write-Host ""
foreach ($d in $found) {
  $label = $known[$d.Id]
  if ($label) {
    Write-Host "  [OK]  $($d.Id)  $label" -ForegroundColor Green
    Write-Host "        $($d.Name)  ($($d.Class), $($d.Status))" -ForegroundColor DarkGray
  } else {
    Write-Host "  [??]  $($d.Id)  UNKNOWN to opendeck-akp03" -ForegroundColor Yellow
    Write-Host "        $($d.Name)  ($($d.Class), $($d.Status))" -ForegroundColor DarkGray
    Write-Host "        This PID is not in the plugin's list, so OpenDeck will ignore it." -ForegroundColor Yellow
    Write-Host "        Report it at https://github.com/4ndv/opendeck-akp03/issues" -ForegroundColor DarkGray
  }
}
Write-Host ""
