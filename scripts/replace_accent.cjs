const fs = require('fs');
const path = require('path');

function walkDir(dir, callback) {
    fs.readdirSync(dir).forEach(f => {
        const dirPath = path.join(dir, f);
        const isDirectory = fs.statSync(dirPath).isDirectory();
        isDirectory ? walkDir(dirPath, callback) : callback(path.join(dir, f));
    });
}

let changedFiles = 0;

walkDir('./components/caregiver', function(filePath) {
    if (!filePath.endsWith('.tsx') && !filePath.endsWith('.ts')) return;
    
    let content = fs.readFileSync(filePath, 'utf8');
    let original = content;
    
    content = content.replace(/text-accent-/g, 'text-primary-');
    content = content.replace(/bg-accent-/g, 'bg-primary-');
    content = content.replace(/border-accent-/g, 'border-primary-');
    content = content.replace(/ring-accent-/g, 'ring-primary-');
    content = content.replace(/from-accent-/g, 'from-primary-');
    content = content.replace(/to-accent-/g, 'to-primary-');
    content = content.replace(/shadow-accent-/g, 'shadow-primary-');
    
    if (content !== original) {
        fs.writeFileSync(filePath, content, 'utf8');
        changedFiles++;
        console.log(`Updated ${filePath}`);
    }
});

console.log(`Successfully updated ${changedFiles} files in components/caregiver`);
