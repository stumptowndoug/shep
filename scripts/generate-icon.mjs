import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SIZE = 1024;
const PADDING = 180; // breathing room around the logo
const CORNER_RADIUS = 220;
const LOGO_PATH = new URL("../assets/shep_logo.svg", import.meta.url);
// fileURLToPath (not URL.pathname) so the path is valid on Windows too
const OUTPUT_PATH = fileURLToPath(new URL("../assets/icon-1024.png", import.meta.url));

function extractViewBox(svg) {
  const match = svg.match(/viewBox="([^"]+)"/i);
  if (!match) {
    throw new Error("Logo SVG is missing a viewBox");
  }

  const [, viewBox] = match;
  const [, , width, height] = viewBox
    .trim()
    .split(/\s+/)
    .map(Number);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid SVG viewBox: ${viewBox}`);
  }

  return { width, height };
}

function extractInnerSvg(svg) {
  const match = svg.match(/<svg[^>]*>([\s\S]*?)<\/svg>/i);
  if (!match) {
    throw new Error("Failed to extract SVG contents");
  }
  return match[1];
}

const logoSvg = await readFile(LOGO_PATH, "utf8");
const { width: logoWidth, height: logoHeight } = extractViewBox(logoSvg);
const logoMarkup = extractInnerSvg(logoSvg);

// Scale logo to fit within the padded area
const availableSize = SIZE - PADDING * 2;
const scale = Math.min(availableSize / logoWidth, availableSize / logoHeight);
const logoW = Math.round(logoWidth * scale);
const logoH = Math.round(logoHeight * scale);
const logoX = Math.round((SIZE - logoW) / 2);
const logoY = Math.round((SIZE - logoH) / 2);

// Glass background SVG — dark base with radial color orbs + subtle gradient overlay
const svg = `<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="rounded">
      <rect width="${SIZE}" height="${SIZE}" rx="${CORNER_RADIUS}" ry="${CORNER_RADIUS}"/>
    </clipPath>
  </defs>

  <g clip-path="url(#rounded)">
    <rect width="${SIZE}" height="${SIZE}" fill="#181825"/>
  </g>

  <!-- White logo -->
  <g transform="translate(${logoX}, ${logoY}) scale(${scale})">
    ${logoMarkup}
  </g>
</svg>`;

await sharp(Buffer.from(svg), { density: 72 })
  .resize(SIZE, SIZE, { kernel: "nearest" })
  .png()
  .toFile(OUTPUT_PATH);

console.log(`Icon generated: ${OUTPUT_PATH}`);
