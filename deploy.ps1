# CareConnex Firebase Deployment Script
# Run this AFTER installing Firebase CLI and logging in

Write-Host "🚀 CareConnex Deployment Script" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan
Write-Host ""

# Check if Firebase CLI is installed
Write-Host "Checking Firebase CLI..." -ForegroundColor Yellow
try {
    $firebaseVersion = firebase --version
    Write-Host "✅ Firebase CLI installed: $firebaseVersion" -ForegroundColor Green
} catch {
    Write-Host "❌ Firebase CLI not found. Please install it first:" -ForegroundColor Red
    Write-Host "   npm install -g firebase-tools" -ForegroundColor White
    exit 1
}

# Check if logged in
Write-Host ""
Write-Host "Checking Firebase login..." -ForegroundColor Yellow
try {
    firebase projects:list | Out-Null
    Write-Host "✅ Logged in to Firebase" -ForegroundColor Green
} catch {
    Write-Host "❌ Not logged in. Please run:" -ForegroundColor Red
    Write-Host "   firebase login" -ForegroundColor White
    exit 1
}

# Verify project
Write-Host ""
Write-Host "Verifying project..." -ForegroundColor Yellow
$currentProject = firebase use
if ($currentProject -match "careconnex-d4c8b") {
    Write-Host "✅ Using project: careconnex-d4c8b" -ForegroundColor Green
} else {
    Write-Host "⚠️  Switching to careconnex-d4c8b..." -ForegroundColor Yellow
    firebase use careconnex-d4c8b
}

# Step 1: Install function dependencies
Write-Host ""
Write-Host "📦 Installing function dependencies..." -ForegroundColor Cyan
Set-Location "functions"
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Failed to install dependencies" -ForegroundColor Red
    exit 1
}
Write-Host "✅ Dependencies installed" -ForegroundColor Green

# Step 2: Build functions
Write-Host ""
Write-Host "🔨 Building TypeScript functions..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Build failed. Check TypeScript errors above." -ForegroundColor Red
    exit 1
}
Write-Host "✅ Build successful" -ForegroundColor Green

# Step 3: Deploy functions
Write-Host ""
Write-Host "🚀 Deploying Cloud Functions..." -ForegroundColor Cyan
Write-Host "   This may take 3-5 minutes..." -ForegroundColor Yellow
Set-Location ".."
# Functions take ~4s to load; Firebase's default 10s discovery timeout can fail
# silently in its slower sandbox, leaving function updates undeployed. Raise it.
$env:FUNCTIONS_DISCOVERY_TIMEOUT = "120"
firebase deploy --only functions
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Function deployment failed" -ForegroundColor Red
    Write-Host "   Common issues:" -ForegroundColor Yellow
    Write-Host "   - Billing not enabled (need Blaze plan)" -ForegroundColor White
    Write-Host "   - STRIPE_SECRET_KEY not set" -ForegroundColor White
    exit 1
}
Write-Host "✅ Functions deployed successfully" -ForegroundColor Green

# Step 4: Deploy Firestore rules
Write-Host ""
Write-Host "🔒 Deploying Firestore security rules..." -ForegroundColor Cyan
firebase deploy --only firestore:rules
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Rules deployment failed" -ForegroundColor Red
    exit 1
}
Write-Host "✅ Rules deployed" -ForegroundColor Green

# Step 5: Deploy Firestore indexes
Write-Host ""
Write-Host "📊 Deploying Firestore indexes..." -ForegroundColor Cyan
firebase deploy --only firestore:indexes
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Index deployment failed" -ForegroundColor Red
    exit 1
}
Write-Host "✅ Indexes deployed (building in background)" -ForegroundColor Green

# Step 5: Verify deployment
Write-Host ""
Write-Host "🔍 Verifying deployment..." -ForegroundColor Cyan
Write-Host ""
Write-Host "Functions:" -ForegroundColor Yellow
firebase functions:list

Write-Host ""
Write-Host "Indexes:" -ForegroundColor Yellow
firebase firestore:indexes

# Summary
Write-Host ""
Write-Host "================================" -ForegroundColor Cyan
Write-Host "✅ Deployment Complete!" -ForegroundColor Green
Write-Host "================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1. Wait 5-10 minutes for indexes to build" -ForegroundColor White
Write-Host "2. Test notifications by creating an appointment" -ForegroundColor White
Write-Host "3. Check function logs: firebase functions:log" -ForegroundColor White
Write-Host "4. Monitor Firebase Console:" -ForegroundColor White
Write-Host "   https://console.firebase.google.com/project/careconnex-d4c8b" -ForegroundColor Cyan
Write-Host ""
