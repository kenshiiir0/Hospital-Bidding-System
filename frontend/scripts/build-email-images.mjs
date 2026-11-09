// Draws the Message Hospitals e-mail pictures into public/email/ (run from frontend/: node scripts/build-email-images.mjs).
// Every e-mail theme (src/lib/hospitalEmail.mjs) has a strip along the top, a corner piece beside the logo and a scene
// along the bottom, drawn here as SVG and saved as PNG at twice their size in the e-mail (Gmail and Outlook show no SVG).
// Also makes the small logo (2MG Inc.) from public/images/2mgsvglogo.svg. Re-run after changing a drawing.
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

const OUT = 'public/email';
mkdirSync(OUT, { recursive: true });

// Seeded random numbers, so a re-run draws the same confetti
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const f = (n) => Math.round(n * 10) / 10;

const sparkle = (x, y, s, color) => `<path d="M${x} ${y - s} Q${x} ${y} ${x + s} ${y} Q${x} ${y} ${x} ${y + s} Q${x} ${y} ${x - s} ${y} Q${x} ${y} ${x} ${y - s}Z" fill="${color}"/>`;

const snowflake = (x, y, r, color) => {
  let s = '';
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    const ex = x + r * Math.cos(a);
    const ey = y + r * Math.sin(a);
    s += `<line x1="${x}" y1="${y}" x2="${f(ex)}" y2="${f(ey)}"/>`;
    const mx = x + r * 0.6 * Math.cos(a);
    const my = y + r * 0.6 * Math.sin(a);
    for (const d of [-0.6, 0.6]) s += `<line x1="${f(mx)}" y1="${f(my)}" x2="${f(mx + r * 0.3 * Math.cos(a + d))}" y2="${f(my + r * 0.3 * Math.sin(a + d))}"/>`;
  }
  return `<g stroke="${color}" stroke-width="1.6" stroke-linecap="round">${s}</g>`;
};

// A draped swag from x0 to x0+w, lowest point `dip` below y0: the point at t (0..1)
const swagAt = (x0, w, y0, dip, t) => [x0 + w * t, y0 + dip * 4 * t * (1 - t)];

const marigold = (x, y, r, color, centre) => {
  let s = '';
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    s += `<circle cx="${f(x + r * 0.55 * Math.cos(a))}" cy="${f(y + r * 0.55 * Math.sin(a))}" r="${f(r * 0.5)}" fill="${color}"/>`;
  }
  return s + `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r * 0.45)}" fill="${centre}"/>`;
};

const petals = (cx, cy, n, d, rx, ry, color, offset = 0, extra = '') => {
  let s = '';
  for (let i = 0; i < n; i++) s += `<ellipse cx="0" cy="${-d}" rx="${rx}" ry="${ry}" fill="${color}" ${extra} transform="translate(${cx} ${cy}) rotate(${f((360 / n) * i + offset)})"/>`;
  return s;
};

const burst = (cx, cy, R, color, n, rand) => {
  let s = '';
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rand() * 0.15;
    const r1 = R * 0.28;
    const r2 = R * (0.85 + rand() * 0.15);
    s += `<line x1="${f(cx + r1 * Math.cos(a))}" y1="${f(cy + r1 * Math.sin(a))}" x2="${f(cx + r2 * Math.cos(a))}" y2="${f(cy + r2 * Math.sin(a))}" stroke="${color}" stroke-width="2.4" stroke-linecap="round"/>`;
    s += `<circle cx="${f(cx + (r2 + 4) * Math.cos(a))}" cy="${f(cy + (r2 + 4) * Math.sin(a))}" r="2.2" fill="${color}"/>`;
  }
  return s + `<circle cx="${cx}" cy="${cy}" r="${f(R * 0.12)}" fill="${color}"/>`;
};

const svg = (w, h, body, defs = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="${w * 2}" height="${h * 2}" viewBox="0 0 ${w} ${h}"><defs>${defs}</defs>${body}</svg>`;

async function save(name, markup) {
  await sharp(Buffer.from(markup)).png({ palette: true, quality: 90, effort: 10 }).toFile(`${OUT}/${name}`);
  console.log('wrote', `${OUT}/${name}`);
}

// ------------------------------------------------------------------ Diwali (November)
function diwaliTop() {
  let s = '';
  for (let k = 0; k < 4; k++) {
    const x0 = k * 160;
    s += `<path d="M${x0} 4 Q${x0 + 80} ${4 + 48} ${x0 + 160} 4" fill="none" stroke="#B45309" stroke-width="1.4"/>`;
    for (let i = 1; i < 12; i++) {
      const [x, y] = swagAt(x0, 160, 4, 24, i / 12);
      s += marigold(f(x), f(y), 5, i % 2 ? '#F59E0B' : '#EA580C', '#B45309');
    }
  }
  for (let k = 0; k <= 4; k++) {
    const x = k * 160;
    s += `<line x1="${x}" y1="2" x2="${x}" y2="36" stroke="#B45309" stroke-width="1.2"/>`;
    s += marigold(x, 8, 5.5, '#EA580C', '#B45309') + marigold(x, 18, 5, '#F59E0B', '#B45309') + marigold(x, 28, 4.6, '#EA580C', '#B45309');
    s += `<path d="M${x} 33 Q${x + 7} 42 ${x} 53 Q${x - 7} 42 ${x} 33Z" fill="#15803D"/><line x1="${x}" y1="35" x2="${x}" y2="51" stroke="#166534" stroke-width="0.8"/>`;
  }
  return svg(640, 56, s);
}

function diwaliCorner() {
  const cx = 205;
  const cy = 35;
  let s = '<circle cx="70" cy="74" r="38" fill="url(#glow)"/>';
  s += petals(cx, cy, 16, 112, 11, 22, '#DB2777');
  s += petals(cx, cy, 16, 88, 10, 19, '#F97316', 11.25);
  s += `<circle cx="${cx}" cy="${cy}" r="70" fill="none" stroke="#FBBF24" stroke-width="3"/>`;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    s += `<circle cx="${f(cx + 62 * Math.cos(a))}" cy="${f(cy + 62 * Math.sin(a))}" r="3" fill="#0D9488"/>`;
  }
  s += petals(cx, cy, 8, 36, 11, 20, '#7C3AED', 22.5);
  s += `<circle cx="${cx}" cy="${cy}" r="24" fill="#FBBF24"/><circle cx="${cx}" cy="${cy}" r="15" fill="#EA580C"/><circle cx="${cx}" cy="${cy}" r="6" fill="#FEF3C7"/>`;
  // Hanging lantern (akash kandil)
  s += '<line x1="70" y1="0" x2="70" y2="40" stroke="#B45309" stroke-width="1.6"/>';
  s += '<rect x="62" y="38" width="16" height="6" rx="2" fill="#B45309"/>';
  s += '<path d="M70 44 L94 72 L70 102 L46 72Z" fill="#EA580C"/><path d="M70 52 L85 72 L70 92 L55 72Z" fill="#FBBF24"/>';
  s += '<path d="M46 72 H94" stroke="#DB2777" stroke-width="2"/><circle cx="70" cy="72" r="5" fill="#DB2777"/>';
  s += '<g stroke="#DB2777" stroke-width="2" stroke-linecap="round"><line x1="70" y1="102" x2="64" y2="124"/><line x1="70" y1="102" x2="70" y2="127"/><line x1="70" y1="102" x2="76" y2="124"/></g>';
  s += sparkle(22, 28, 7, '#F59E0B') + sparkle(122, 156, 8, '#F59E0B') + sparkle(170, 188, 5, '#DB2777') + sparkle(28, 120, 5, '#F59E0B') + sparkle(110, 18, 5, '#DB2777');
  const defs = '<radialGradient id="glow"><stop offset="0" stop-color="#FDE68A" stop-opacity="0.75"/><stop offset="1" stop-color="#FDE68A" stop-opacity="0"/></radialGradient>';
  return svg(240, 200, s, defs);
}

function diwaliBottom() {
  let s = '<rect x="0" y="94" width="640" height="16" fill="#FEF3C7"/>';
  for (let x = 0; x < 640; x += 20) s += `<path d="M${x} 94 L${x + 10} 84 L${x + 20} 94Z" fill="${(x / 20) % 2 ? '#F97316' : '#DB2777'}"/>`;
  for (let x = 10; x < 640; x += 20) s += `<circle cx="${x}" cy="102" r="2.5" fill="#DB2777"/>`;
  s += '<rect x="0" y="108" width="640" height="2" fill="#EA580C"/>';
  for (const [x, k] of [
    [80, 0.9],
    [200, 1],
    [320, 1.15],
    [440, 1],
    [560, 0.9],
  ]) {
    s += `<g transform="translate(${x} 84) scale(${k}) translate(${-x} -84)">`;
    s += `<circle cx="${x}" cy="50" r="30" fill="url(#glow)"/>`;
    s += `<path d="M${x - 28} 66 C${x - 24} 88 ${x + 24} 88 ${x + 28} 66Z" fill="#B45309"/>`;
    s += `<ellipse cx="${x}" cy="66" rx="28" ry="5" fill="#92400E"/>`;
    s += `<circle cx="${x - 13}" cy="74" r="2.4" fill="#FCD34D"/><circle cx="${x}" cy="77" r="2.4" fill="#FCD34D"/><circle cx="${x + 13}" cy="74" r="2.4" fill="#FCD34D"/>`;
    s += `<path d="M${x} 30 C${x + 10} 46 ${x + 9} 58 ${x} 64 C${x - 9} 58 ${x - 10} 46 ${x} 30Z" fill="url(#flame)"/>`;
    s += `<path d="M${x} 44 C${x + 5} 52 ${x + 4} 58 ${x} 61 C${x - 4} 58 ${x - 5} 52 ${x} 44Z" fill="#FEF9C3"/>`;
    s += '</g>';
  }
  s +=
    sparkle(140, 30, 6, '#F59E0B') + sparkle(260, 18, 5, '#DB2777') + sparkle(380, 34, 6, '#F59E0B') + sparkle(500, 20, 5, '#DB2777') + sparkle(612, 40, 6, '#F59E0B') + sparkle(26, 36, 5, '#F59E0B');
  const defs =
    '<radialGradient id="glow"><stop offset="0" stop-color="#FDE68A" stop-opacity="0.8"/><stop offset="1" stop-color="#FDE68A" stop-opacity="0"/></radialGradient>' +
    '<linearGradient id="flame" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FDE047"/><stop offset="1" stop-color="#F97316"/></linearGradient>';
  return svg(640, 110, s, defs);
}

// ------------------------------------------------------------------ Christmas (December)
function christmasTop() {
  const rand = rng(12);
  const greens = ['#14532D', '#166534', '#15803D', '#1F7A3A'];
  const bulbs = ['#DC2626', '#F59E0B', '#2563EB', '#DC2626', '#F59E0B'];
  let s = '';
  for (let k = 0; k < 4; k++) {
    const x0 = k * 160;
    for (let i = 0; i <= 48; i++) {
      const [x, y] = swagAt(x0, 160, 6, 20, i / 48);
      for (let j = 0; j < 2; j++) s += `<circle cx="${f(x + (rand() - 0.5) * 6)}" cy="${f(y + (rand() - 0.5) * 6)}" r="${f(4 + rand() * 2.5)}" fill="${greens[Math.floor(rand() * 4)]}"/>`;
    }
    for (let i = 1; i <= 5; i++) {
      const [x, y] = swagAt(x0, 160, 6, 20, i / 6);
      const c = bulbs[(i + k) % 5];
      s += `<circle cx="${f(x)}" cy="${f(y + 12)}" r="9" fill="${c}" opacity="0.18"/>`;
      s += `<rect x="${f(x - 2.5)}" y="${f(y + 2)}" width="5" height="4" rx="1" fill="#A16207"/>`;
      s += `<ellipse cx="${f(x)}" cy="${f(y + 12)}" rx="4.4" ry="6.4" fill="${c}"/><ellipse cx="${f(x - 1.4)}" cy="${f(y + 10)}" rx="1.2" ry="2" fill="#fff" opacity="0.7"/>`;
    }
  }
  for (let k = 0; k <= 4; k++) {
    const x = k * 160;
    s += `<path d="M${x} 8 L${x - 12} 1 L${x - 12} 15Z M${x} 8 L${x + 12} 1 L${x + 12} 15Z" fill="#DC2626"/>`;
    s += `<path d="M${x - 2} 9 L${x - 8} 26 M${x + 2} 9 L${x + 8} 26" stroke="#B91C1C" stroke-width="3" stroke-linecap="round"/><circle cx="${x}" cy="8" r="3.5" fill="#B91C1C"/>`;
  }
  return svg(640, 56, s);
}

const hollyLeaf = 'M0 0 Q-6 -6 -12 -8 Q-9 -14 -14 -20 Q-8 -23 -12 -30 Q-6 -32 -8 -40 Q-3 -42 0 -50 Q3 -42 8 -40 Q6 -32 12 -30 Q8 -23 14 -20 Q9 -14 12 -8 Q6 -6 0 0Z';

const bauble = (x, len, r, color, dark) =>
  `<line x1="${x}" y1="0" x2="${x}" y2="${len}" stroke="#A16207" stroke-width="1.2"/>` +
  `<rect x="${x - 5}" y="${len}" width="10" height="7" rx="1.5" fill="#D4A017"/>` +
  `<circle cx="${x}" cy="${len + 7 + r}" r="${r}" fill="${color}"/>` +
  `<path d="M${x - r} ${len + 7 + r} Q${x - r / 2} ${len + 7 + r - 5} ${x} ${len + 7 + r} T${x + r} ${len + 7 + r}" fill="none" stroke="#fff" stroke-width="2" opacity="0.85"/>` +
  `<circle cx="${x}" cy="${len + 7 + r}" r="${r}" fill="none" stroke="${dark}" stroke-width="1"/>` +
  `<ellipse cx="${f(x - r * 0.4)}" cy="${f(len + 7 + r * 0.6)}" rx="${f(r * 0.22)}" ry="${f(r * 0.35)}" fill="#fff" opacity="0.6"/>`;

function christmasCorner() {
  let s = snowflake(20, 40, 9, '#93C5FD') + snowflake(118, 182, 8, '#93C5FD') + snowflake(196, 140, 10, '#BFDBFE') + snowflake(68, 150, 6, '#BFDBFE');
  s += bauble(40, 52, 15, '#DC2626', '#991B1B') + bauble(95, 92, 21, '#D4A017', '#A16207') + bauble(145, 58, 14, '#15803D', '#14532D');
  for (const [a, sc] of [
    [-150, 1.5],
    [-95, 1.6],
    [-200, 1.3],
  ])
    s += `<path d="${hollyLeaf}" fill="#166534" stroke="#14532D" stroke-width="0.8" transform="translate(212 34) rotate(${a + 90}) scale(${sc})"/>`;
  s += '<circle cx="206" cy="38" r="7.5" fill="#DC2626"/><circle cx="219" cy="32" r="7" fill="#B91C1C"/><circle cx="214" cy="46" r="7" fill="#DC2626"/>';
  s += '<circle cx="204" cy="35" r="2" fill="#fff" opacity="0.7"/><circle cx="212" cy="43" r="2" fill="#fff" opacity="0.7"/>';
  return svg(240, 200, s);
}

const tree = (x, base, k) =>
  `<g transform="translate(${x} ${base}) scale(${k})">` +
  '<rect x="-4" y="-10" width="8" height="10" fill="#78350F"/>' +
  '<path d="M-26 -10 L0 -38 L26 -10Z" fill="#15803D"/><path d="M-21 -28 L0 -54 L21 -28Z" fill="#166534"/><path d="M-15 -44 L0 -68 L15 -44Z" fill="#15803D"/>' +
  '<path d="M-9 -54 L0 -68 L9 -54 Q4 -51 0 -55 Q-4 -51 -9 -54Z" fill="#fff"/>' +
  sparkle(0, -72, 6, '#F59E0B') +
  '<circle cx="-10" cy="-18" r="2.2" fill="#DC2626"/><circle cx="9" cy="-24" r="2.2" fill="#F59E0B"/><circle cx="-6" cy="-38" r="2.2" fill="#2563EB"/><circle cx="7" cy="-44" r="2" fill="#DC2626"/>' +
  '</g>';

const gift = (x, base, w, h, box, ribbon) =>
  `<rect x="${x}" y="${base - h}" width="${w}" height="${h}" rx="2" fill="${box}"/>` +
  `<rect x="${x + w / 2 - 3}" y="${base - h}" width="6" height="${h}" fill="${ribbon}"/><rect x="${x}" y="${base - h / 2 - 3}" width="${w}" height="6" fill="${ribbon}"/>` +
  `<path d="M${x + w / 2} ${base - h} Q${x + w / 2 - 14} ${base - h - 14} ${x + w / 2 - 4} ${base - h} Q${x + w / 2 + 14} ${base - h - 14} ${x + w / 2} ${base - h}Z" fill="${ribbon}" stroke="${ribbon}" stroke-width="2"/>`;

function christmasBottom() {
  let s = '<path d="M0 110 L0 84 Q120 64 240 86 Q360 104 480 80 Q570 66 640 82 L640 110Z" fill="#DBEAFE"/>';
  s += '<path d="M0 110 L0 96 Q160 84 320 98 Q480 110 640 94 L640 110Z" fill="#EFF6FF"/>';
  s += tree(40, 92, 1) + tree(100, 96, 0.72) + tree(560, 90, 1.1) + tree(615, 96, 0.75);
  s += gift(170, 100, 30, 24, '#DC2626', '#F59E0B') + gift(206, 100, 22, 18, '#15803D', '#DC2626') + gift(460, 98, 28, 22, '#D4A017', '#B91C1C');
  s += snowflake(300, 30, 9, '#93C5FD') + snowflake(390, 52, 7, '#BFDBFE') + snowflake(250, 64, 6, '#BFDBFE') + snowflake(520, 26, 8, '#93C5FD') + snowflake(150, 30, 6, '#BFDBFE');
  const rand = rng(7);
  for (let i = 0; i < 26; i++) s += `<circle cx="${f(rand() * 640)}" cy="${f(rand() * 74)}" r="${f(1.2 + rand() * 1.6)}" fill="#BFDBFE"/>`;
  return svg(640, 110, s);
}

// ------------------------------------------------------------------ New Year (January)
const CONFETTI = ['#D4A017', '#1E3A8A', '#DB2777', '#0EA5A4', '#F59E0B'];
const confetti = (rand, n, w, h) => {
  let s = '';
  for (let i = 0; i < n; i++) {
    const x = f(rand() * w);
    const y = f(rand() * h);
    const c = CONFETTI[Math.floor(rand() * CONFETTI.length)];
    s +=
      rand() < 0.7 ? `<rect x="${x}" y="${y}" width="3" height="7" rx="1" fill="${c}" transform="rotate(${Math.round(rand() * 180)} ${x} ${y})"/>` : `<circle cx="${x}" cy="${y}" r="2" fill="${c}"/>`;
  }
  return s;
};

function newYearTop() {
  const wave = (amp, period, phase, y) => {
    let d = `M0 ${y}`;
    for (let x = 0; x <= 640; x += 8) d += ` L${x} ${f(y + amp * Math.sin((x / period) * Math.PI * 2 + phase))}`;
    return d;
  };
  let s = `<path d="${wave(10, 160, 0, 22)}" fill="none" stroke="#D4A017" stroke-width="3" stroke-linecap="round"/>`;
  s += `<path d="${wave(8, 120, 2, 30)}" fill="none" stroke="#DB2777" stroke-width="2.4" stroke-linecap="round"/>`;
  s += `<path d="${wave(6, 200, 4, 16)}" fill="none" stroke="#1E3A8A" stroke-width="2" stroke-linecap="round"/>`;
  s += confetti(rng(3), 90, 640, 56);
  return svg(640, 56, s);
}

function newYearCorner() {
  const rand = rng(21);
  let s = burst(178, 66, 56, '#D4A017', 18, rand) + burst(86, 44, 32, '#DB2777', 12, rand) + burst(204, 156, 30, '#0EA5A4', 12, rand) + burst(110, 140, 18, '#1E3A8A', 10, rand);
  s += sparkle(30, 30, 7, '#D4A017') + sparkle(140, 190, 6, '#DB2777') + sparkle(40, 110, 5, '#0EA5A4') + sparkle(230, 100, 6, '#D4A017');
  s += confetti(rng(5), 22, 240, 200);
  return svg(240, 200, s);
}

function newYearBottom() {
  const rand = rng(9);
  let s = '';
  let x = 0;
  while (x < 640) {
    const w = 24 + Math.floor(rand() * 26);
    const h = 26 + Math.floor(rand() * 46);
    s += `<rect x="${x}" y="${110 - h}" width="${w - 2}" height="${h}" fill="${rand() < 0.5 ? '#1E3A8A' : '#26408F'}"/>`;
    for (let wy = 110 - h + 6; wy < 104; wy += 9) for (let wx = x + 5; wx < x + w - 8; wx += 8) if (rand() < 0.45) s += `<rect x="${wx}" y="${wy}" width="3.5" height="4" fill="#FCD34D"/>`;
    x += w;
  }
  const r2 = rng(33);
  s = burst(110, 26, 18, '#DB2777', 12, r2) + burst(330, 20, 22, '#D4A017', 14, r2) + burst(540, 28, 17, '#0EA5A4', 12, r2) + confetti(rng(4), 30, 640, 40) + s;
  s += sparkle(220, 30, 5, '#D4A017') + sparkle(440, 16, 6, '#D4A017') + sparkle(620, 12, 5, '#DB2777');
  return svg(640, 110, s);
}

// ------------------------------------------------------------------ Standard GetMeds design (other months)
function standardCorner() {
  let s = '<path d="M30 0 C90 100 170 150 240 160 L240 0Z" fill="#1EA0DA" opacity="0.12"/>';
  s += '<path d="M92 0 C140 64 192 94 240 104 L240 0Z" fill="#1EA0DA"/>';
  s += '<path d="M152 0 C180 36 210 52 240 56 L240 0Z" fill="#61A644"/>';
  s += '<path d="M66 0 C120 80 180 122 240 132" fill="none" stroke="#61A644" stroke-width="3"/>';
  return svg(240, 200, s);
}

function standardBottom() {
  let s = '<path d="M640 14 C560 70 470 100 330 110 L640 110Z" fill="#1EA0DA" opacity="0.12"/>';
  s += '<path d="M640 50 C590 84 530 102 450 110 L640 110Z" fill="#1EA0DA"/>';
  s += '<path d="M640 80 C610 96 580 106 540 110 L640 110Z" fill="#61A644"/>';
  s += '<path d="M640 30 C580 76 500 100 400 110" fill="none" stroke="#61A644" stroke-width="3"/>';
  return svg(640, 110, s);
}

const clip =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#2F5321" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';

await save('diwali-top.png', diwaliTop());
await save('diwali-corner.png', diwaliCorner());
await save('diwali-bottom.png', diwaliBottom());
await save('christmas-top.png', christmasTop());
await save('christmas-corner.png', christmasCorner());
await save('christmas-bottom.png', christmasBottom());
await save('newyear-top.png', newYearTop());
await save('newyear-corner.png', newYearCorner());
await save('newyear-bottom.png', newYearBottom());
await save('standard-corner.png', standardCorner());
await save('standard-bottom.png', standardBottom());
await save('clip.png', clip);
// The logo at twice its e-mail size (220 x 69); e-mail programs show no SVG, so it is a PNG
await sharp('public/images/2mgsvglogo.svg', { density: 72 }).resize({ width: 440 }).png({ palette: true, effort: 10 }).toFile(`${OUT}/logo-2mg.png`);
console.log('wrote', `${OUT}/logo-2mg.png`);
