# Windows: the media sessions apps share with the system (the media controls
# shown with the volume): Spotify, browser tabs, Media Player, VLC...
# Run by scripts/media.mjs as a long-lived worker, so each request is quick:
# one JSON request per line on stdin, one JSON answer per line on stdout.
#
#   {"action":"list"}               -> {"players":[{"id":"Spotify.exe","status":"Playing"}]}
#   {"action":"pause","ids":[...]}  -> {"done":[...]}   the listed sessions that were playing and paused
#   {"action":"play","ids":[...]}   -> {"done":[...]}   the listed sessions that were paused and play again
#   on failure                      -> {"error":"..."}

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

# Windows Runtime calls are asynchronous: wait for each through a .NET task.
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await($operation, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
  if (-not $task.Wait(5000)) { throw 'Windows did not answer in time' }
  $task.Result
}

$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$manager = Await ($managerType::RequestAsync()) $managerType

function Status($session) { $session.GetPlaybackInfo().PlaybackStatus.ToString() }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try {
    $request = $line | ConvertFrom-Json
    $sessions = @($manager.GetSessions())
    if ($request.action -eq 'list') {
      $answer = @{ players = @($sessions | ForEach-Object { @{ id = $_.SourceAppUserModelId; status = (Status $_) } }) }
    } else {
      $ids = @($request.ids)
      $done = @()
      foreach ($session in $sessions) {
        $id = $session.SourceAppUserModelId
        if ($ids -notcontains $id) { continue }
        $status = Status $session
        if ($request.action -eq 'pause' -and $status -eq 'Playing') { $ok = Await ($session.TryPauseAsync()) ([bool]) }
        elseif ($request.action -eq 'play' -and $status -eq 'Paused') { $ok = Await ($session.TryPlayAsync()) ([bool]) }
        else { continue }
        if ($ok) { $done += $id }
      }
      $answer = @{ done = $done }
    }
  } catch {
    $answer = @{ error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine((ConvertTo-Json $answer -Compress -Depth 4))
  [Console]::Out.Flush()
}
