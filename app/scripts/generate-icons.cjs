/* eslint-disable */
// Regenerate icon.ico (multi-size) and icon.png (512).
// Preferred input: APP_ICON_SOURCE, then public/app-icon.png/jpg/webp, then public/favicon.svg.
// Run: npm run icons
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIco = require('png-to-ico').default;

const ROOT = path.resolve(__dirname, '..');
const SVG = path.join(ROOT, 'public', 'favicon.svg');
const DEFAULT_BITMAP_SOURCES = [
  path.join(ROOT, 'public', 'app-icon.png'),
  path.join(ROOT, 'public', 'app-icon.jpg'),
  path.join(ROOT, 'public', 'app-icon.jpeg'),
  path.join(ROOT, 'public', 'app-icon.webp'),
];
const ICO_OUT = path.join(ROOT, 'build', 'icon.ico');
const PNG_OUT = path.join(ROOT, 'public', 'icon.png');
const PNG_BUILD_OUT = path.join(ROOT, 'build', 'icon.png');

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function resolveIconSource() {
  const explicitSource = process.env.APP_ICON_SOURCE
    ? path.resolve(process.env.APP_ICON_SOURCE)
    : null;
  const candidates = [explicitSource, ...DEFAULT_BITMAP_SOURCES, SVG].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

(async () => {
  const source = resolveIconSource();
  if (!source) {
    console.error('No icon source found. Add public/app-icon.png or set APP_ICON_SOURCE.');
    process.exit(1);
  }
  const input = fs.readFileSync(source);
  const isSvg = source.toLowerCase().endsWith('.svg');
  const sharpOptions = isSvg ? { density: 512 } : {};

  fs.mkdirSync(path.dirname(ICO_OUT), { recursive: true });

  const pngBuffers = await Promise.all(
    ICO_SIZES.map((size) =>
      sharp(input, sharpOptions)
        .resize(size, size, { fit: 'cover', position: 'center' })
        .png()
        .toBuffer()
    )
  );

  const ico = await pngToIco(pngBuffers);
  fs.writeFileSync(ICO_OUT, ico);
  console.log('wrote', ICO_OUT, ico.length, 'bytes');

  const png512 = await sharp(input, sharpOptions)
    .resize(512, 512, { fit: 'cover', position: 'center' })
    .png()
    .toBuffer();
  fs.writeFileSync(PNG_OUT, png512);
  fs.writeFileSync(PNG_BUILD_OUT, png512);
  console.log('source', source);
  console.log('wrote', PNG_OUT, png512.length, 'bytes');
  console.log('wrote', PNG_BUILD_OUT, png512.length, 'bytes');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
