// Builds the "Opportunity" sheet in the same layout as the team's PHILGEPS OPPORTUNITY.xlsx:
// a title row, a header row, then one block per tender (tender facts merged down the block,
// one row per requested molecule) separated by a blank merged row.

const COLUMNS = [
  // header, width, header font size
  ['Type', 9.5, 11],
  ['Sr. NO.', 18, 14], // widened from the original 12.1: solicitation numbers are long
  ['Date ', 11.9, 14],
  ['Hospital ', 35.5, 16],
  ['Ref No. ', 11.7, 16],
  ['Molecule', 55.9, 16],
  ['Qty ', 20.5, 16],
  ['ABC/Unit', 13.4, 14],
  ['ABC Total', 15.7, 14],
  ['Pre Bid', 17.8, 14],
  ['Bid Opening', 20.3, 14],
  ['Assign Person', 18.9, 14],
  ['Final Remarks', 18.9, 14],
  ['Delivery Period', 18.9, 14],
  ['Last Updated Date', 18.9, 14],
  ['Closing Date', 13, 14],
  ['Contact Person', 18.9, 14],
  ['Designation', 18.9, 14],
  ['Contact No.', 18.9, 14],
  ['Email', 28, 14], // widened from 18.9
  ['Address', 35, 14], // widened from 13
];
const WIDTH = Object.fromEntries(COLUMNS.map(([, width], i) => [String.fromCharCode(65 + i), width]));
// Tender-level columns, merged down each block. The original merges A–E and J–Q; M and R–U are
// merged too so long contact details get the block's full height instead of one cramped row.
const MERGED = ['A', 'B', 'C', 'D', 'E', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U'];

// Rough line count of wrapped text: Excel doesn't grow rows for wrapped or merged cells on its own,
// so heights are set from the text. charsPerUnit < 1 for wider fonts (Segoe UI, capitals).
function wrappedLines(text, width, charsPerUnit) {
  if (text == null || text === '') return 1;
  const perLine = Math.max(1, Math.floor(width * charsPerUnit));
  return String(text)
    .split('\n')
    .reduce((n, part) => n + Math.max(1, Math.ceil(part.length / perLine)), 0);
}
const CALIBRI_LINE = 15; // points per line, Calibri 11
const SEGOE_LINE = 17; // Segoe UI 11

const MEDIUM = { style: 'medium' };
const BOX = { top: MEDIUM, left: MEDIUM, bottom: MEDIUM, right: MEDIUM };
const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const HEADER_FILL = solid('FF70AD47'); // Office theme Accent 6
const HOSPITAL_FILL = solid('FFF4B084'); // Accent 2, lighter 40%
const MOLECULE_FILL = solid('FFFFFF00');
const WHITE_FILL = solid('FFFFFFFF'); // tender cells are filled white in the original (hides gridlines)
const ITEM_FONT = { name: 'Segoe UI', size: 11, color: { argb: 'FF0D0D0D' } };
const CENTER = { horizontal: 'center', vertical: 'middle', wrapText: true };
const DATE_TIME_FORMAT = 'm/d/yy h:mm';
const EMAIL = /^[^\s@<>"'()]+@[^\s@<>"'()]+\.[a-z]{2,}$/i;
const PHONE = /^[\d\s()+\-/.,]{7,}(?:ext\.?\s*\d+)?$/i;

// "Invitation to Bid (ITB)" -> "ITB"
const noticeType = (type) => (type && (/\(([^)]+)\)\s*$/.exec(type)?.[1] || type)) || '';

// "2026-10-20" -> "20/10/2026", written as text like the original sheet
function dmy(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value || '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

// Excel shows dates as stored, so build them in UTC from the Philippine local parts
function isoDateTime(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(value || '');
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])) : null;
}
function dmyTime(value) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(value || '');
  if (!m) return value || null;
  const hour = (+m[4] % 12) + (m[6].toUpperCase() === 'PM' ? 12 : 0);
  return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], hour, +m[5]));
}

const amount = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Contact lines are [designation, address lines..., phone numbers, e-mail]
function splitContact(info = []) {
  const [designation = '', ...rest] = info;
  // PhilGEPS often repeats the same number for phone and fax
  const unique = (lines) => [...new Set(lines)].join(' / ');
  return {
    designation,
    phone: unique(rest.filter((l) => PHONE.test(l))),
    email: unique(rest.filter((l) => EMAIL.test(l))),
    address: rest
      .filter((l) => !PHONE.test(l) && !EMAIL.test(l))
      .map((l) => l.replace(/,+\s*$/, ''))
      .join(', '),
  };
}

// One sheet row per requested molecule: [Molecule, Qty, ABC/Unit, ABC Total]
function moleculeRows(bid) {
  const items = bid.details?.matched_items || [];
  if (!items.length) return [[(bid.matched_molecules || []).join(', '), '', '', null]];
  return items.map((item) => {
    if (!item.description) return [item.line, '', '', null];
    const n = item.item_no ? `${item.item_no}. ` : '';
    const qty = item.quantity != null ? `${n}${item.quantity.toLocaleString('en-US')} ${item.unit || ''}`.trim() : '';
    const total = item.total ?? (item.quantity != null && item.unit_price != null ? item.quantity * item.unit_price : null);
    return [`${n}${item.description}`, qty, item.unit_price != null ? `${n}${amount(item.unit_price)}` : '', total];
  });
}

export function buildOpportunitySheet(workbook, bids) {
  const ws = workbook.addWorksheet('Opportunity', { views: [{ state: 'frozen', ySplit: 2 }] });
  ws.columns = COLUMNS.map(([, width]) => ({ width }));

  // Row 1: title over D:G
  ws.mergeCells('D1:G1');
  const title = ws.getCell('D1');
  title.value = 'BIDDING OPPORTUNITY / PHILGEPS MERCHANT';
  title.font = { name: 'Calibri', size: 16, bold: true };
  title.alignment = { vertical: 'middle' };
  title.border = { top: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
  ws.getRow(1).height = 21.5;

  // Row 2: headers
  const header = ws.getRow(2);
  header.height = 37.5;
  COLUMNS.forEach(([label, , size], i) => {
    const cell = header.getCell(i + 1);
    cell.value = label;
    cell.font = { name: 'Calibri', size, bold: true };
    cell.fill = HEADER_FILL;
    cell.alignment = { horizontal: i === 0 ? 'left' : 'center', vertical: 'middle', wrapText: i !== 3 };
    cell.border = BOX;
  });

  let r = 3;
  for (const bid of bids) {
    const d = bid.details || {};
    const contact = splitContact(d.contact_info);
    const rows = moleculeRows(bid);
    const first = r;
    const last = r + rows.length - 1;

    // Tender facts on the block's first row
    const facts = {
      A: noticeType(d.notice_type),
      B: d.solicitation_no || '',
      C: dmy(bid.publish_date),
      D: bid.procuring_entity || '',
      E: bid.ref_no || '',
      J: d.pre_bid || '',
      K: d.bid_opening || '',
      N: d.delivery_period || '',
      O: dmyTime(d.last_updated),
      P: isoDateTime(bid.closing_date),
      Q: d.contact_name || '',
      R: contact.designation,
      S: contact.phone,
      T: contact.email,
      U: contact.address,
    };
    for (const [col, value] of Object.entries(facts)) {
      const cell = ws.getCell(`${col}${first}`);
      cell.value = value || null;
      cell.font = { name: 'Calibri', size: 11, bold: col === 'D' || col === 'L' };
      cell.alignment = CENTER;
      cell.border = BOX;
      cell.fill = col === 'D' ? HOSPITAL_FILL : WHITE_FILL;
    }
    const updated = ws.getCell(`O${first}`);
    updated.font = { name: 'Tahoma', size: 9, color: { argb: 'FF333333' } };
    if (updated.value instanceof Date) updated.numFmt = DATE_TIME_FORMAT;
    if (facts.P) ws.getCell(`P${first}`).numFmt = DATE_TIME_FORMAT;
    // Filled in by the team
    for (const col of ['L', 'M']) {
      const cell = ws.getCell(`${col}${first}`);
      cell.border = BOX;
      cell.fill = WHITE_FILL;
      cell.font = { name: 'Calibri', size: 11, bold: col === 'L' };
      cell.alignment = CENTER;
    }

    // Molecule rows
    rows.forEach(([molecule, qty, unitPrice, total], i) => {
      const row = r + i;
      const cells = { F: molecule, G: qty, H: unitPrice, I: total };
      for (const [col, value] of Object.entries(cells)) {
        const cell = ws.getCell(`${col}${row}`);
        cell.value = value === '' ? null : value;
        cell.font = ITEM_FONT;
        // F and H carry the side borders; G and I sit between them
        const sides = col === 'F' || col === 'H' ? { left: MEDIUM, right: MEDIUM } : {};
        cell.border = { ...sides, top: i === 0 ? MEDIUM : undefined, bottom: row === last ? MEDIUM : undefined };
      }
      ws.getCell(`F${row}`).fill = MOLECULE_FILL;
      ws.getCell(`F${row}`).alignment = { wrapText: true };
      ws.getCell(`G${row}`).alignment = { vertical: 'middle', wrapText: true };
      ws.getCell(`H${row}`).alignment = { vertical: 'middle', wrapText: true };
      ws.getCell(`I${row}`).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
      ws.getCell(`I${row}`).numFmt = '#,##0.00';

      // Height for this molecule row's own text
      const lines = Math.max(
        wrappedLines(molecule, WIDTH.F, 0.85),
        wrappedLines(qty, WIDTH.G, 0.85),
        wrappedLines(unitPrice, WIDTH.H, 0.85)
      );
      ws.getRow(row).height = Math.max(20, lines * SEGOE_LINE + 4);
    });

    if (last > first) for (const col of MERGED) ws.mergeCells(`${col}${first}:${col}${last}`);

    // Grow the block if a merged tender cell (hospital, contact, address...) needs more room than the molecule rows give
    const needed =
      Math.max(...MERGED.map((col) => wrappedLines(facts[col] instanceof Date ? 'mm/dd/yy hh:mm' : facts[col], WIDTH[col], 0.9))) *
        CALIBRI_LINE + 8;
    const blockRows = rows.map((_, i) => ws.getRow(first + i));
    const current = blockRows.reduce((sum, row) => sum + row.height, 0);
    if (needed > current) for (const row of blockRows) row.height += (needed - current) / blockRows.length;

    // Separator row: blank merged A:H and the tender's ABC total in I (as in the original)
    const sep = last + 1;
    ws.mergeCells(`A${sep}:H${sep}`);
    ws.getCell(`A${sep}`).border = BOX;
    const sum = ws.getCell(`I${sep}`);
    const totals = rows.map((row) => row[3]).filter((v) => typeof v === 'number');
    // Left empty when the notice gave no prices, rather than showing a misleading 0.00
    if (totals.length) sum.value = { formula: `SUM(I${first}:I${last})`, result: totals.reduce((a, b) => a + b, 0) };
    sum.font = { name: 'Segoe UI', size: 11, bold: true, color: { argb: 'FFFF0000' } };
    sum.alignment = { horizontal: 'left', vertical: 'middle' };
    sum.numFmt = '#,##0.00';
    sum.border = { top: MEDIUM, bottom: MEDIUM };
    ws.getRow(sep).height = 20;
    r = sep + 1;
  }
  return ws;
}

// Build the workbook in the browser and download it
export async function downloadOpportunityWorkbook(bids) {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  buildOpportunitySheet(workbook, bids);
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `PHILGEPS OPPORTUNITY ${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
