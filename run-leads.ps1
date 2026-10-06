# Finds new leads on this PC: OpenStreetMap first, then Google Maps. Leads are
# saved to the database and nothing else happens here.
#
# Auditing and email drafts are automated on GitHub ("Process leads", every
# 4 hours, or Run now on refactrix.com/powerbox/automation). Nothing is
# emailed without approval on the Emails page.
#
# Start it by double-clicking "Run Leads.cmd". Needs Node.js 24 and the .env
# file in this folder (the same one the scripts always use).

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = 'Refactrix - Find new leads'

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Fail($text) {
    Say ''
    Say $text 'Red'
    exit 1
}

Say ''
Say '  REFACTRIX - FIND NEW LEADS' 'Cyan'
Say '  Searches OpenStreetMap, then Google Maps, and saves new leads.' 'Cyan'
Say '  Auditing and email drafts then happen automatically online.' 'Cyan'
Say ''

# --- Checks -------------------------------------------------------------------

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js is not installed. Install Node.js 24 LTS from https://nodejs.org, then run this again.' }
$major = [int]((& node --version).TrimStart('v').Split('.')[0])
if ($major -lt 24) { Fail "Node.js $major is too old. Install Node.js 24 LTS from https://nodejs.org, then run this again." }

if (-not (Test-Path -LiteralPath '.env')) {
    Fail 'The .env file is missing from this folder. Ask Mohit for it; never share it or send it by chat.'
}

if (-not (Test-Path -LiteralPath 'node_modules')) {
    Say 'First run: installing packages (takes a minute)...' 'Yellow'
    $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
    & cmd /c 'npm ci --no-audit --no-fund'
    if ($LASTEXITCODE -ne 0) { Fail 'Installing packages failed. Check the internet connection and try again.' }
}

# Google Maps needs Playwright's browser. Quick when it's already installed.
# The project's own Playwright, so npx never offers to download another.
& cmd /c 'node node_modules\playwright\cli.js install chromium >nul 2>&1'
$browserReady = $LASTEXITCODE -eq 0

# --- How many -----------------------------------------------------------------

$answer = Read-Host 'How many new leads should OpenStreetMap look for? Press Enter for 30 (1-100)'
$max = 30
if ($answer.Trim()) {
    $n = 0
    if (-not [int]::TryParse($answer.Trim(), [ref]$n) -or $n -lt 1 -or $n -gt 100) {
        Fail 'Please enter a number from 1 to 100.'
    }
    $max = $n
}
# Google Maps is the secondary source, read slowly page by page
$googleMax = [math]::Min($max, 15)

# --- Run ----------------------------------------------------------------------

New-Item -ItemType Directory -Force -Path 'logs' | Out-Null
$log = Join-Path 'logs' ("leads-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmm'))

$script:stepNumber = 0
function Step($title, $file, $limit) {
    $script:stepNumber++
    Say ''
    Say "[$($script:stepNumber)/2] $title" 'Cyan'
    Say ('-' * 60) 'DarkGray'
    Add-Content -LiteralPath $log -Encoding UTF8 -Value "`n===== $title ($(Get-Date -Format 'HH:mm:ss')) ====="
    $env:MAX_NEW_LEADS = "$limit"
    # Through cmd so Node's error output arrives as plain text. Lines go to the
    # screen and the log only, so the function returns just the exit code.
    & cmd /c "node $file 2>&1" | ForEach-Object {
        Write-Host $_
        Add-Content -LiteralPath $log -Encoding UTF8 -Value $_
    }
    return $LASTEXITCODE
}

$started = Get-Date
$results = [ordered]@{}
$results['OpenStreetMap'] = Step "OpenStreetMap: up to $max new leads" 'leadfinder.js' $max
if ($browserReady) {
    $results['Google Maps'] = Step "Google Maps: up to $googleMax new leads" 'scraper.js' $googleMax
} else {
    Say ''
    Say '[2/2] Google Maps skipped: its browser could not be installed (check the internet connection).' 'Yellow'
    $results['Google Maps'] = 1
}

# --- Summary ------------------------------------------------------------------

$minutes = [math]::Round(((Get-Date) - $started).TotalMinutes, 1)
Say ''
Say ('=' * 60) 'DarkGray'
Say "  Finished in $minutes minutes" 'Cyan'
foreach ($r in $results.GetEnumerator()) {
    if ($r.Value -eq 0) { Say "  OK      $($r.Key)" 'Green' }
    else { Say "  PROBLEM $($r.Key) (details above and in the log)" 'Yellow' }
}
Say ''
Say "  Log saved to: $(Join-Path $PSScriptRoot $log)"
Say '  Next: new leads are audited and drafted automatically within 4 hours.'
Say '  To start that now: refactrix.com/powerbox/automation > Process leads > Run now'
Say ('=' * 60) 'DarkGray'
