import { requireUser } from '@/lib/auth';
import { mailConfigured, sendMail } from '@/lib/awardNotify.mjs';
import { logActivity } from '@/lib/activityLog.mjs';
import { createClient } from '@supabase/supabase-js';
import { MESSAGE_TEST_TO } from '@/lib/messageTestMode';
import { buildHospitalEmail, themeImages, titleCase, SETTINGS, THEMES } from '@/lib/hospitalEmail.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Sender name the hospitals see (the address stays the SMTP mailbox); award e-mails to the team keep their own name
const HOSPITAL_FROM = () => `"2MG Incorporated" <${process.env.SMTP_USER}>`;

export const maxDuration = 120;

// Vercel refuses request bodies over 4.5 MB, so the attachments together stay under 4 MB
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const ALLOWED = /^(image\/(png|jpe?g|gif|webp)|application\/pdf|application\/(msword|vnd\.ms-excel|vnd\.ms-powerpoint)|application\/vnd\.openxmlformats-officedocument\.[a-z.]+|text\/(plain|csv))$/i;

function admin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  return createClient(url, process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The design's pictures (public/email/, shipped with this route by next.config.mjs) go inside every e-mail,
// shown in place by their cid, so they appear without being hosted anywhere
async function inlineImages(theme, withClip, origin) {
  return Promise.all(
    [...themeImages(theme), ...(withClip ? [SETTINGS.clipIcon] : [])].map(async (file) => {
      let content;
      try {
        content = await readFile(path.join(process.cwd(), 'public', 'email', file));
      } catch {
        const res = await fetch(`${origin}/email/${file}`);
        if (!res.ok) throw new Error(`The e-mail picture ${file} could not be loaded.`);
        content = Buffer.from(await res.arrayBuffer());
      }
      return { filename: file, content, contentType: 'image/png', cid: file, contentDisposition: 'inline' };
    })
  );
}

// Message Hospitals (Hospital List): one e-mail per chosen hospital, to that hospital's own addresses, with the
// same subject, message and attachments. {hospital} in the subject or message becomes the hospital's name.
// multipart form: subject, message, theme (lib/hospitalEmail.mjs THEMES), keys (JSON array of agency_key), files (0+).
// Sent from the award e-mails' mailbox in the branded design the dialog previews.
export async function POST(request) {
  const { user, response } = await requireUser(request);
  if (response) return response;
  if (!mailConfigured()) {
    return Response.json({ ok: false, error: 'E-mail is not set up on the server yet (SMTP_USER / SMTP_PASS on Vercel). Nothing was sent.' }, { status: 503 });
  }
  const form = await request.formData().catch(() => null);
  if (!form) return Response.json({ ok: false, error: 'The message could not be read. Please try again.' }, { status: 400 });

  const subject = String(form.get('subject') || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const message = String(form.get('message') || '').replace(/\r\n/g, '\n').trim().slice(0, 10000);
  const theme = THEMES[String(form.get('theme'))] ? String(form.get('theme')) : 'standard';
  let keys = [];
  try {
    keys = JSON.parse(String(form.get('keys') || '[]'));
  } catch {}
  if (!subject || !message) return Response.json({ ok: false, error: 'Please fill in the subject and the message.' }, { status: 400 });
  if (!MESSAGE_TEST_TO && (!Array.isArray(keys) || !keys.length || keys.length > 200 || keys.some((k) => typeof k !== 'string'))) {
    return Response.json({ ok: false, error: 'Please choose at least one hospital.' }, { status: 400 });
  }

  const files = form.getAll('files').filter((f) => f && typeof f === 'object' && f.size > 0);
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > MAX_ATTACHMENT_BYTES) return Response.json({ ok: false, error: 'The attachments are over 4 MB together. Please send smaller files.' }, { status: 400 });
  const refused = files.find((f) => !ALLOWED.test(f.type || ''));
  if (refused) return Response.json({ ok: false, error: `${refused.name} cannot be attached (images, PDF, Word, Excel, PowerPoint, text or CSV only).` }, { status: 400 });
  // Read once, attached to every e-mail
  const attachments = await Promise.all(files.map(async (f) => ({ filename: f.name, contentType: f.type, content: Buffer.from(await f.arrayBuffer()) })));
  let pictures;
  try {
    pictures = await inlineImages(theme, files.length > 0, new URL(request.url).origin);
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }

  const branded = (fill, hospital) => buildHospitalEmail({ subject: fill(subject), message: fill(message), hospital, files, theme, src: (file) => `cid:${file}` });
  const results = [];

  if (MESSAGE_TEST_TO) {
    // Test mode: hospitals are deactivated. The chosen keys are ignored and no hospital row is read;
    // exactly one e-mail goes to the test address, with {hospital} shown as "Sample Hospital".
    const fill = (s) => s.replaceAll('{hospital}', 'Sample Hospital');
    const email = branded(fill, 'Sample Hospital');
    const text = email.text;
    const html = `<div style="font-family:Arial,sans-serif;font-size:12px;color:#7A4B00;background:#FFF4DB;border:1px solid #F0D58C;border-radius:8px;padding:8px 12px;margin-bottom:12px">TEST — Message Hospitals is routed only to ${esc(MESSAGE_TEST_TO)} for testing. No hospital received this e-mail.</div>${email.html}`;
    try {
      await sendMail({ from: HOSPITAL_FROM(), to: MESSAGE_TEST_TO, subject: fill(subject), text, html, attachments: [...pictures, ...attachments] });
      results.push({ name: 'Test e-mail', status: 'sent', to: [MESSAGE_TEST_TO], test: true });
    } catch (e) {
      results.push({ name: 'Test e-mail', status: 'failed', to: [MESSAGE_TEST_TO], error: e.message });
    }
  } else {
    const { data: hospitals, error } = await admin().from('hospitals').select('agency_key, name, emails').in('agency_key', keys).not('status', 'is', null).is('archived_at', null);
    if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
    for (const h of hospitals) {
      if (!h.emails?.length) {
        results.push({ name: h.name, status: 'skipped', error: 'No e-mail address' });
        continue;
      }
      const fill = (s) => s.replaceAll('{hospital}', titleCase(h.name));
      const { html, text } = branded(fill, h.name);
      try {
        await sendMail({ from: HOSPITAL_FROM(), to: h.emails.join(', '), subject: fill(subject), text, html, attachments: [...pictures, ...attachments] });
        results.push({ name: h.name, status: 'sent', to: h.emails });
      } catch (e) {
        results.push({ name: h.name, status: 'failed', to: h.emails, error: e.message });
      }
    }
  }

  const sent = results.filter((r) => r.status === 'sent').length;
  const failed = results.filter((r) => r.status === 'failed');
  await logActivity({
    event: 'hospital-message',
    status: !sent ? 'failed' : failed.length ? 'partial' : 'success',
    by: user.email,
    summary: MESSAGE_TEST_TO
      ? `TEST message "${subject}" ${sent ? 'e-mailed' : 'not sent'} to ${MESSAGE_TEST_TO} (no hospital)`
      : `Message "${subject}" e-mailed to ${sent} of ${results.length} hospital${results.length === 1 ? '' : 's'}`,
    details: { subject, message, theme, attachments: files.map((f) => f.name), results },
  });
  return Response.json({ ok: sent > 0, sent, results });
}
