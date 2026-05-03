# Set Firebase Storage CORS Configuration
# Run this script in PowerShell

$bucketName = "careconnex-d4c8b.appspot.com"
$projectId = "careconnex-d4c8b"

$corsConfig = @"
{
  "cors": [
    {
      "origin": ["https://careconnex-d4c8b.web.app", "http://localhost:5173"],
      "method": ["GET", "POST", "PUT", "DELETE", "HEAD"],
      "maxAgeSeconds": 3600,
      "responseHeader": ["Content-Type", "Authorization", "x-goog-resumable"]
    }
  ]
}
"@

Write-Host "📋 Firebase Storage CORS Configuration" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Bucket: $bucketName" -ForegroundColor Yellow
Write-Host ""
Write-Host "CORS Configuration:" -ForegroundColor Green
$corsConfig | ConvertFrom-Json | ConvertTo-Json -Depth 10
Write-Host ""

# Check if gcloud is available
$gcloud = Get-Command gcloud -ErrorAction SilentlyContinue
if ($gcloud) {
    Write-Host "✅ gcloud found! Setting CORS..." -ForegroundColor Green
    $corsConfig | Out-File -FilePath "cors-temp.json" -Encoding utf8
    gcloud storage buckets update gs://$bucketName --cors-file=cors-temp.json
    Remove-Item cors-temp.json
} else {
    Write-Host "⚠️  gcloud not found. Install Google Cloud SDK:" -ForegroundColor Yellow
    Write-Host "   https://cloud.google.com/sdk/docs/install" -ForegroundColor Gray
    Write-Host ""
    Write-Host "📖 OR use Google Cloud Console (easiest):" -ForegroundColor Cyan
    Write-Host "   https://console.cloud.google.com/storage/browser/$bucketName" -ForegroundColor Blue
    Write-Host ""
    Write-Host "Steps:" -ForegroundColor White
    Write-Host "1. Click the bucket name" -ForegroundColor Gray
    Write-Host "2. Go to 'Configuration' tab" -ForegroundColor Gray
    Write-Host "3. Click 'Edit' on CORS configuration" -ForegroundColor Gray
    Write-Host "4. Paste the JSON above" -ForegroundColor Gray
    Write-Host "5. Click 'Save'" -ForegroundColor Gray
}
