// Pre-Launch Cleanup Script
// This script removes debug console.log statements while keeping console.error

const fs = require('fs');
const path = require('path');

const filesToClean = [
    'components/ScheduleInterviewModal.tsx',
    'components/CaregiverDashboard.tsx',
    'components/EmergencySOS.tsx'
];

const debugPatterns = [
    /console\.log\('🎬.*?\);/g,
    /console\.log\('👤.*?\);/g,
    /console\.log\('📅.*?\);/g,
    /console\.log\('👨‍⚕️.*?\);/g,
    /console\.log\('✅.*?\);/g,
    /console\.log\('🚀.*?\);/g,
    /console\.log\('🔍.*?\);/g,
    /console\.log\("Audio play failed".*?\);/g
];

console.log('🧹 Starting pre-launch cleanup...\n');

filesToClean.forEach(file => {
    const filePath = path.join(__dirname, '..', file);

    try {
        let content = fs.readFileSync(filePath, 'utf8');
        let originalLength = content.length;
        let removedCount = 0;

        debugPatterns.forEach(pattern => {
            const matches = content.match(pattern);
            if (matches) {
                removedCount += matches.length;
                content = content.replace(pattern, '// Debug log removed');
            }
        });

        if (removedCount > 0) {
            fs.writeFileSync(filePath, content, 'utf8');
            console.log(`✅ ${file}: Removed ${removedCount} debug logs`);
        } else {
            console.log(`✓  ${file}: No debug logs found`);
        }
    } catch (error) {
        console.error(`❌ ${file}: Error - ${error.message}`);
    }
});

console.log('\n✨ Cleanup complete!');
