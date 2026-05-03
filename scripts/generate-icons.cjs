const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// Create a simple SVG for the icon
const createSVG = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <!-- Background -->
  <rect width="512" height="512" rx="128" fill="#0d9488"/>
  
  <!-- Heart shape -->
  <path d="M256 120 
           C200 120, 140 160, 140 240 
           C140 320, 256 400, 256 400 
           C256 400, 372 320, 372 240 
           C372 160, 312 120, 256 120 Z" 
        fill="white"/>
  
  <!-- Cross in center -->
  <rect x="232" y="180" width="48" height="120" rx="8" fill="#0d9488"/>
  <rect x="196" y="216" width="120" height="48" rx="8" fill="#0d9488"/>
</svg>
`;

async function generateIcons() {
  const publicDir = path.join(__dirname, '..', 'public');
  
  // Generate icons in different sizes
  const sizes = [192, 512];
  
  for (const size of sizes) {
    const svgBuffer = Buffer.from(createSVG(size));
    const outputPath = path.join(publicDir, `icon-${size}.png`);
    
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(outputPath);
    
    console.log(`✓ Created icon-${size}.png`);
  }
  
  // Also create smaller icons for shortcuts
  const shortcutSizes = [
    { name: 'icon-search', size: 96 },
    { name: 'icon-calendar', size: 96 }
  ];
  
  for (const { name, size } of shortcutSizes) {
    const svgBuffer = Buffer.from(createSVG(size));
    const outputPath = path.join(publicDir, `${name}.png`);
    
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(outputPath);
    
    console.log(`✓ Created ${name}.png`);
  }
  
  console.log('\nAll PWA icons generated successfully!');
}

generateIcons().catch(err => {
  console.error('Error generating icons:', err);
  process.exit(1);
});
