// Tender type for the dashboards' Type column and the Excel export's Type column, one rule for both portals.
// Returns { code, title }: code is the short label (ITB, RFQ, RFP, Negotiated...), title the full wording.

// PhilGEPS states the notice type: "Invitation to Bid (ITB)", "Request for Quotation (RFQ)",
// "Request for Proposal (RFP)", "Notice for Negotiated Procurement"
export function philgepsType(noticeType, mode) {
  const title = [noticeType, mode].filter(Boolean).join(' · ');
  if (!noticeType) return { code: '', title };
  const abbreviation = /\(([^)]+)\)\s*$/.exec(noticeType)?.[1];
  if (abbreviation) return { code: abbreviation, title };
  if (/negotiated/i.test(noticeType)) return { code: 'Negotiated', title };
  return { code: noticeType, title };
}

// PS-PhilGEPS gives only the mode of procurement: "Competitive Bidding (Public Bidding)", "Small Value Procurement"
export function psType(mode = '') {
  if (/public bidding|competitive bidding/i.test(mode)) return { code: 'ITB', title: mode };
  if (/small value|shopping/i.test(mode)) return { code: 'RFQ', title: mode };
  if (/negotiated/i.test(mode)) return { code: 'Negotiated', title: mode };
  return { code: mode, title: mode };
}
