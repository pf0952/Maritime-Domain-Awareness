# ENC 3D installer: sets everything up, downloads and prepares all the charts and the world's data, and puts a shortcut
# on the desktop. Run "Install ENC 3D.bat". It can be stopped and run again: what's done already is skipped.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Ask($question, $yes) {
    $answer = Read-Host "$question $(if ($yes) { '[Y/n]' } else { '[y/N]' })"
    if ($answer -eq "") { return $yes }
    return $answer -match "^[Yy]"
}

function Have($command) { return [bool](Get-Command $command -ErrorAction SilentlyContinue) }

# Python and Node: from Windows' own package manager if they're missing, with the user's say-so
foreach ($tool in @(@{ Command = "python"; Name = "Python 3.12"; Id = "Python.Python.3.12" }, @{ Command = "node"; Name = "Node.js LTS"; Id = "OpenJS.NodeJS.LTS" })) {
    if (-not (Have $tool.Command)) {
        if ((Have "winget") -and (Ask "$($tool.Name) isn't installed. Install it with winget?" $true)) {
            winget install --id $tool.Id --exact --accept-package-agreements --accept-source-agreements
            $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
        }
        if (-not (Have $tool.Command)) { throw "$($tool.Name) is needed: install it, then run this again." }
    }
}

Write-Host "Setting up Python..."
if (-not (Test-Path "backend\.venv\Scripts\python.exe")) { python -m venv backend\.venv }
backend\.venv\Scripts\python -m pip install --disable-pip-version-check -q -r backend\requirements.txt
if ($LASTEXITCODE) { throw "Python packages didn't install" }

Write-Host "Building the viewer..."
Push-Location frontend
npm ci --no-fund --no-audit
if ($LASTEXITCODE) { Pop-Location; throw "The viewer's packages didn't install" }
npm run build
if ($LASTEXITCODE) { Pop-Location; throw "The viewer didn't build" }
Pop-Location

Write-Host ""
Write-Host "Next: download NOAA's charts and the world's seabed and coast (about 6 GB), and prepare everything, so the map"
Write-Host "never waits as you zoom and pan. The first time, that's some hours; it can be stopped and picked up later."
if (Ask "Download and prepare everything now?" $true) {
    $fine = Ask "The finest seabed and coast worldwide too? Several hours more, and some tens of GB; without, they're made in under a second each as first seen." $false
    backend\.venv\Scripts\python backend\prepare.py $(if ($fine) { "--fine" })
}

# a shortcut on the desktop to start it, in a minimised window: closing that stops it
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath("Desktop")) "ENC 3D.lnk"))
$link.TargetPath = Join-Path $PSScriptRoot "start.bat"
$link.WorkingDirectory = $PSScriptRoot
$link.WindowStyle = 7
$link.Description = "ENC 3D chart viewer"
$link.Save()
Write-Host ""
Write-Host "Done. Start it from the ENC 3D shortcut on the desktop."
