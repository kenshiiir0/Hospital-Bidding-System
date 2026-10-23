// What the bid documents say about the schedule (lib/psDocs.mjs keeps the whole sentence, e.g. "Pre-Bid
// Conference on October 27, 2026, 9:00 AM at DA-13, Capitol Site ... which shall be open to prospective
// Bidders. 7) Bids must be ...") cut down to the value alone, the way the team writes it:
// "October 27, 2026, 9:00 AM" and "30 Day/s" (as PhilGEPS shows delivery periods).

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
// "October 27, 2026", "Oct 13, 2026", "October 29 2026", "23 October 2026"
const DATE = new RegExp(`\\b${MONTH}\\s+(\\d{1,2}),?\\s+(\\d{4})|\\b(\\d{1,2})\\s+${MONTH},?\\s+(\\d{4})`, 'i');
// "9:00 AM", "10:00am", "2PM", "2: 00 p.m.", "9 o'clock in the morning"
const TIME = /\b(\d{1,2})(?::\s?(\d{2}))?\s*(?:([ap])\.?\s?m\b\.?|o['’]clock in the (morning|afternoon|evening))/i;

const monthName = (text) => MONTHS.find((m) => m.slice(0, 3) === text.slice(0, 3).toLowerCase().replace(/^./, (c) => c.toUpperCase()));

function timeText(m) {
  const hour = +m[1];
  if (hour > 12) return null;
  const pm = m[3] ? m[3].toLowerCase() === 'p' : m[4] && m[4].toLowerCase() !== 'morning';
  return `${hour}:${m[2] || '00'} ${pm ? 'PM' : 'AM'}`;
}

// The first date in a passage with its time (just after the date, else just before: "02:00 p.m. of October 19, 2026");
// null when the passage has no date, so a cell is left empty rather than filled with a sentence
export function bidDateText(passage) {
  if (!passage) return null;
  const text = String(passage).replace(/\s+/g, ' ');
  const d = DATE.exec(text);
  if (!d) return null;
  const [month, day, year] = d[1] ? [d[1], d[2], d[3]] : [d[5], d[4], d[6]];
  const name = monthName(month);
  if (!name) return null;
  const after = TIME.exec(text.slice(d.index + d[0].length, d.index + d[0].length + 40));
  const before = after ? null : TIME.exec(text.slice(Math.max(0, d.index - 25), d.index));
  const time = after || before ? timeText(after || before) : null;
  return `${name} ${+day}, ${year}${time ? `, ${time}` : ''}`;
}

// "Delivery of the Goods is required within thirty (30) calendar days upon receipt of ..." -> "30 Day/s";
// "seven to fourteen (7-14) working days" -> "7-14 Day/s"; null when no number of days or weeks is given
export function deliveryText(passage) {
  if (!passage) return null;
  const m = /\(?\b(\d+(?:\s*(?:-|to)\s*\d+)?)\)?\s*(?:calendar\s+|working\s+)?(days?|weeks?)\b/i.exec(String(passage));
  if (!m) return null;
  return `${m[1].replace(/\s*(?:-|to)\s*/, '-')} ${/^w/i.test(m[2]) ? 'Week/s' : 'Day/s'}`;
}
