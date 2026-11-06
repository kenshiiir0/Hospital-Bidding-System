import nodemailer from 'nodemailer';
import { parse } from 'node-html-parser';
import { logActivity } from './activityLog.mjs';
import { routeAward } from './awardRouting.mjs';

// Emails the hospital's representative (awardRouting.mjs) when the PS-PhilGEPS Sync finds an award notice
// "Pending for Acceptance", so it gets accepted or refused in time. Once per award (table award_notifications);
// a failed send is tried again by the next Syncs, at most MAX_ATTEMPTS times.
// The award list has no agency column: the award's own page (/BidAwards/viewAwardNotice/<no>) is read for the
// hospital, contract amount and award date (one page per new award, read only).
// Sent by SMTP with an app password: SMTP_USER, SMTP_PASS, optional MAIL_FROM, optional SMTP_HOST for an account
// that isn't Gmail / Google Workspace (Zoho: smtp.zoho.com, or smtppro.zoho.com for a paid Zoho organisation;
// port 465, SMTP_PORT to change it). Not set = nothing is sent or recorded, so the waiting awards go out once it is set.
// Plain .mjs (no Next imports) so tools/check-award-routing.mjs can run it with node.

const HOST = 'https://philgeps.gov.ph';
const MAX_ATTEMPTS = 3;
const PENDING = /pending/i;

export const mailConfigured = () => Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);

const clean = (s) => (s || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// The fields of an award's page that go into the email
export function readAwardPage(html) {
  const field = (label) => clean(html.match(new RegExp(`<label[^>]*>\\s*${label}\\s*:?\\s*</label>\\s*<br\\s*/?>\\s*(?:<div[^>]*>)?([^<]*)`, 'i'))?.[1]);
  const root = parse(html);
  return {
    agency: clean(root.querySelector('center.verdhana_bold_twelvepx')?.text),
    address: clean(root.querySelector('center.verdhana_twelvepx')?.text),
    noticeRef: field('Notice Reference Number'),
    budget: field('Approved Budget for the Contract'),
    contractAmount: field('Contract Amount'),
    awardDate: field('Award Date'),
    brand: field('Brand Name'),
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// The deployed dashboard's Award Notices page (asks to sign in first when needed)
// The deployed dashboard (DASHBOARD_URL when the address changes, e.g. after renaming the Vercel project)
const DASHBOARD = process.env.DASHBOARD_URL || 'https://government-bidding-automation.vercel.app';
const dashboardUrl = () => {
  const host = process.env.DASHBOARD_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`) || DASHBOARD;
  return `${host.replace(/\/$/, '')}/ps-philgeps/awards`;
};

export function composeEmail({ award, lineItem, details, route }) {
  const hospital = route.hospital?.name || details.agency || 'a hospital';
  const greeting = route.hospital ? `Hi ${route.to[0].name.split(' ')[0]},` : 'Hi Aljean and Jimmy,';
  const intro = route.hospital
    ? `${hospital} (your hospital on the served list) has an award notice for 2MG Incorporated waiting for our answer on PS-PhilGEPS.`
    : `${details.agency || 'A hospital'} is not on the served list of hospitals, so this award notice comes to you. It is waiting for our answer on PS-PhilGEPS.`;
  const rows = [
    ['Hospital', details.agency || hospital],
    ['Line item', lineItem],
    ['Award notice no.', award],
    ['Notice reference no.', details.noticeRef],
    ['Contract amount', details.contractAmount],
    ['Approved budget', details.budget],
    ['Award date', details.awardDate],
    ['Brand', details.brand],
  ].filter(([, v]) => v);
  const awardLink = `${HOST}/BidAwards/viewAwardNotice/${award}`;
  const dash = dashboardUrl();
  const next = `Please sign in to the Government Bidding System and accept or refuse it (Award Notices → Accept / Refuse): ${dash}`;
  const text = [greeting, '', intro, '', ...rows.map(([k, v]) => `${k}: ${v}`), '', next, `Award notice on PS-PhilGEPS: ${awardLink}`, '', 'Government Bidding System (automatic message)']
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">
<p>${esc(greeting)}</p><p>${esc(intro)}</p>
<table style="border-collapse:collapse;margin:8px 0">${rows.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#555">${esc(k)}</td><td style="padding:4px 0;font-weight:600">${esc(v)}</td></tr>`).join('')}</table>
<p>Please sign in to the Government Bidding System and accept or refuse it (Award Notices → Accept / Refuse).</p>
<table role="presentation" cellspacing="0" cellpadding="0" style="margin:16px 0"><tr><td style="border-radius:8px;background:#1EA0DA"><a href="${esc(dash)}" style="display:inline-block;padding:12px 24px;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px">Log in to Government Bidding System</a></td></tr></table>
<p style="font-size:13px"><a href="${esc(awardLink)}" style="color:#12769F">Open the award notice on PS-PhilGEPS</a></p>
<p style="color:#888;font-size:12px">Government Bidding System (automatic message)</p></div>`;
  return { subject: `Award notice waiting for our answer: ${hospital} · ${lineItem} (No. ${award})`, text, html };
}

let transport;
// The award e-mails' mailbox, also used by Message Hospitals (api/hospitals/message): sendMail(nodemailer message)
export async function sendMail(message) {
  const auth = { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS };
  const port = Number(process.env.SMTP_PORT) || 465;
  transport ||= process.env.SMTP_HOST
    ? nodemailer.createTransport({ host: process.env.SMTP_HOST, port, secure: port === 465, auth })
    : nodemailer.createTransport({ service: 'gmail', auth });
  const from = process.env.MAIL_FROM || `"Government Bidding System" <${process.env.SMTP_USER}>`;
  return transport.sendMail({ from, ...message });
}

async function send({ to, cc, subject, text, html }) {
  const who = (people) => people.map((p) => `"${p.name}" <${p.email}>`).join(', ');
  await sendMail({ to: who(to), cc: cc.length ? who(cc) : undefined, subject, text, html });
}

/**
 * Called by the Sync with the award list it just read. readPage(url) -> html (the Sync's session).
 * dryRun: reads and routes, sends and records nothing. Returns [{ award, agency, to, cc, status, error? }].
 * Never throws (the Sync's result must not depend on email).
 */
export async function notifyPendingAwards(supabase, awards, readPage, { dryRun = false } = {}) {
  if (!dryRun && !mailConfigured()) return [];
  const col = (name) => awards?.headers.findIndex((h) => new RegExp(name, 'i').test(h)) ?? -1;
  const [accCol, itemCol] = [col('acceptance'), col('line item')];
  const pending = (awards?.rows || []).filter((r) => PENDING.test(r.cells[accCol] || '') && /^\d+$/.test(r.cells[0]));
  if (!pending.length) return [];
  const { data: done, error } = await supabase.from('award_notifications').select('award_no, status, attempts').in('award_no', pending.map((r) => r.cells[0]));
  if (error) return [{ status: 'failed', error: `Reading award_notifications: ${error.message}` }];
  const known = new Map((done || []).map((d) => [d.award_no, d]));
  const results = [];
  for (const row of pending) {
    const award = row.cells[0];
    const before = known.get(award);
    if (before && (before.status === 'sent' || before.attempts >= MAX_ATTEMPTS)) continue;
    const lineItem = row.cells[itemCol] || '';
    let result = { award, line_item: lineItem };
    try {
      const details = readAwardPage(await readPage(`${HOST}/BidAwards/viewAwardNotice/${award}`));
      const route = routeAward(details.agency);
      result = { ...result, agency: details.agency, hospital_no: route.hospital?.no ?? null, recipients: [...route.to, ...route.cc].map((p) => p.email), to: route.to, cc: route.cc };
      if (!details.agency) throw new Error('The award page shows no hospital name.');
      if (!dryRun) await send({ to: route.to, cc: route.cc, ...composeEmail({ award, lineItem, details, route }) });
      result.status = 'sent';
    } catch (e) {
      if (e.code === 'NOT_CONNECTED') throw e;
      result.status = 'failed';
      result.error = e.message;
    }
    results.push(result);
    if (dryRun) continue;
    const now = new Date().toISOString();
    await supabase
      .from('award_notifications')
      .upsert({
        award_no: award,
        line_item: lineItem,
        agency: result.agency || null,
        hospital_no: result.hospital_no ?? null,
        recipients: result.recipients || [],
        status: result.status,
        error: result.error || null,
        attempts: (before?.attempts || 0) + 1,
        sent_at: result.status === 'sent' ? now : null,
        updated_at: now,
      })
      .then(() => {}, () => {});
    const names = (result.to || []).map((p) => p.name).join(', ');
    await logActivity({
      event: 'award-email',
      status: result.status === 'sent' ? 'success' : 'failed',
      by: 'schedule',
      summary:
        result.status === 'sent'
          ? `Emailed ${names} about award notice ${award} (${result.agency} · ${lineItem}), back-ups copied.`
          : `Award notice ${award} email not sent: ${result.error}`,
      details: { award, agency: result.agency, recipients: result.recipients },
    });
  }
  return results;
}
