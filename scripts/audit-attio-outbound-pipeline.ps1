$ErrorActionPreference = 'Stop'

$apiKey = $env:ATTIO_API_KEY
if (-not $apiKey) { throw 'ATTIO_API_KEY is not set.' }

$headers = @{ Authorization = "Bearer $apiKey"; 'Content-Type' = 'application/json' }
$base = 'https://api.attio.com/v2'
# This stable list ID is the company-parented outbound pipeline used by the existing KPI integration.
$listId = '7ac0b11c-204e-4c25-a744-e306606f6aa4'

function Read-Title($value) {
  if (-not $value -or $value.Count -eq 0) { return $null }
  $first = $value[0]
  if ($first.status.title) { return [string]$first.status.title }
  if ($first.option.title) { return [string]$first.option.title }
  if ($null -ne $first.value) { return [string]$first.value }
  return $null
}

function Read-Date($values) {
  if (-not $values -or $values.Count -eq 0) { return $null }
  return [string]$values[0].value
}

function Read-Bool($values) {
  return [bool]($values -and $values.Count -gt 0 -and $values[0].value -eq $true)
}

$entries = @()
$cursor = $null
do {
  $payload = @{ limit = 500 }
  if ($cursor) { $payload.cursor = $cursor }
  $response = Invoke-RestMethod -Method Post -Uri "$base/lists/$listId/entries/query" -Headers $headers -Body ($payload | ConvertTo-Json -Compress)
  $entries += @($response.data)
  $cursor = $response.next_cursor
} while ($cursor)

$byCompany = @{}
$duplicateEntries = @()
foreach ($entry in $entries) {
  $companyId = $entry.parent_record_id
  if (-not $companyId) { continue }
  $stage = Read-Title $entry.entry_values.stage
  if (-not $stage) { $stage = 'Unprocessed' }
  if ($byCompany.ContainsKey($companyId)) {
    $duplicateEntries += [pscustomobject]@{ company_id = $companyId; kept_entry_id = $byCompany[$companyId].entry_id; duplicate_entry_id = $entry.id.entry_id; stage = $stage }
    continue
  }
  $byCompany[$companyId] = [pscustomobject]@{ entry_id = $entry.id.entry_id; stage = $stage; created_at = $entry.created_at }
}

$records = @()
$ids = @($byCompany.Keys)
for ($i = 0; $i -lt $ids.Count; $i += 100) {
  $slice = @($ids[$i..([Math]::Min($i + 99, $ids.Count - 1))])
  $payload = @{ filter = @{ record_id = @{ '$in' = $slice } }; limit = 100 }
  $response = Invoke-RestMethod -Method Post -Uri "$base/objects/companies/records/query" -Headers $headers -Body ($payload | ConvertTo-Json -Depth 10 -Compress)
  $records += @($response.data)
}

$requirements = [ordered]@{
  'Unprocessed' = @()
  'Not qualified' = @('disqualified_at')
  'Qualified' = @('qualified_at')
  'Meeting Booked' = @('qualified_at', 'meeting_booked_at')
  'Demo Completed' = @('qualified_at', 'meeting_booked_at', 'demo_completed_at')
  'Trial' = @('qualified_at', 'meeting_booked_at', 'demo_completed_at', 'trial_started_at')
  'Won' = @('qualified_at', 'meeting_booked_at', 'demo_completed_at', 'trial_started_at', 'closed_won_at')
  'Lost' = @('qualified_at', 'meeting_booked_at', 'demo_completed_at', 'trial_started_at', 'closed_lost_at')
}
$dateFields = @('qualified_at', 'meeting_booked_at', 'demo_completed_at', 'trial_started_at', 'closed_won_at', 'closed_lost_at', 'disqualified_at')
$orderedDates = @('qualified_at', 'meeting_booked_at', 'demo_completed_at', 'trial_started_at', 'closed_won_at')

$issues = @()
$summary = @{}
foreach ($record in $records) {
  $id = $record.id.record_id
  $entry = $byCompany[$id]
  $stage = $entry.stage
  $values = $record.values
  $name = if ($values.name -and $values.name.Count) { [string]$values.name[0].value } else { 'Unknown company' }
  $domain = if ($values.domains -and $values.domains.Count) { [string]($values.domains[0].domain ?? $values.domains[0].value) } else { $null }
  $dates = @{}
  foreach ($field in $dateFields) { $dates[$field] = Read-Date $values.$field }
  $meetingStatus = Read-Title $values.meeting_status
  $meetingHeld = Read-Bool $values.meeting_held
  $companyIssues = @()

  if (-not $requirements.Contains($stage)) { $companyIssues += "unknown stage '$stage'" }
  else {
    foreach ($field in $requirements[$stage]) {
      if (-not $dates[$field]) { $companyIssues += "missing $field" }
    }
  }

  if ($stage -eq 'Meeting Booked' -and $meetingStatus -ne 'Booked') { $companyIssues += "meeting_status is '$meetingStatus' (expected Booked)" }
  if (@('Demo Completed','Trial','Won') -contains $stage -and $meetingStatus -ne 'Held') { $companyIssues += "meeting_status is '$meetingStatus' (expected Held)" }
  if (@('Demo Completed','Trial','Won') -contains $stage -and -not $meetingHeld) { $companyIssues += 'meeting_held is false/unset' }

  if ($stage -eq 'Unprocessed') {
    $unexpected = $dateFields | Where-Object { $dates[$_] }
    if ($unexpected) { $companyIssues += ('has lifecycle timestamps while unprocessed: ' + ($unexpected -join ', ')) }
  }
  if ($stage -eq 'Not qualified') {
    $unexpected = @('qualified_at','meeting_booked_at','demo_completed_at','trial_started_at','closed_won_at','closed_lost_at') | Where-Object { $dates[$_] }
    if ($unexpected) { $companyIssues += ('has post-disqualification lifecycle timestamps: ' + ($unexpected -join ', ')) }
  }
  if ($stage -eq 'Won' -and $dates['closed_lost_at']) { $companyIssues += 'has closed_lost_at as well as Won stage' }
  if ($stage -eq 'Lost' -and $dates['closed_won_at']) { $companyIssues += 'has closed_won_at as well as Lost stage' }

  $previous = $null
  foreach ($field in $orderedDates) {
    if (-not $dates[$field]) { continue }
    try { $current = [datetimeoffset]::Parse($dates[$field]) } catch { $companyIssues += "invalid $field date '$($dates[$field])'"; continue }
    if ($previous -and $current -lt $previous.value) { $companyIssues += "$field occurs before $($previous.field)" }
    $previous = @{ field = $field; value = $current }
  }
  if ($dates['disqualified_at'] -and ($dates['qualified_at'] -or $dates['meeting_booked_at'] -or $dates['demo_completed_at'] -or $dates['trial_started_at'] -or $dates['closed_won_at'] -or $dates['closed_lost_at'])) { $companyIssues += 'disqualified_at conflicts with lifecycle progression fields' }

  if (-not $summary.ContainsKey($stage)) { $summary[$stage] = @{ companies = 0; with_issues = 0 } }
  $summary[$stage].companies++
  if ($companyIssues.Count) {
    $summary[$stage].with_issues++
    $issues += [pscustomobject]@{ company = $name; domain = $domain; company_id = $id; entry_id = $entry.entry_id; stage = $stage; issues = ($companyIssues -join '; '); qualified_at = $dates['qualified_at']; meeting_booked_at = $dates['meeting_booked_at']; demo_completed_at = $dates['demo_completed_at']; trial_started_at = $dates['trial_started_at']; closed_won_at = $dates['closed_won_at']; closed_lost_at = $dates['closed_lost_at']; disqualified_at = $dates['disqualified_at']; meeting_status = $meetingStatus; meeting_held = $meetingHeld }
  }
}

[pscustomobject]@{
  audited_at = (Get-Date).ToUniversalTime().ToString('o')
  pipeline_entries = $entries.Count
  unique_companies = $records.Count
  stage_summary = $summary
  duplicate_entries = $duplicateEntries
  issues = $issues
} | ConvertTo-Json -Depth 10
