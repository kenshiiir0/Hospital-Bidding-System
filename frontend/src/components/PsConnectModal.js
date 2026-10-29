'use client';

import Modal from '@/components/Modal';
import PsLiveLogin from '@/components/PsLiveLogin';

// The PS-PhilGEPS reconnect as a dialog: the log-in (filled in, on a cloud computer or this team computer) shows
// here and the person ticks "I'm not a robot"; the Sync then starts by itself. Closing only hides it (the log-in
// keeps waiting, ConnectNotice reopens it); Cancel stops the log-in.
const STEPS = ['Secure log-in opens', 'Tick “I’m not a robot”', 'Sync starts by itself'];

export default function PsConnectModal({ connect, onHide, onCancel }) {
  const opened = connect?.status === 'connecting';
  const step = opened ? 1 : 0;
  return (
    <Modal
      title="Reconnect PS-PhilGEPS"
      subtitle="PhilGEPS ended the log-in. Confirm you are not a robot to continue."
      width="sm:max-w-2xl"
      onClose={onHide}
      icon={
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden>
          <rect x="4" y="9" width="12" height="8" rx="2" />
          <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
        </svg>
      }
      footer={
        <>
          <p className="mr-auto text-xs text-black/46">Runs on a secure cloud computer; nothing is installed on this device.</p>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-[#E2E8F0] px-4 py-2 text-sm font-medium text-black/80 transition hover:border-[#B3312C] hover:text-[#B3312C]"
          >
            Cancel
          </button>
        </>
      }
    >
      <ol className="flex items-center gap-2 text-xs">
        {STEPS.map((label, i) => (
          <li key={label} className="flex min-w-0 flex-1 items-center gap-2">
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                i < step ? 'bg-[#61A644] text-white' : i === step ? 'bg-[#1EA0DA] text-white' : 'bg-[#E2E8F0] text-black/62'
              }`}
            >
              {i < step ? '✓' : i + 1}
            </span>
            <span className={`truncate ${i === step ? 'font-semibold text-[#12769F]' : 'text-black/62'}`}>{label}</span>
          </li>
        ))}
      </ol>
      <p className="text-sm text-black/80">
        {opened ? (
          <>
            Click <b>&ldquo;I&rsquo;m not a robot&rdquo;</b> in the box below. If Google shows pictures, click the matching ones and then
            <b> Verify</b>. The username and password are already filled in.
          </>
        ) : (
          'Preparing the PS-PhilGEPS log-in with the account filled in.'
        )}
      </p>
      {opened ? (
        <PsLiveLogin />
      ) : (
        <div className="flex flex-col items-center justify-center gap-3 rounded-[14px] border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-14 text-center">
          <span className="h-8 w-8 animate-spin rounded-full border-[3px] border-[#1EA0DA]/25 border-t-[#1EA0DA]" aria-hidden />
          <p className="text-sm font-medium text-[#12769F]">Opening the secure log-in…</p>
          <p className="text-xs text-black/62">Usually under a minute</p>
        </div>
      )}
    </Modal>
  );
}
