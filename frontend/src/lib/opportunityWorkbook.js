// Builds the "Opportunity" sheet in the same layout as the team's PHILGEPS OPPORTUNITY.xlsx:
// a title row, a header row, then one block per tender (tender facts merged down the block,
// one row per requested molecule) separated by a blank merged row.
// Tenders from both portals are first turned into one shape (philgepsTender / psTender below):
//   { type, solicitationNo, published: "YYYY-MM-DD", hospital, ref, molecules: [[molecule, qty, unitPrice, total]],
//     preBid, bidOpening, deliveryPeriod, lastUpdated: Date|text, closing: Date, contactName, designation,
//     phone, email, address }

// Same Type as the dashboards' Type column
import { philgepsType, psType } from './tenderType';
// Bid dates and delivery period read in the bid documents, cut to the value alone
import { bidDateText, deliveryText } from './bidDates';

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

// Words that belong to the product's own description after a comma ("2 mL", "vial", "Isobaric")
const FORM_WORD =
  /\b(?:tab|tabs|tablets?|caps?|capsules?|vials?|amp|ampules?|ampoules?|polyamp|syringes?|pfs|pre-?filled|bottles?|sachets?|solution|suspension|syrup|oral|drops?|cream|ointment|oint|tube|bag|powder|inj|injection|emulsion|nebules?|patch|suppository|isobaric|heavy|plain|hyperbaric|spinal)\b/i;
const STRENGTH = /\d\s*(?:mg|g|gm|mcg|ml|l|iu|%|units?|meq|mmol)\b/i;

// A cell repeated back to back by a document table ("Epoeitin Alfa Epoeitin Alfa 4000iu", "X/ X/ 103 Box"): once
function collapseRepeats(text) {
  let s = text;
  for (let before = ''; before !== s; ) {
    before = s;
    s = s.replace(/^(.{6,}?)[\s/,.]+\1(?=[\s/,.]|$)/i, '$1');
  }
  return s;
}

// A line as the document gives it, without the table rules a scan's OCR left in ("| 60 | vials | Cefoxitin ... |")
export const asWritten = (text) => String(text || '').replace(/\s*[|[\]]+\s*/g, ' ').replace(/\s+/g, ' ').trim();

// Unit words a table puts in front of the product ("vials", "boxes", "prefilled syringe")
const UNIT_WORDS = /\b(?:pre-?\s?filled|syringes?|bottles?|btls?|boxes|box|bxs?|vials?|tabs?|tablets?|caps?|capsules?|amps?|ampules?|ampoules?|pcs|pieces|sachets?|tubes?|packs?|units?|each)\b/gi;

// The Molecule cell keeps the product as the team writes it (molecule, strength, form: "Cefazolin 1g vial"):
// item codes, pack sizes, quantities, prices and requirements written after the product are dropped,
// e.g. "DM290. Cefazolin Sodium Salt 1g Vial with up to date local assay among..." -> "Cefazolin Sodium Salt 1g Vial"
// names: our products the line names (item.our_products / item.products): the Molecule cell starts at the first
// one, so what a scan's table put before it goes ("60 | vas] Cefoxitin 1g ...", "SET a Loratadine 10mg ...") —
// unless that is part of the product ("Ferrous sulfate + Folic Acid", "Sodium Bicarbonate ...").
export function moleculeText(text, names = []) {
  // Table rules a scan's OCR left in ("|", "[", "]") are never part of the product
  const original = String(text || '').replace(/\s*[|[\]]+\s*/g, ' ').replace(/\s+/g, ' ').trim();
  let s = original;
  const starts = names
    .map((name) => new RegExp(`\\b${name.slice(0, 5).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').exec(s)?.index ?? -1)
    .filter((i) => i > 0);
  if (starts.length) {
    const before = s.slice(0, Math.min(...starts));
    const words = before.replace(UNIT_WORDS, ' ').match(/[A-Za-z]{4,}/g) || [];
    if (!/\+/.test(before) && !words.length) s = s.slice(Math.min(...starts));
  }
  // Table debris from documents: a leading "|", quote marks, ", -" before a strength ("VANCOMYCIN , -1g")
  s = s.replace(/^[|"'“”‘’\s]+|["'“”‘’\s]+$/g, '').replace(/\s*,\s*-\s*(?=\d)/g, ' ');
  // A line read twice from a table ("Cetirizine 10mg tab / Cetirizine 10mg tab / 103 Box"): keep the first part
  if (/\s\/\s/.test(s)) {
    const [head] = s.split(/\s+\/\s+/);
    if (/[A-Za-z]{3}/.test(head) && /\d/.test(head)) s = head;
  }
  s = s.replace(/\s+and other items?\b.*$/i, '');
  s = collapseRepeats(s);
  s = s.replace(/\s*\/\s*\d[\d,]*\s+[A-Za-z]+\.?$/, ''); // "... / 103 Box"
  s = s.replace(/\s+:\s*/g, ' '); // "Cefazolin : 1g"
  // Line numbers, a unit word or a stray "of" left in front by the table ("16. bottles Cetirizine ...")
  s = s.replace(/^\d{1,4}[.)]\s+/, '');
  s = s.replace(/^(?:bottles?|btls?|boxes|box|bxs?|vials?|tabs?|tablets?|caps?|capsules?|amps?|ampules?|ampoules?|pcs|pieces|sachets?|tubes?|packs?)\.?\s+(?=[A-Za-z])/i, '');
  s = s.replace(/^(?:of|the|for|and)\s+/i, '');
  s = s.replace(/^[A-Z]{1,4}-?\d+[.):-]?\s+/, ''); // item codes such as "DM290."
  s = s.replace(/^[\d,]+(?:\.\d+)?\s+(?!(?:mg|g|gm|mcg|ml|l|iu|units?)\b)(?=[A-Za-z(])/i, ''); // a quantity or line number written first
  s = s.replace(/\s*[_….·\-–—]{3,}.*$/, ''); // fill-in lines "______", "………"
  // Requirements and remarks: "with up to date local assay...", "without porcine content", "CPR & COD", "@ 920.00"
  s = s.replace(/\s+(?:with(?!\s*\d)|without|among|which|that|must|should|compliant|comply|registered|certified|CPR\b|COD\b|FDA\b|halal\b|and a\b|@).*$/i, '');
  // "for Inj." / "for injection" (also a hospital's "forv Inj."): the form says enough ("Cefoxitin 1g powder")
  s = s.replace(/\s+forv?\s+inj(?:ection)?\b\.?/gi, '');
  // Pack sizes and quantities: "x 100's", "(100's/box)", "100 tablet/box", "4,500 prefilled-syringe", ", 1200 Vial"
  s = s.replace(/\s+(?:x|by)\s*\d[\d,]*\s*(?:['’]?s\b)?.*$/i, '');
  s = s.replace(/[,;]?\s*(?:box\s*)?\(?\b\d+\s*(?:['’]?s|pcs)\b(?:\s*(?:\/|per)\s*box(?:es)?)?\)?/gi, '');
  s = s.replace(/\s+\d[\d,]*\s*(?:pre-?filled[- ]syringes?|tablets?\/box|pcs|pieces|boxes)\b.*$/i, '');
  // Comma-separated parts (not the comma in 10,000): everything up to the strength, then only parts with a
  // strength or a form; remarks such as ", Halal Certified" or ", 90% reduced blood transfusion..." are dropped
  const parts = s.split(/(?<!\d),(?!\d)\s*|,\s+/).map((p) => p.trim()).filter(Boolean);
  const first = parts.findIndex((p) => /\d/.test(p));
  if (first >= 0) {
    const rest = parts.slice(first + 1).filter((p) => (STRENGTH.test(p) && !/%\s*reduced/i.test(p)) || FORM_WORD.test(p));
    s = [...parts.slice(0, first + 1), ...rest].join(', ');
  } else s = parts.join(', ');
  // Prices or quantities left at the end once a strength is given: "... 5 mg 450", "... 60 mL 46.00"
  if (/\d.*\s-?[\d,]+(?:\.\d+)?$/.test(s)) s = s.replace(/(?:\s+-?[\d,]+(?:\.\d+)?)+$/, '');
  s = s.replace(/[,\s]+\d[\d,]{2,}\s+(?:capsules?|tablets?|vials?|amp\w*|bottles?)(?:\/\w+)?$/i, ''); // "..., 1200 Vial"
  s = s.replace(/\s+([),])/g, '$1').replace(/[\s,;:.\-–/]+$/, '').replace(/^[\s,;:.\-–]+/, '').trim();
  // Repeats that only show once pack sizes are gone ("X/100's X/100's" -> "X X")
  s = collapseRepeats(s).replace(/\s*\/\s*\d[\d,]*\s+[A-Za-z]+\.?$/, '').replace(/[\s,;:.\-–/]+$/, '');
  return s || original;
}

// One item line as a sheet row: [Molecule, Qty, ABC/Unit, ABC Total, quantity], as the team writes them in the
// original sheet: "AMIKACIN 500MG/2ML" | "20 amp" | 88.78 | 5000 (no item numbers; prices as numbers).
// quantity: the number in Qty, for the sheet's formulas when ABC/Unit or ABC Total is missing (buildOpportunitySheet)
function itemRow(item) {
  const text = moleculeText(item.description || item.line, item.our_products || item.products);
  if (item.quantity == null && item.unit_price == null) return [text, '', null, null, null];
  const qty = item.quantity != null ? `${item.quantity.toLocaleString('en-US')} ${item.unit || ''}`.trim() : '';
  return [text, qty, item.unit_price ?? null, item.total ?? null, item.quantity ?? null];
}

// Molecule rows: the documents hold the real data, so a product with lines read in the bid documents (lines
// with a quantity; others are context such as "Project Name: ...") gets those, and the notice's own item lines
// fill in only the products the documents don't give; else just our product names
function moleculeRows(noticeItems, documentItems, productNames) {
  const fromDocs = (documentItems || []).filter((item) => item.quantity != null);
  const inDocuments = new Set(fromDocs.flatMap((item) => item.our_products || []));
  const fromNotice = (noticeItems || []).filter((item) => !(item.products || []).length || !item.products.every((p) => inDocuments.has(p)));
  const rows = [...fromDocs, ...fromNotice];
  if (rows.length) return rows.map(itemRow);
  // No item lines read yet (e.g. scanned documents still being read with OCR)
  return [[productNames.join(', '), '', null, null]];
}

// A PhilGEPS tender (philgeps_opportunities row)
export function philgepsTender(bid) {
  const d = bid.details || {};
  const bds = d.documents_bid_data_sheet || {};
  const contact = splitContact(d.contact_info);
  return {
    type: philgepsType(d.notice_type).code,
    solicitationNo: d.solicitation_no || '',
    published: bid.publish_date || '',
    hospital: bid.procuring_entity || '',
    ref: bid.ref_no || '',
    molecules: moleculeRows(d.matched_items, d.documents_items, bid.matched_molecules || []),
    // What the bid documents say, else the notice's description (as in View details)
    preBid: bidDateText(bds.prebid_conference) || d.pre_bid || '',
    bidOpening: bidDateText(bds.bid_opening) || d.bid_opening || '',
    deliveryPeriod: deliveryText(bds.delivery_period) || d.delivery_period || '',
    lastUpdated: dmyTime(d.last_updated),
    closing: isoDateTime(bid.closing_date),
    contactName: d.contact_name || '',
    designation: contact.designation,
    phone: contact.phone,
    email: contact.email,
    address: contact.address,
  };
}

// PS-PhilGEPS writes dates as "23-Oct-2026 12:00 AM"
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function psDate(text) {
  const m = /(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM))?/i.exec(text || '');
  if (!m || !MONTHS[m[2].toLowerCase()]) return null;
  const hour = m[4] ? (+m[4] % 12) + (m[6].toUpperCase() === 'PM' ? 12 : 0) : 0;
  return { iso: `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`, date: new Date(Date.UTC(+m[3], MONTHS[m[2].toLowerCase()] - 1, +m[1], hour, +(m[5] || 0))) };
}

// The PS-PhilGEPS notice number of a Bid Match row: its link to the notice page, else a numeric first cell
export function psRefOf(row) {
  const link = row.links.find((l) => /viewBidNotice\/(\d+)/.test(l.href));
  if (link) return link.href.match(/viewBidNotice\/(\d+)/)[1];
  return /^\d+$/.test(row.cells[0]) ? row.cells[0] : null;
}

// A PS-PhilGEPS Bid Match row, with its notice (Sync) and what was read in its documents (ps_tender_analysis).
// PS-PhilGEPS shows no contact person or solicitation number, so those columns stay blank.
export function psTender(row, headers, notice, reading) {
  const cell = (name) => row.cells[headers.indexOf(name)] || '';
  const schedule = notice?.schedule || {};
  const done = reading?.status === 'done' ? reading.result : null;
  const bds = done?.bid_data_sheet || {};
  const products = [...new Set([...(notice?.matched || []), ...(done?.items || []).flatMap((i) => i.our_products)])];
  // The notice's "closing" text sometimes runs on into "Date Last updated: 14-Oct-2026 09:11 AM ..."
  const lastUpdated = psDate(schedule.lastUpdated) || psDate(/Last updated:\s*([^\n]+)/i.exec(schedule.closing || '')?.[1]);
  return {
    type: psType(cell('Mode of Procurement')).code,
    solicitationNo: '',
    published: psDate(cell('Publish Date'))?.iso || '',
    hospital: cell('Agency name'),
    ref: psRefOf(row) || '',
    molecules: moleculeRows(null, done?.items, products),
    // Date and time only, like the team's sheet (the venue is in View details)
    preBid: schedule.prebid || bidDateText(bds.prebid_conference) || '',
    bidOpening: schedule.bidOpening || bidDateText(bds.bid_opening) || '',
    deliveryPeriod: deliveryText(bds.delivery_period) || '',
    lastUpdated: lastUpdated?.date || null,
    closing: psDate(cell('Closing Date'))?.date || null,
    contactName: '',
    designation: '',
    phone: '',
    email: '',
    address: '',
  };
}

export function buildOpportunitySheet(workbook, tenders) {
  // Opens at 64% like the team's Opportunity tab; at Excel's default 100% the large fonts look zoomed in
  const ws = workbook.addWorksheet('Opportunity', { views: [{ state: 'frozen', ySplit: 2, zoomScale: 64, zoomScaleNormal: 64 }] });
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
  for (const t of tenders) {
    const rows = t.molecules;
    const first = r;
    const last = r + rows.length - 1;

    // Tender facts on the block's first row
    const facts = {
      A: t.type,
      B: t.solicitationNo,
      C: dmy(t.published),
      D: t.hospital,
      E: t.ref,
      J: t.preBid,
      K: t.bidOpening,
      N: t.deliveryPeriod,
      O: t.lastUpdated,
      P: t.closing,
      Q: t.contactName,
      R: t.designation,
      S: t.phone,
      T: t.email,
      U: t.address,
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
    rows.forEach(([molecule, qty, unitPrice, total, quantity], i) => {
      const row = r + i;
      // The team's formulas for a missing price: ABC Total = Qty x ABC/Unit, ABC/Unit = ABC Total / Qty
      // (Qty is text like "3,000 vial", so the number is written into the formula)
      const cells = { F: molecule, G: qty, H: unitPrice, I: total };
      if (quantity > 0 && total == null && typeof unitPrice === 'number') cells.I = { formula: `${quantity}*H${row}`, result: quantity * unitPrice };
      else if (quantity > 0 && unitPrice == null && typeof total === 'number') cells.H = { formula: `I${row}/${quantity}`, result: total / quantity };
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
      ws.getCell(`H${row}`).numFmt = '#,##0.00';
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
    // The ABC totals of the block, given or worked out above
    const totals = rows.map(([, , unitPrice, total, quantity]) => total ?? (quantity > 0 && typeof unitPrice === 'number' ? quantity * unitPrice : null)).filter((v) => typeof v === 'number');
    // The red sum only when there are 2 or more ABC totals to add up (as in the original); empty otherwise
    if (totals.length >= 2) sum.value = { formula: `SUM(I${first}:I${last})`, result: totals.reduce((a, b) => a + b, 0) };
    sum.font = { name: 'Segoe UI', size: 11, bold: true, color: { argb: 'FFFF0000' } };
    sum.alignment = { horizontal: 'left', vertical: 'middle' };
    sum.numFmt = '#,##0.00';
    sum.border = { top: MEDIUM, bottom: MEDIUM };
    ws.getRow(sep).height = 20;
    r = sep + 1;
  }
  return ws;
}

// Oldest published at the top, latest at the bottom (then by closing, then reference number)
export function oldestFirst(tenders) {
  const time = (d) => (d instanceof Date ? d.getTime() : 0);
  return [...tenders].sort(
    (a, b) => a.published.localeCompare(b.published) || time(a.closing) - time(b.closing) || String(a.ref).localeCompare(String(b.ref))
  );
}

// Build the workbook in the browser and download it
export async function downloadOpportunityWorkbook(tenders) {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  buildOpportunitySheet(workbook, tenders);
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
