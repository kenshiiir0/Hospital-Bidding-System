'use client';

import PageHeader from '@/components/PageHeader';
import { OcrReport } from '@/components/OcrHealthNotice';

// Report Log: system reports for both sites (PhilGEPS and PS-PhilGEPS), kept off the working pages.
// Reading scanned documents (OCR): how many wait, and when the GitHub job and the Google Vision backup last ran.
export default function ReportLog() {
  return (
    <div className="min-h-screen bg-white text-black antialiased">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-5">
        <PageHeader title="Report Log" subtitle="System reports for PhilGEPS and PS-PhilGEPS" />
        <section className="space-y-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-black/46">Reading scanned documents (OCR)</h2>
          <OcrReport />
        </section>
      </div>
    </div>
  );
}
