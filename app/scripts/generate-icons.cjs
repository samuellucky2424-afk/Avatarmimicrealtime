/* eslint-disable */
// Regenerate icon.ico (multi-size) and icon.png (512) from public/favicon.svg.
// Run: npm run icons
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIco = require('png-to-ico').default;

const ROOT = path.resolve(__dirname, '..');
const SVG = path.join(ROOT, 'public', 'favicon.svg');
const ICO_OUT = path.join(ROOT, 'build', 'icon.ico');
const PNG_OUT = path.join(ROOT, 'public', 'icon.png');
const PNG_BUILD_OUT = path.join(ROOT, 'build', 'icon.png');

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

(async () => {
  if (!fs.existsSync(SVG)) {
    console.error('favicon.svg not found at', SVG);
    process.exit(1);
  }
  const svg = fs.readFileSync(SVG);

  fs.mkdirSync(path.dirname(ICO_OUT), { recursive: true });

  const pngBuffers = await Promise.all(
    ICO_SIZES.map((size) =>
      sharp(svg, { density: 384 })
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer()
    )
  );

  const ico = await pngToIco(pngBuffers);
  fs.writeFileSync(ICO_OUT, ico);
  console.log('wrote', ICO_OUT, ico.length, 'bytes');

  const png512 = await sharp(svg, { density: 512 })
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  fs.writeFileSync(PNG_OUT, png512);
  fs.writeFileSync(PNG_BUILD_OUT, png512);
  console.log('wrote', PNG_OUT, png512.length, 'bytes');
  console.log('wrote', PNG_BUILD_OUT, png512.length, 'bytes');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
