import { requireUser } from '@/lib/auth';
import { admin } from '@/lib/ocrQueue.mjs';
import { checkLogin, recordLogin } from '@/lib/loginGuard.mjs';
import { checkCode, issueCode, philgepsCookies } from '@/lib/laptopConnect.mjs';
import { LAPTOP_KIT } from '@/lib/laptopKit.generated.mjs';

// The PS-PhilGEPS pop-up log-in on a team laptop (ps-philgeps-session.js connectLaptop). The laptop keeps no key
// and no password: everything goes through here with a one-time code (lib/laptopConnect.mjs).
// POST, signed in:  { action: 'code' }  -> { code } for the link "ps-philgeps-connect:start?code=..." (Sync button)
//                   { action: 'setup' } -> { script } the laptop's setup file (Set up PS-PhilGEPS log-in.cmd)
// POST, with a log-in code (from the laptop):
//   { action: 'begin', ownAccount }          the log-in rules (lib/loginGuard.mjs), then the account to fill in
//                                            (none when the laptop has its own and the server has none)
//   { action: 'refused', detail }            PhilGEPS refused the password
//   { action: 'failed', outcome, detail }    the log-in stopped (closed window, 10 minutes passed...)
//   { action: 'done', cookies, savedAt }     logged in: the session is saved for the whole team
// GET ?file=NAME&code=SETUP_CODE: one of the laptop's files (lib/laptopKit.generated.mjs), for the setup file
const DASHBOARD_URL = (process.env.DASHBOARD_URL || 'https://government-bidding-automation.vercel.app').replace(/\/+$/, '');
const SITE = 'ps-philgeps';

const fail = (status, error, code) => Response.json({ ok: false, error, code }, { status });

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  if (!checkCode(params.get('code'), 'setup')) return fail(401, 'This setup file has expired. Download it again from the dashboard.');
  const name = params.get('file');
  if (!Object.hasOwn(LAPTOP_KIT, name)) return fail(404, 'No such file.');
  return new Response(LAPTOP_KIT[name], { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  if (body.action === 'code' || body.action === 'setup') {
    const { user, response } = await requireUser(request);
    if (response) return response;
    if (body.action === 'code') return Response.json({ ok: true, code: issueCode(user.email, 'login') });
    return Response.json({ ok: true, script: setupScript(issueCode(user.email, 'setup')) });
  }

  const by = checkCode(body.code, 'login');
  if (!by) return fail(401, 'This log-in link has expired. Press Sync on the dashboard again.');
  const source = `team laptop (${by})`;

  if (body.action === 'begin') {
    const username = process.env.PS_PHILGEPS_USERNAME;
    const password = process.env.PS_PHILGEPS_PASSWORD;
    const known = Boolean(username && password);
    if (!known && !body.ownAccount) return fail(500, 'The PS-PhilGEPS account is not set on the dashboard yet (Vercel settings: PS_PHILGEPS_USERNAME, PS_PHILGEPS_PASSWORD).', 'NO_CREDENTIALS');
    try {
      await checkLogin(SITE);
    } catch (e) {
      return fail(429, e.message, 'LOGIN_PAUSED');
    }
    await recordLogin(SITE, 'started', { source });
    return Response.json(known ? { ok: true, username, password } : { ok: true });
  }
  if (body.action === 'refused') {
    await recordLogin(SITE, 'rejected', { detail: body.detail, source });
    return Response.json({ ok: true });
  }
  if (body.action === 'failed') {
    await recordLogin(SITE, body.outcome === 'cancelled' ? 'cancelled' : 'error', { detail: body.detail, source });
    return Response.json({ ok: true });
  }
  if (body.action === 'done') {
    const cookies = philgepsCookies(body.cookies);
    if (!cookies) return fail(400, 'The laptop sent no PS-PhilGEPS session.');
    const savedAt = Number.isNaN(Date.parse(body.savedAt)) ? new Date().toISOString() : new Date(body.savedAt).toISOString();
    const db = admin();
    const { error } = await db.from('ps_philgeps_session').upsert({ id: 'current', cookies, saved_at: savedAt });
    if (error) return fail(500, `Logged in, but the session could not be saved: ${error.message}`);
    await db.from('ps_sync_status').update({ connected_at: savedAt }).eq('id', 'latest');
    await recordLogin(SITE, 'ok', { source });
    return Response.json({ ok: true });
  }
  return fail(400, 'Unknown action.');
}

// The laptop's setup file (Windows). Checks Node.js and Google Chrome, downloads the log-in files into
// %LOCALAPPDATA%\PS-PhilGEPS Connect, installs them (without Puppeteer's own browser: the installed Chrome is
// used) and teaches Windows the "ps-philgeps-connect:" link (tools/register-connect-link.js, this user only).
function setupScript(code) {
  const files = Object.keys(LAPTOP_KIT).join("','");
  const lines = [
    '@echo off',
    'setlocal',
    'title Set up PS-PhilGEPS log-in',
    `set "DASH=${DASHBOARD_URL}"`,
    `set "CODE=${code}"`,
    'set "DIR=%LOCALAPPDATA%\\PS-PhilGEPS Connect"',
    'echo Setting up the PS-PhilGEPS log-in on this laptop. This takes a few minutes.',
    'echo.',
    'where node >nul 2>nul',
    'if errorlevel 1 goto nonode',
    'set "CHROME="',
    'if exist "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" set "CHROME=1"',
    'if exist "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" set "CHROME=1"',
    'if exist "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe" set "CHROME=1"',
    'if not defined CHROME goto nochrome',
    'if not exist "%DIR%\\tools" mkdir "%DIR%\\tools"',
    'echo 1/3 Downloading the log-in files...',
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol='Tls12'; foreach ($f in @('${files}')) { Invoke-WebRequest -UseBasicParsing -Uri ('%DASH%/api/ps-philgeps/laptop?code=%CODE%&file=' + [uri]::EscapeDataString($f)) -OutFile (Join-Path '%DIR%' $f) }; $v = Join-Path '%DIR%' 'Connect PS-PhilGEPS.vbs'; [IO.File]::WriteAllText($v, ([IO.File]::ReadAllText($v) -replace '\\r?\\n', [Environment]::NewLine))"`,
    'if errorlevel 1 goto nodownload',
    'echo 2/3 Installing (one time)...',
    'cd /d "%DIR%"',
    'set "PUPPETEER_SKIP_DOWNLOAD=true"',
    'call npm install --omit=dev --no-audit --no-fund --loglevel=error',
    'if errorlevel 1 goto noinstall',
    'echo 3/3 Linking the dashboard Sync button to this laptop...',
    'node tools\\register-connect-link.js',
    'if errorlevel 1 goto noinstall',
    'echo.',
    'echo Done. On the dashboard press Sync PS-PhilGEPS: the log-in opens here in a small Chrome window.',
    'pause',
    'exit /b 0',
    ':nonode',
    'echo Node.js is needed first. Installing it...',
    'winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements',
    'if errorlevel 1 echo Could not install it here. Install the LTS version from https://nodejs.org then run this file again.',
    'echo.',
    'echo Then close this window and double-click this setup file again to finish.',
    'pause',
    'exit /b 1',
    ':nochrome',
    'echo Google Chrome is needed. Install it from https://www.google.com/chrome/ then run this file again.',
    'pause',
    'exit /b 1',
    ':nodownload',
    'echo The files could not be downloaded. Check the internet; if it says expired, download the setup file again from the dashboard.',
    'pause',
    'exit /b 1',
    ':noinstall',
    'echo The setup did not finish. Run this file again; if it keeps failing, tell the admin.',
    'pause',
    'exit /b 1',
  ];
  return `${lines.join('\r\n')}\r\n`;
}
