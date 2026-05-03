const fs = require('fs');
const path = require('path');

const walkSync = (dir, filelist = []) => {
  fs.readdirSync(dir).forEach(file => {
    const dirFile = path.join(dir, file);
    if (fs.statSync(dirFile).isDirectory()) {
      filelist = walkSync(dirFile, filelist);
    } else {
      if (dirFile.endsWith('.tsx') || dirFile.endsWith('.ts')) {
        filelist.push(dirFile);
      }
    }
  });
  return filelist;
};

const files = walkSync('./components');

const replacePatterns = [
  { regex: /teal-/g, replacement: 'primary-' },
  { regex: /amber-/g, replacement: 'accent-' },
  { regex: /orange-/g, replacement: 'accent-' }
];

let modifiedCount = 0;

files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  let originalContent = content;

  // We only replace if preceded by text, bg, border, ring, from, to, shadow, hover:, focus:, etc.
  // Actually, in a React app, it's safer to just replace any instance of 'teal-', 'amber-', 'orange-'
  // that is followed by a number (like 50, 100, 500) within strings.
  
  // A safe regex: /(bg|text|border|ring|from|to|shadow|divide|fill|stroke|outline|hover:[a-z]+|focus:[a-z]+|active:[a-z]+)-(teal|amber|orange)-(\d{2,3})(?=\s|"|'|`|\/|\)|\])/g
  const safeRegex = /((?:bg|text|border|ring|from|to|shadow|divide|fill|stroke|outline)(?:-\w+)?|hover:\w+|focus:\w+|active:\w+)-(teal|amber|orange)-(\d{2,3})/g;
  
  content = content.replace(safeRegex, (match, prefix, color, shade) => {
      let newColor = color === 'teal' ? 'primary' : 'accent';
      return `${prefix}-${newColor}-${shade}`;
  });

  // Handle bare classes like "teal-600" if they occur inside template literals sometimes without standard prefix
  // e.g. `border ${isActive ? 'teal-500' : 'slate-200'}`
  const bareRegex = /(?<=['"`\s])(teal|amber|orange)-(\d{2,3})(?=['"`\s])/g;
  content = content.replace(bareRegex, (match, color, shade) => {
      let newColor = color === 'teal' ? 'primary' : 'accent';
      return `${newColor}-${shade}`;
  });

  if (content !== originalContent) {
    fs.writeFileSync(file, content, 'utf8');
    modifiedCount++;
    console.log(`Updated ${file}`);
  }
});

console.log(`\nFinished! Updated ${modifiedCount} files.`);
