const fs = require('node:fs');
const path = require('node:path');
const { touchHeartbeat } = require('./philgeps-session');

// Bid documents of the screened tenders, fetched inside a logged-in session (see philgeps-session.js)
// the way the team does it by hand (worked out with the user, 2026-10-21):
// - Already ordered: My Opportunities' "Ordered By" page (ViewOrderAssocCompUI) lists the order numbers;
//   each opens the order page, where the tender's item link downloads the file.
// - Not ordered yet: member notice -> Order -> basket -> tender title -> Order Basket -> Continue ->
//   Order Confirmation -> Submit; the confirmed order page's item link downloads the file.
// Orders are only placed when every amount on the basket and confirmation pages is 0.00; anything else
// stops at that tender ('needs-payment'). Pay Online, Manual Payment and Delete are never clicked.

const HOST = 'https://notices.philgeps.gov.ph';
const NOTICE_URL = (ref) => `${HOST}/GEPS/Tender/BidNoticeAbstractUI.aspx?refID=${ref}&DirectFrom=OpenOpp&Type=category&BusCatID=99`;
const ORDERED_URL = (ref) => `${HOST}/GEPS/Tender/ViewOrderAssocCompUI.aspx?directFrom=MyOpportunitiesUI&EPSSubMenuID=32&refID=${ref}`;
// Gitignored. documents/<ref>/<file>; the dashboard serves them through /api/documents
const DOCS_DIR = path.resolve(__dirname, 'documents');
// The pages each tender went through, for diagnosing a tender that didn't download (gitignored)
const CAPTURE_DIR = path.resolve(__dirname, 'captures');
const CLICKABLE = 'a, input[type=submit], input[type=button], input[type=image], button';
// Re-check tenders without files at most this often (documents are often posted late)
const RECHECK_MS = 24 * 60 * 60 * 1000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// How far the current tender is (0-100), for the dashboard's filling number circle; set per tender by fetchDocuments
let stepTo = () => {};
// Document links already handled for the current tender (reset per tender)
let linksDone = new Set();
// PhilGEPS order numbers seen for the current tender (reset per tender), for its remark
let orderNos = [];
// One tender may take at most this long; after that it keeps the files it has and the Sync moves on
const TENDER_LIMIT_MS = 5 * 60 * 1000;
let tenderDeadline = Infinity;

// Screened tenders that need a document check: never checked, new supplements since the last check,
// or nothing downloaded yet and the last check is a day old (any age with recheckEmpty, for Sync).
// Tenders with files and pick-up-only tenders are done (until a new bid bulletin appears).
// Closed tenders are skipped.
function needsDocuments(o, { recheckEmpty = false, now = Date.now() } = {}) {
    const d = o.details || {};
    if (o.closing_date && Date.parse(o.closing_date.replace(' ', 'T') + '+08:00') < now) return false;
    if (!d.documents_checked_at) return true;
    if ((d.supplements?.length || 0) > (d.documents_supplements_seen || 0)) return true;
    if (d.documents?.length || d.documents_status === 'pick-up' || d.documents_status === 'closed') return false;
    return recheckEmpty || now - Date.parse(d.documents_checked_at) > RECHECK_MS;
}

// Per-page helpers set up once: downloads go to the folder set by setDownloadDir, pop-up windows are
// closed, and alert texts are kept so "already ordered" can be recognised
const pageState = new WeakMap();
async function prepare(page) {
    let state = pageState.get(page);
    if (state) return state;
    state = { cdp: await page.browser().target().createCDPSession(), dialogs: [], names: new Map(), completed: [] };
    // The browser's own download events: a file counts as arrived when Chrome says the download completed,
    // whatever its name (a same-name re-download used to go unnoticed until a 60 s timeout)
    state.cdp.on('Browser.downloadWillBegin', (e) => state.names.set(e.guid, e.suggestedFilename));
    state.cdp.on('Browser.downloadProgress', (e) => {
        if (e.state === 'completed') state.completed.push(state.names.get(e.guid) || null);
        if (e.state === 'canceled') state.completed.push(null);
    });
    page.on('dialog', async (dialog) => {
        state.dialogs.push(dialog.message());
        // An unanswered alert freezes the tab (the log-in tab also has its own handler; a second dismiss is harmless)
        await dialog.dismiss().catch(() => {});
    });
    page.browserContext().on('targetcreated', async (target) => {
        const popup = await target.page().catch(() => null);
        if (popup && popup !== page) await popup.close().catch(() => {});
    });
    pageState.set(page, state);
    return state;
}

async function setDownloadDir(page, dir) {
    const { cdp } = await prepare(page);
    await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: dir,
        browserContextId: page.browserContext().id,
        eventsEnabled: true
    });
}

const listFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !f.endsWith('.crdownload')) : []);

// Files of downloads completed after completedBefore (Chrome's events), waiting up to ms for the first;
// a click can start several downloads, so a moment more is given for the rest
async function waitForDownload(state, completedBefore, dir, ms = 60000) {
    const end = Date.now() + ms;
    while (Date.now() < end && state.completed.length === completedBefore) {
        touchHeartbeat();
        await wait(300);
    }
    if (state.completed.length > completedBefore) await wait(1500);
    return state.completed.slice(completedBefore).filter((name) => name && fs.existsSync(path.join(dir, name)));
}

async function goto(page, url, trail) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (/log-in\.aspx/i.test(page.url())) throw new Error('PhilGEPS session ended (sent back to the log-in page)');
    trail.push(`open ${page.url()}`);
}

// Click the clickable element with this index (document order of CLICKABLE) and let the page settle
// navigates: false for download links, which answer with a file instead of a page (waiting for a page
// change there would always run into the timeout)
async function clickAt(page, index, trail, label, { navigates = true } = {}) {
    trail.push(`click "${label}"`);
    const click = page.evaluate((i, sel) => document.querySelectorAll(sel)[i].click(), index, CLICKABLE);
    if (navigates) await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}), click]);
    else await click;
    await wait(1000);
    trail.push(`  -> ${page.url()}`);
}

function readClickables(page) {
    return page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).map((el, i) => ({
        i,
        text: (el.innerText || el.value || '').trim().replace(/\s+/g, ' '),
        href: el.getAttribute('href') || ''
    })), CLICKABLE);
}

const pageText = (page) => page.evaluate(() => document.body?.innerText || '');

// Every peso amount on the page is 0.00 (and there is at least one)
// Free order: PhilGEPS's own totals (Handling Fees, Subtotal, Tax, Total) are all 0.00. Only these labelled
// amounts count: numbers inside tender titles (e.g. "ITB No.051.26") were once misread as prices. The Subtotal
// covers every item's price.
async function allAmountsZero(page) {
    const text = (await pageText(page)).replace(/\s+/g, ' ');
    const totals = [...text.matchAll(/\b(Handling Fees|Subtotal|Tax|Total)\s+(?:Php\s*)?([\d,]+\.\d{2})\b/gi)]
        .map((m) => Number(m[2].replace(/,/g, '')));
    return totals.length >= 2 && totals.every((a) => a === 0);
}

// On an order page, the download links of this tender only (an order can include other tenders from the
// basket): postback links whose nearest surrounding element that mentions an 8-digit reference number
// mentions this one. Page-wide navigation (menus, Submit/Previous buttons) is left out.
function itemLinksOf(page, ref) {
    return page.evaluate((r, sel) => {
        const all = Array.from(document.querySelectorAll(sel));
        const SKIP = /^(log-?out|pending task|my opportunities|help|contact us|sitemap|submit|previous|back|close|delete|continue|add more items|pay online|manual payment)$/i;
        return Array.from(document.querySelectorAll('a'))
            .filter((a) => /__doPostBack/.test(a.getAttribute('href') || '') && a.innerText.trim() && !SKIP.test(a.innerText.trim()))
            .filter((a) => {
                for (let el = a.parentElement; el && el !== document.body; el = el.parentElement) {
                    // Only tender reference numbers (same leading digits as ours); order/document IDs are also 8 digits
                    const refs = ((el.innerText || '').match(/\b\d{8}\b/g) || []).filter((n) => n.slice(0, 2) === r.slice(0, 2));
                    if (!refs.length) continue;
                    if (refs) return refs.includes(r) && new Set(refs).size === 1;
                }
                return false;
            })
            .map((a) => ({ i: all.indexOf(a), text: a.innerText.trim() }));
    }, ref, CLICKABLE);
}

// Click each of the tender's item links on the current order page; returns the files that arrived
async function downloadItems(page, ref, dir, trail) {
    const got = [];
    // Pick-up documents have no file; their link only reloads the page
    if (/pick-?up/i.test((await deliveryMethodOf(page, ref)) || '')) {
        trail.push('  delivery method: Pick-Up');
        return got;
    }
    const state = await prepare(page);
    const links = await itemLinksOf(page, ref);
    trail.push(`  item links for ${ref}: ${JSON.stringify(links.map((l) => l.text))}`);
    for (const link of links) {
        if (Date.now() > tenderDeadline) {
            trail.push(`  tender time limit (${TENDER_LIMIT_MS / 60000} min) reached; keeping the files so far`);
            break;
        }
        // PhilGEPS can list a document more than once (and on several orders): one click each
        if (linksDone.has(link.text)) continue;
        linksDone.add(link.text);
        // Already downloaded by an earlier run (file named after the link): record it, don't fetch again
        const onDisk = listFiles(dir).find((f) => f.replace(/\.[^.]+$/, '') === link.text);
        if (onDisk) {
            trail.push(`  already on disk: ${onDisk}`);
            got.push({ name: onDisk, title: link.text });
            continue;
        }
        stepTo(85);
        const completedBefore = state.completed.length;
        const orderPage = page.url();
        await clickAt(page, link.i, trail, link.text, { navigates: false });
        const files = await waitForDownload(state, completedBefore, dir);
        trail.push(`  downloaded: ${JSON.stringify(files)}`);
        got.push(...files.map((name) => ({ name, title: link.text })));
        // A postback can leave the order page; come back for the next item
        if (page.url() !== orderPage) await goto(page, orderPage, trail);
    }
    return got;
}

// Already-ordered route. Returns the files, or null when PhilGEPS lists no order for this tender.
async function fromOrderedComponents(page, ref, dir, trail) {
    await goto(page, ORDERED_URL(ref), trail);
    const orders = (await readClickables(page)).filter((l) => /dgOrderDoc/.test(l.href) && /^\d+$/.test(l.text));
    trail.push(`  orders: ${JSON.stringify(orders.map((o) => o.text))}`);
    if (!orders.length) return null;
    orderNos = orders.map((o) => o.text);
    stepTo(40);
    const got = [];
    for (const [n, order] of orders.entries()) {
        if (n > 0) await goto(page, ORDERED_URL(ref), trail);
        await clickAt(page, order.i, trail, `order ${order.text}`);
        got.push(...(await downloadItems(page, ref, dir, trail)).map((f) => ({ ...f, order_no: order.text })));
    }
    return got;
}

// Not-ordered route. Returns 'ordered' (now on the confirmed order page), 'already-ordered',
// 'needs-payment', 'no-order-link' or 'order-flow-changed'.
async function placeOrder(page, o, trail) {
    const state = await prepare(page);
    await goto(page, NOTICE_URL(o.ref_no), trail);
    const order = (await readClickables(page)).find((l) => /^Order$/i.test(l.text));
    if (!order) return 'no-order-link';
    const dialogsBefore = state.dialogs.length;
    stepTo(30);
    await clickAt(page, order.i, trail, 'Order');
    if (state.dialogs.slice(dialogsBefore).some((m) => /already ordered/i.test(m))) return 'already-ordered';
    // "Tender Bid Notice is closed.": bidding has ended, nothing to order any more
    if (state.dialogs.slice(dialogsBefore).some((m) => /notice is closed/i.test(m))) return 'closed';

    // Order basket (R4): open this tender's basket entry by its title
    const titleStart = o.title.replace(/\s+/g, ' ').trim().slice(0, 40).toLowerCase();
    await page.waitForFunction((t) => (document.body?.innerText || '').replace(/\s+/g, ' ').toLowerCase().includes(t),
        { timeout: 20000, polling: 500 }, titleStart).catch(() => {});
    const entry = (await readClickables(page)).find((l) => l.href === '#' && l.text.toLowerCase().startsWith(titleStart));
    if (!entry) return 'order-flow-changed';
    stepTo(45);
    await clickAt(page, entry.i, trail, 'basket entry');

    if (!/OrderBasketUI/i.test(page.url())) return 'order-flow-changed';
    if (!(await allAmountsZero(page))) return 'needs-payment';
    const cont = (await readClickables(page)).find((l) => /^Continue$/i.test(l.text));
    if (!cont) return 'order-flow-changed';
    stepTo(60);
    await clickAt(page, cont.i, trail, 'Continue');

    // Notice for tenders closing within 5 days: go on with the order (any other warning still stops it)
    if (/WarningUI/i.test(page.url()) && /calendar days or less remaining/i.test(await pageText(page))) {
        const goOn = (await readClickables(page)).find((l) => /^Continue Order$/i.test(l.text));
        if (!goOn) return 'order-flow-changed';
        await clickAt(page, goOn.i, trail, 'Continue Order');
    }

    if (!/OrderConfirmationUI/i.test(page.url())) return 'order-flow-changed';
    if (!(await allAmountsZero(page))) return 'needs-payment';
    const submit = (await readClickables(page)).find((l) => /^Submit$/i.test(l.text));
    if (!submit) return 'order-flow-changed';
    stepTo(75);
    await clickAt(page, submit.i, trail, 'Submit');
    return /OrderID=/i.test(page.url()) ? 'ordered' : 'order-flow-changed';
}

// Delivery method PhilGEPS shows for this tender on the current order page ('Download', 'Pick-Up', ...)
async function deliveryMethodOf(page, ref) {
    const text = (await pageText(page).catch(() => '')).replace(/\s+/g, ' ');
    const m = new RegExp(`${ref} .*?(Download|Pick-Up|Courier|E-?mail)`, 'i').exec(text);
    return m ? m[1] : null;
}

// One tender: fetch its documents by whichever route applies.
// status: 'downloaded' | 'pick-up' | 'closed' | 'needs-payment' | 'no-order-link' | 'order-flow-changed' | 'none-found'
async function fetchTenderDocuments(page, o) {
    const ref = o.ref_no;
    const dir = path.join(DOCS_DIR, ref);
    fs.mkdirSync(dir, { recursive: true });
    await setDownloadDir(page, dir);
    const trail = [`${new Date().toISOString()} ${ref} ${o.title}`];
    linksDone = new Set();
    orderNos = [];
    tenderDeadline = Date.now() + TENDER_LIMIT_MS;
    stepTo(10);
    const state = await prepare(page);
    const dialogsBefore = state.dialogs.length;
    let files = null;
    let status = null;
    let ordered = false;
    try {
        files = await fromOrderedComponents(page, ref, dir, trail);
        if (files === null) {
            const result = await placeOrder(page, o, trail);
            trail.push(`order: ${result}`);
            if (result === 'ordered') {
                ordered = true;
                const orderId = /OrderID=(\d+)/i.exec(page.url());
                if (orderId) orderNos = [orderId[1]];
                files = await downloadItems(page, ref, dir, trail);
            } else if (result === 'already-ordered') {
                files = (await fromOrderedComponents(page, ref, dir, trail)) || [];
            } else {
                status = result;
                files = [];
            }
        }
        // Documents the procuring entity only hands out in person have no file on PhilGEPS
        if (!files.length && /pick-?up/i.test((await deliveryMethodOf(page, ref)) || '')) status = 'pick-up';
    } finally {
        const dialogs = state.dialogs.slice(dialogsBefore);
        if (dialogs.length) trail.push(`pop-up messages: ${JSON.stringify(dialogs)}`);
        fs.mkdirSync(CAPTURE_DIR, { recursive: true });
        // No file: keep the page PhilGEPS ended on, so the step can be fixed
        if (!files?.length) {
            trail.push(`ended on ${page.url()}`);
            trail.push(`page text: ${(await pageText(page).catch(() => '')).replace(/\s+/g, ' ').slice(0, 1500)}`);
            fs.writeFileSync(path.join(CAPTURE_DIR, `docs-${ref}.html`), await page.content().catch(() => ''));
        }
        fs.writeFileSync(path.join(CAPTURE_DIR, `docs-${ref}.txt`), trail.join('\n') + '\n');
    }

    const now = new Date().toISOString();
    const documents = files.map(({ name, title, order_no }) => ({
        name,
        title: title || name,
        size: fs.statSync(path.join(dir, name)).size,
        source: 'order',
        order_no: order_no || null,
        downloaded_at: now
    }));
    const finalStatus = status || (documents.length ? 'downloaded' : 'none-found');
    const remark = remarkFor({ status: finalStatus, files: documents.length, ordered, said: state.dialogs.slice(dialogsBefore).pop() });
    return { documents, status: finalStatus, ordered, remark };
}

// Plain-language reason for a tender's documents result, shown under Remarks in the dashboard
function remarkFor({ status, files, ordered, said }) {
    const orders = orderNos.length ? ` (order ${orderNos.join(', ')})` : '';
    const how = ordered ? `Ordered by the system on PhilGEPS (free)${orders}` : `Already ordered on PhilGEPS${orders}`;
    const philgepsSaid = said ? ` PhilGEPS said: "${said.trim()}"` : '';
    switch (status) {
        case 'downloaded':
            return `${how}; ${files} file${files === 1 ? '' : 's'} downloaded${ordered ? '' : ' from My Opportunities'}.`;
        case 'pick-up':
            return `${how}, but PhilGEPS lists the delivery method as Pick-Up: the procuring entity hands out these bid documents in person, so there is no file to download.`;
        case 'closed':
            return 'PhilGEPS said: "Tender Bid Notice is closed." Bidding has ended, so the documents can no longer be ordered.';
        case 'needs-payment':
            return 'The PhilGEPS order basket shows a fee, so the system did not order (it never pays). Order it on PhilGEPS by hand if the documents are needed.';
        case 'no-order-link':
            return `The PhilGEPS notice has no Order link, so there are no documents to order yet.${philgepsSaid} Sync checks again next time.`;
        case 'order-flow-changed':
            return `PhilGEPS showed an unexpected page while ordering, so the system stopped for this tender.${philgepsSaid} Sync tries again next time.`;
        default:
            return `${how}, but no download link for this tender was found on the order page. Sync tries again next time.`;
    }
}

// Runs inside withPhilgepsSession. Checks tenders until done or the session deadline; the rest wait for
// the next run. onStart(o) before and onDone(o, status) after each tender (status null when it failed),
// onStep(o, percent) as it moves through the steps, onProgress(done, total) after each; onDone gets the
// error message as third argument when the tender failed.
// Returns { checked, files, ordered, by_status }.
async function fetchDocuments(page, tenders, { deadline, onProgress = () => {}, onStart = () => {}, onDone = () => {}, onStep = () => {} }) {
    const report = { checked: 0, files: 0, ordered: 0, by_status: {}, unchecked: 0 };
    for (const [i, o] of tenders.entries()) {
        if (Date.now() > deadline) {
            report.unchecked = tenders.length - i;
            console.warn(`  Session time limit reached; ${report.unchecked} tenders wait for the next run`);
            break;
        }
        onStart(o);
        stepTo = (percent) => onStep(o, percent);
        try {
            const result = await fetchTenderDocuments(page, o);
            const previous = o.details?.documents || [];
            // Keep files from earlier runs; replace entries re-downloaded under the same name
            const names = new Set(result.documents.map((doc) => doc.name));
            o.details = {
                ...(o.details || {}),
                documents: [...previous.filter((doc) => !names.has(doc.name)), ...result.documents],
                documents_status: previous.length || result.documents.length ? 'downloaded' : result.status,
                documents_remark: result.remark,
                documents_checked_at: new Date().toISOString(),
                documents_supplements_seen: o.details?.supplements?.length || 0
            };
            report.checked++;
            report.files += result.documents.length;
            if (result.ordered) report.ordered++;
            report.by_status[result.status] = (report.by_status[result.status] || 0) + 1;
            console.log(`  ${o.ref_no}: ${result.status}${result.documents.length ? ` (${result.documents.map((d) => d.name).join(', ')})` : ''}`);
            await onDone(o, o.details.documents_status);
        } catch (err) {
            await onDone(o, null, err.message);
            fs.mkdirSync(CAPTURE_DIR, { recursive: true });
            fs.appendFileSync(path.join(CAPTURE_DIR, `docs-${o.ref_no}.txt`), `${new Date().toISOString()} ${o.ref_no} FAILED: ${err.message}\n`);
            // A lost session ends the pass; anything else only skips this tender
            if (/session ended/i.test(err.message)) throw err;
            console.warn(`  Could not fetch documents of ${o.ref_no}: ${err.message}`);
            // The tab died (crash, detached frame): carry on in a fresh tab of the same logged-in session
            if (page.isClosed() || /target closed|session closed|detached|protocol error|crash/i.test(err.message)) {
                const fresh = await page.browserContext().newPage().catch(() => null);
                if (!fresh) throw new Error(`The browser stopped responding (${err.message})`);
                await page.close().catch(() => {});
                page = fresh;
                console.warn('  Continuing in a fresh tab');
            }
        }
        onProgress(i + 1, tenders.length);
    }
    return report;
}

module.exports = { needsDocuments, fetchDocuments, DOCS_DIR };
