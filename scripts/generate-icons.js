const sharp = require('sharp');
const path  = require('path');
const fs    = require('fs');

// Icon design: #111 background, two white vertical ovals
function makeSvg(size) {
  const cx1 = size * 0.325;
  const cx2 = size * 0.675;
  const cy  = size * 0.5;
  const rx  = size * 0.175;
  const ry  = size * 0.225;
  const r   = size * 0.22; // corner radius for bg
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${size}" height="${size}" rx="${r}" fill="#111111"/>
  <ellipse cx="${cx1}" cy="${cy}" rx="${rx}" ry="${ry}" fill="white"/>
  <ellipse cx="${cx2}" cy="${cy}" rx="${rx}" ry="${ry}" fill="white"/>
</svg>`;
}

const ANDROID_SIZES = [
  { folder: 'mipmap-mdpi',    size: 48  },
  { folder: 'mipmap-hdpi',    size: 72  },
  { folder: 'mipmap-xhdpi',   size: 96  },
  { folder: 'mipmap-xxhdpi',  size: 144 },
  { folder: 'mipmap-xxxhdpi', size: 192 },
];

const RES_DIR = path.join(__dirname, '../android/app/src/main/res');

(async () => {
  for (const { folder, size } of ANDROID_SIZES) {
    const svg  = makeSvg(size);
    const dest = path.join(RES_DIR, folder);
    fs.mkdirSync(dest, { recursive: true });

    await sharp(Buffer.from(svg))
      .png()
      .toFile(path.join(dest, 'ic_launcher.png'));

    await sharp(Buffer.from(svg))
      .png()
      .toFile(path.join(dest, 'ic_launcher_round.png'));

    console.log(`✓ ${folder} — ${size}×${size}`);
  }

  // Also generate a 1024×1024 for App Store / Play Store
  const svg1024 = makeSvg(1024);
  await sharp(Buffer.from(svg1024)).png()
    .toFile(path.join(__dirname, '../icon-1024.png'));
  console.log('✓ icon-1024.png (Play Store / App Store)');
})();
