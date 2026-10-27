// Pre-bid conference and bid opening schedule, read from the public notice text.
// The Bid Data Sheet in the bid documents has these too, but those files need a PhilGEPS log-in.

const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?';
// "27/10/2026", "October 27, 2026", "28 OCTOBER 2026" plus an optional time ("at 10:00am", "– 1:30 P.M."), or a
// schedule list's "November 19, 9:00 a.m." with no year (Taguig), the year then taken from the text (withYear)
const DATE = `(?:\\d{1,2}\\/\\d{1,2}\\/\\d{4}|${MONTH}\\s+\\d{1,2}\\s*,?\\s+\\d{4}|\\d{1,2}\\s+${MONTH},?\\s+\\d{4}|${MONTH}\\s+\\d{1,2}(?!\\d))`;
const TIME = '\\d{1,2}(?::\\d{2})?\\s*(?:[ap]\\.?\\s?m\\.?)';
// ("OCTOBER 26 , 2026 @ 1:00PM")
const DATE_TIME = new RegExp(`${DATE}(?:[\\s,–@-]*(?:at\\s+)?\\(?${TIME}\\)?)?`, 'i');

const clean = (s) => s.replace(/\s+/g, ' ').replace(/[\s,;:.]+$/, '').trim();

// The value of a standard ITB sentence ("will hold a Pre-Bid Conference on October 27, 2026 at 10:00am, which ...")
// up to where the venue or the next clause starts
function sentenceValue(text, lead) {
    const m = new RegExp(`${lead}\\s+([\\s\\S]{1,140}?)(?=,?\\s+(?:which|at the|at (?:its|their)|in the|via|through)\\b|\\s+at\\s+[A-Z][a-z]|\\.\\s|\\n|$)`, 'i').exec(text);
    return m ? clean(m[1]) : null;
}

// First date shortly after a label, for schedule tables ("Pre-bid Conference / Date / Time / Venue / 27/10/2026 2:00 PM")
function dateAfter(text, label) {
    const re = new RegExp(label, 'gi');
    for (let m = re.exec(text); m; m = re.exec(text)) {
        const from = m.index + m[0].length;
        const found = DATE_TIME.exec(text.slice(from, from + 120));
        if (found) return withYear(clean(found[0]), text, from + found.index);
    }
    return null;
}

// A date written without its year ("November 19, 9:00 a.m.") gets the year of the nearest full date before it in
// the text ("Deadline for submission of Bids – November 19, 2026, 8:30 a.m."), else of the first one after it
function withYear(value, text, at) {
    if (/\d{4}/.test(value)) return value;
    const years = [...text.matchAll(/\b20\d{2}\b/g)];
    const year = (years.filter((y) => y.index < at).pop() || years.find((y) => y.index > at))?.[0];
    return year ? value.replace(new RegExp(`^(${MONTH}\\s+\\d{1,2})`, 'i'), `$1, ${year}`) : value;
}

function extractSchedule(text) {
    if (!text) return { pre_bid: null, bid_opening: null };
    const pre_bid =
        sentenceValue(text, 'Pre-?\\s?Bid Conference\\s+(?:on|scheduled on|is scheduled on|shall be (?:held|conducted) on)') ||
        dateAfter(text, 'Pre-?\\s?Bid(?:ding)? Conference');
    const bid_opening =
        sentenceValue(text, 'Bid opening shall be on') ||
        sentenceValue(text, 'Bids will be opened (?:in the presence[^\\n]*?)?\\s*on') ||
        sentenceValue(text, 'opening of bids (?:shall|will) be (?:held |conducted )?on') ||
        // "rejected at bid opening" is boilerplate, not a schedule
        // "Bidding Proper and Opening of Bid Envelopes – November 19, 9:00 a.m." (Taguig)
        dateAfter(text, '(?<!rejected at )(?:Opening of Bids|Bid Opening|Opening of (?:the )?Bid (?:Envelopes|Proposals))');
    return { pre_bid, bid_opening };
}

module.exports = { extractSchedule };
