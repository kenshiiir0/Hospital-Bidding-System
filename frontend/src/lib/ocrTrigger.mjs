import { admin, scannedWaiting } from './ocrQueue.mjs';

// Starts the GitHub OCR job (.github/workflows/ocr.yml) right after a Sync, so the scanned documents it brought
// are read within minutes instead of at the next hourly run: at the end of a PhilGEPS Sync (it reads its
// documents itself), at the end of a PS-PhilGEPS Sync, and when the 5-minute reading (keep-alive) has just read
// new PS-PhilGEPS documents (they are read there, minutes after the PS-PhilGEPS Sync). The OCR
// itself runs on GitHub; the deployed server only sends this request. Needs GITHUB_OCR_TOKEN: a GitHub
// fine-grained token for this repository with "Actions: Read and write". Without it this does nothing (the
// hourly run still comes). Never throws: a Sync must not fail because of this.

const REPO = process.env.GITHUB_REPOSITORY_NAME || 'kenshiiir0/Hospital-Bidding-System';
const WORKFLOW = 'ocr.yml';
// A request made this recently, or a run going, already covers this Sync (the job reads everything waiting)
const RECENT_MS = 10 * 60 * 1000;

export async function triggerOcr(reason) {
  try {
    const token = process.env.GITHUB_OCR_TOKEN;
    if (!token) return { started: false, why: 'GITHUB_OCR_TOKEN is not set' };
    const supabase = admin();
    const { data: status } = await supabase.from('ocr_status').select('github_requested_at, github_running_since').eq('id', 'latest').single();
    const within = (at, ms) => at && Date.now() - new Date(at).getTime() < ms;
    // A "running" mark older than the job's 60-minute limit is left over from a run GitHub stopped
    if (within(status?.github_requested_at, RECENT_MS) || within(status?.github_running_since, 70 * 60 * 1000)) {
      return { started: false, why: 'already requested or running' };
    }
    // Only when scanned documents wait (GitHub's monthly minutes are limited on a private repository)
    const waiting = await scannedWaiting(supabase);
    if (!waiting.length) return { started: false, why: 'nothing scanned is waiting' };

    const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      body: JSON.stringify({ ref: 'main' }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status !== 204) {
      const body = await res.text().catch(() => '');
      await supabase.from('ocr_status').update({ github_last_result: `Could not start after ${reason}: HTTP ${res.status} ${body.slice(0, 150)}` }).eq('id', 'latest');
      return { started: false, why: `GitHub answered ${res.status}` };
    }
    await supabase.from('ocr_status').update({ github_requested_at: new Date().toISOString() }).eq('id', 'latest');
    return { started: true };
  } catch (e) {
    return { started: false, why: e.message };
  }
}
