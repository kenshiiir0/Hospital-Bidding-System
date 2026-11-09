// The Message Hospitals e-mail design (letterhead, season card, message, files, sign-off), shared by the dialog's
// preview (components/MessageHospitals.js) and the server that sends it (api/hospitals/message), so the preview is
// exactly what the hospitals receive. Built from tables and inline styles so Gmail, Outlook and Apple Mail show it.
//
// Every theme has its own pictures in public/email/ (drawn by scripts/build-email-images.mjs): a strip along the top,
// a corner piece beside the logo and a scene along the bottom, plus a coloured frame around the whole e-mail.
// buildHospitalEmail takes `src(file)`, which gives each picture's address: /email/<file> in the preview, and
// cid:<file> in the sent e-mail, where the pictures travel inside the e-mail itself (no hosting needed).

export const SETTINGS = {
  name: 'Getmeds Philippines',
  signoffSubtitle: 'Your Compassionate Health Ally',
  font: "'Poppins',Arial,Helvetica,sans-serif", // Gmail always falls back to Arial
  fontUrl: 'https://fonts.googleapis.com/css2?family=Poppins:ital,wght@0,400;0,600;1,400&display=swap',
  logo: { file: 'logo.png', width: 210, height: 116 },
  clipIcon: 'clip.png',
  colors: {
    primary: '#2F5321', // headings, lines, sign-off (Getmeds dark green)
    ink: '#1a1a1a',
    text: '#333333',
    line: '#e3e6e4',
    rowAlt: '#f5f7f6',
    headerText: '#ffffff',
    headerSubtext: '#fff7ed',
  },
};

// Season designs: November Diwali, December Christmas, January New Year; the standard design the rest of the year
export const THEMES = {
  diwali: {
    name: 'Diwali',
    month: 'November',
    monthIndex: 10,
    title: 'Diwali Greetings',
    wish: 'Wishing you a bright and joyful Diwali',
    tagline: ['Happy Diwali', 'Festival of Lights'],
    accent: '#EA580C',
    frame: '#F59E0B',
    backdrop: '#FFF7ED',
    headerBg: '#1EA0DA', // Outlook shows this flat colour instead of the gradient
    headerGradient: 'linear-gradient(135deg,#1EA0DA 0%,#61A644 100%)', // Getmeds blue to green
    images: {
      top: 'diwali-top.png',
      corner: 'diwali-corner.png',
      bottom: 'diwali-bottom.png',
    },
    sample: {
      subject: 'Happy Diwali from Getmeds Philippines',
      message:
        'May this Festival of Lights bring warmth, good health and success to everyone at {hospital}.\n\nThank you for your continued trust in Getmeds. We look forward to serving you in the months ahead.',
    },
  },
  christmas: {
    name: 'Christmas',
    month: 'December',
    monthIndex: 11,
    title: "Season's Greetings",
    wish: 'Wishing you a Merry Christmas',
    tagline: ['Merry Christmas', 'Happy Holidays'],
    accent: '#DC2626',
    frame: '#15803D',
    backdrop: '#F0FDF4',
    headerBg: '#1EA0DA', // Outlook shows this flat colour instead of the gradient
    headerGradient: 'linear-gradient(135deg,#1EA0DA 0%,#61A644 100%)', // Getmeds blue to green
    images: {
      top: 'christmas-top.png',
      corner: 'christmas-corner.png',
      bottom: 'christmas-bottom.png',
    },
    sample: {
      subject: 'Merry Christmas from Getmeds Philippines',
      message:
        'Warmest wishes to everyone at {hospital} this Christmas season. Thank you for a year of partnership and for the care you give your patients every day.\n\nMay your holidays be peaceful and joyful.',
    },
  },
  newyear: {
    name: 'New Year',
    month: 'January',
    monthIndex: 0,
    title: 'New Year Greetings',
    wish: 'Wishing you a Happy New Year',
    tagline: ['Happy New Year', 'Cheers to a Healthy Year'],
    accent: '#B7791F',
    frame: '#D4A017',
    backdrop: '#EEF2FF',
    headerBg: '#1EA0DA', // Outlook shows this flat colour instead of the gradient
    headerGradient: 'linear-gradient(135deg,#1EA0DA 0%,#61A644 100%)', // Getmeds blue to green
    images: {
      top: 'newyear-top.png',
      corner: 'newyear-corner.png',
      bottom: 'newyear-bottom.png',
    },
    sample: {
      subject: 'Happy New Year from Getmeds Philippines',
      message: 'As the new year begins, all of us at Getmeds thank {hospital} for your trust and partnership.\n\nWe wish you a healthy, safe and successful year ahead.',
    },
  },
  standard: {
    name: 'Standard',
    title: '',
    wish: '',
    tagline: ['Getmeds Philippines', 'getmeds.ph'],
    accent: '#1EA0DA',
    frame: '#E2E8F0',
    backdrop: '#ffffff',
    images: { corner: 'standard-corner.png', bottom: 'standard-bottom.png' },
  },
};
export const SEASONS = ['diwali', 'christmas', 'newyear'];

// This month's season, else the standard design
export const themeFor = (date = new Date()) => SEASONS.find((k) => THEMES[k].monthIndex === date.getMonth()) || 'standard';

export const titleCase = (name) => name.toLowerCase().replace(/(^|[\s(.-])([a-z])/g, (_, a, b) => a + b.toUpperCase());

// Every picture file a theme's e-mail uses (the server attaches these)
export const themeImages = (theme) => {
  const t = THEMES[theme] || THEMES.standard;
  return [SETTINGS.logo.file, ...Object.values(t.images)];
};

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');

const img = (src, w, h, alt = '') =>
  `<img src="${esc(src)}" width="${w}" height="${h}" alt="${esc(alt)}" style="display:block;border:0;outline:none;text-decoration:none;width:${w}px;height:${h}px;">`;

/**
 * @param {object} email
 * @param {string} email.subject     shown in italics under the logo (season title when empty)
 * @param {string} email.message     {hospital} already filled in
 * @param {string} email.hospital    the hospital's name, for "Dear …,"
 * @param {Array<{name:string}>} [email.files]
 * @param {string} [email.theme]     a THEMES key
 * @param {(file:string)=>string} email.src  a picture's address
 * @returns {{html:string, text:string}}
 */
export function buildHospitalEmail({ subject = '', message = '', hospital = '', files = [], theme = 'standard', src, includeFont = true }) {
  const S = SETTINGS;
  const T = THEMES[theme] || THEMES.standard;
  const C = S.colors;
  const F = S.font;
  const title = subject.trim() || T.title;
  const greeting = `Dear ${hospital ? titleCase(hospital) : 'Valued Partner'},`;

  const section = (heading, body) => `<tr><td style="padding:30px 40px 0 40px;">${heading}${body}</td></tr>`;

  // Season card: the template's details card header, carrying the season's wish
  const card = T.wish
    ? '<tr><td style="padding:24px 40px 0 40px;">' +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">` +
      `<tr><td style="background-color:${T.headerBg};background-image:${T.headerGradient};padding:18px 22px 16px 22px;border-radius:6px;">` +
      `<div style="font-family:${F};font-size:22px;font-weight:600;color:${C.headerText};">${esc(S.name)}</div>` +
      `<div style="padding-top:4px;font-family:${F};font-size:14px;color:${C.headerSubtext};">${esc(T.wish)}</div>` +
      '</td></tr></table></td></tr>'
    : '';

  const messageBlock = message.trim()
    ? section(
        `<div style="border-left:3px solid ${C.primary};padding:2px 0 2px 14px;font-family:${F};font-size:15px;font-weight:600;color:${C.ink};">Message</div>`,
        `<div style="margin:14px 0 0 17px;padding:14px 18px;background-color:${C.rowAlt};border:1px solid ${C.line};border-radius:4px;font-family:${F};font-size:15px;line-height:24px;color:${C.ink};">${esc(message).replace(/\n/g, '<br>')}</div>`,
      )
    : '';

  const filesBlock = files.length
    ? section(
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
          `<td valign="middle" style="padding-right:12px;">${img(src(S.clipIcon), 20, 20)}</td>` +
          `<td valign="middle" style="font-family:${F};font-size:15px;font-weight:600;color:${C.ink};">Attached Files</td>` +
          '</tr></table>',
        `<ul style="margin:12px 0 0 0;padding-left:38px;">${files
          .map((file) => `<li style="margin:0 0 4px 0;font-family:${F};font-size:15px;line-height:22px;color:${C.ink};">${esc(file.name)} &ndash; attached</li>`)
          .join('')}</ul>`,
      )
    : '';

  const rule = `<div style="border-top:1px solid ${C.primary};height:1px;line-height:1px;font-size:1px;">&nbsp;</div>`;
  const [tagA, tagB] = T.tagline || [];
  const tagline = tagA
    ? '<tr><td style="padding:30px 40px 0 40px;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
      `<td width="24%" valign="middle">${rule}</td>` +
      `<td align="center" valign="middle" style="padding:0 14px;white-space:nowrap;font-family:${F};font-size:12px;letter-spacing:1px;color:${C.primary};">` +
      `${esc(tagA)}${tagB ? `&nbsp;&nbsp;<span style="color:${T.accent};">&bull;</span>&nbsp;&nbsp;${esc(tagB)}` : ''}</td>` +
      `<td width="24%" valign="middle">${rule}</td>` +
      '</tr></table></td></tr>'
    : '';

  const I = T.images;
  const border = T.wish ? 3 : 1;
  const inner = 640 - 2 * border; // the strip and the scene fill the frame
  const html =
    (includeFont && S.fontUrl ? `<link href="${esc(S.fontUrl)}" rel="stylesheet">` : '') +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;">` +
    '<tr><td align="center" style="padding:0;">' +
    // The frame: the season's colour all around, the strip on top and the scene at the bottom
    `<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;background-color:#ffffff;border:${border}px solid ${T.frame};border-radius:12px;border-collapse:separate;overflow:hidden;">` +
    (I.top ? `<tr><td style="padding:0;line-height:0;font-size:0;">${img(src(I.top), inner, Math.round((56 * inner) / 640))}</td></tr>` : '') +
    // Letterhead
    '<tr><td style="padding:0;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    `<td valign="top" style="padding:${I.top ? 10 : 34}px 0 0 40px;">` +
    img(src(S.logo.file), S.logo.width, S.logo.height, S.name) +
    (title ? `<div style="padding-top:16px;font-family:${F};font-size:16px;font-style:italic;color:${C.primary};">${esc(title)}</div>` : '') +
    '</td>' +
    `<td width="240" valign="top" align="right" style="padding:0;line-height:0;font-size:0;">${img(src(I.corner), 240, 200)}</td>` +
    '</tr></table></td></tr>' +
    `<tr><td style="padding:14px 40px 0 40px;"><div style="border-top:1px solid ${C.line};height:1px;line-height:1px;font-size:1px;">&nbsp;</div></td></tr>` +
    // Greeting
    `<tr><td style="padding:22px 40px 0 40px;font-family:${F};font-size:15px;line-height:24px;color:${C.text};">${esc(greeting)}</td></tr>` +
    card +
    messageBlock +
    filesBlock +
    // Sign-off
    `<tr><td style="padding:30px 40px 0 40px;font-family:${F};font-size:15px;line-height:22px;color:${C.text};">` +
    'Best regards,<br>' +
    `<span style="font-weight:600;color:${C.primary};">${esc(S.name)}</span>` +
    (S.signoffSubtitle ? `<br><span style="font-size:13px;font-style:italic;color:${C.primary};">${esc(S.signoffSubtitle)}</span>` : '') +
    '</td></tr>' +
    tagline +
    `<tr><td style="padding:14px 0 0 0;line-height:0;font-size:0;">${img(src(I.bottom), inner, Math.round((110 * inner) / 640))}</td></tr>` +
    '</table></td></tr></table>';

  const text = [
    `${title ? `${title} — ` : ''}${S.name}`,
    '',
    greeting,
    '',
    ...(T.wish ? [`${T.wish}!`, ''] : []),
    message,
    ...(files.length ? ['', 'Attached Files:', ...files.map((file) => ` - ${file.name}`)] : []),
    '',
    'Best regards,',
    S.name,
    S.signoffSubtitle,
  ].join('\n');

  return { html, text };
}
