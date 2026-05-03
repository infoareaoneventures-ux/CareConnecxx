const fs = require('fs');
const path = require('path');

// Simple PNG generator for PWA icons
// In production, use a proper image library like sharp

const svgContent = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');

// Create a simple HTML file that will render the SVG and generate PNGs
const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <title>Generate Icons</title>
  <script src="https://html2canvas.hertzen.com/dist/html2canvas.min.js"></script>
</head>
<body>
  <div id="icon-container" style="width: 512px; height: 512px;">
    ${svgContent}
  </div>
  <script>
    async function generateIcons() {
      const sizes = [192, 512];
      for (const size of sizes) {
        const container = document.getElementById('icon-container');
        container.style.width = size + 'px';
        container.style.height = size + 'px';
        
        const canvas = await html2canvas(container, { scale: 1 });
        const dataUrl = canvas.toDataURL('image/png');
        
        // Download
        const link = document.createElement('a');
        link.download = 'icon-' + size + '.png';
        link.href = dataUrl;
        link.click();
      }
    }
    generateIcons();
  </script>
</body>
</html>
`;

console.log('To generate icons:');
console.log('1. Install a PNG generator: npm install -g sharp');
console.log('2. Or use an online SVG to PNG converter');
console.log('');
console.log('For now, using placeholder approach with base64-encoded simple PNGs...');

// Create minimal valid PNG files (1x1 teal pixel scaled up won't work well)
// Instead, let's create a Node script that uses canvas if available

const canvasScript = `
const { createCanvas } = require('canvas');
const fs = require('fs');

const sizes = [192, 512];

sizes.forEach(size => {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  
  // Background
  ctx.fillStyle = '#0d9488';
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, size * 0.25);
  ctx.fill();
  
  // Heart shape (simplified)
  ctx.fillStyle = 'white';
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.25;
  
  ctx.beginPath();
  ctx.arc(cx - r/2, cy - r/4, r/2, 0, Math.PI * 2);
  ctx.arc(cx + r/2, cy - r/4, r/2, 0, Math.PI * 2);
  ctx.fill();
  
  // Triangle bottom
  ctx.beginPath();
  ctx.moveTo(cx - r, cy - r/4 + r/3);
  ctx.lineTo(cx + r, cy - r/4 + r/3);
  ctx.lineTo(cx, cy + r);
  ctx.closePath();
  ctx.fill();
  
  // Cross
  ctx.fillStyle = '#0d9488';
  const crossSize = size * 0.15;
  const crossThickness = size * 0.05;
  ctx.fillRect(cx - crossThickness/2, cy - crossSize/2, crossThickness, crossSize);
  ctx.fillRect(cx - crossSize/2, cy - crossThickness/2, crossSize, crossThickness);
  
  const buffer = canvas.toPNG();
  fs.writeFileSync(\`icon-\${size}.png\`, buffer);
  console.log(\`Created icon-\${size}.png\`);
});
`;

fs.writeFileSync('generate-icons.js', canvasScript);
console.log('Created generate-icons.js');
console.log('Run: npm install canvas && node generate-icons.js');
