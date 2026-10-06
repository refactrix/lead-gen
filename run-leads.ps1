# Runs the whole lead pipeline on this PC: find new leads, audit their
# websites, then draft emails for review. Nothing is emailed: approve drafts
# on refactrix.com/powerbox/emails, then send from the Automation page.
#
# Start it by double-clicking "Run Leads.cmd". Needs Node.js 24 and the .env
# file in this folder (the same one the scripts always use).

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = 'Refactrix - Find and process leads'

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Fail($text) {
    Say ''
    Say $text 'Red'
    exit 1
}

Say ''
Say '  REFACTRIX LEAD PIPELINE' 'Cyan'
Say '  Finds new leads, audits their websites and drafts emails.' 'Cyan'
Say '  Nothing is sent. Drafts wait for review on the Emails page.' 'Cyan'
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

# --- How many -----------------------------------------------------------------

$answer = Read-Host 'How many new leads should it look for? Press Enter for 30 (1-100)'
$max = 30
if ($answer.Trim()) {
    $n = 0
    if (-not [int]::TryParse($answer.Trim(), [ref]$n) -or $n -lt 1 -or $n -gt 100) {
        Fail 'Please enter a number from 1 to 100.'
    }
    $max = $n
}
$env:MAX_NEW_LEADS = "$max"

# --- Run ----------------------------------------------------------------------

New-Item -ItemType Directory -Force -Path 'logs' | Out-Null
$log = Join-Path 'logs' ("leads-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmm'))

function Step($number, $title, $script) {
    Say ''
    Say "[$number/3] $title" 'Cyan'
    Say ('-' * 60) 'DarkGray'
    Add-Content -LiteralPath $log -Encoding UTF8 -Value "`n===== $title ($(Get-Date -Format 'HH:mm:ss')) ====="
    # Through cmd so Node's error output arrives as plain text. Lines go to the
    # screen and the log only, so the function returns just the exit code.
    & cmd /c "node $script 2>&1" | ForEach-Object {
        Write-Host $_
        Add-Content -LiteralPath $log -Encoding UTF8 -Value $_
    }
    return $LASTEXITCODE
}

$started = Get-Date
$results = [ordered]@{}
$results['Find new leads'] = Step 1 'Finding new leads (OpenStreetMap + business websites)' 'leadfinder.js'
# Audit and drafting run even if some search areas failed, like on GitHub
$results['Audit websites'] = Step 2 'Auditing websites' 'analyzer.js'
$results['Draft emails'] = Step 3 'Drafting emails' 'emailgen.js'

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
Say '  Next: review the drafts at https://www.refactrix.com/powerbox/emails'
Say ('=' * 60) 'DarkGray'
