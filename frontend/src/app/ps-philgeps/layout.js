'use client';

import PageHeader from '@/components/PageHeader';
import ScrapeProgress from '@/components/ScrapeProgress';
import AutoFetchBar from '@/components/AutoFetchBar';
import OcrHealthNotice from '@/components/OcrHealthNotice';
import { PsPortalProvider } from '@/components/PsPortal';
import { usePsPhilgeps } from '@/lib/psContext';

// The PS-PhilGEPS pages (My Opportunities, Award Notices; its Bid Match is part of the merged Bid Match at /):
// the header with Reload and Sync, the log-in and Sync notices, then the page, with the Sync's ring and bar.
// The state lives in PsPortalProvider (components/PsPortal.js), shared with the merged Bid Match.
export default function PsPhilgepsLayout({ children }) {
  return (
    <PsPortalProvider>
      <PsShell>{children}</PsShell>
    </PsPortalProvider>
  );
}

function PsShell({ children }) {
  const { portal } = usePsPhilgeps();
  return (
    <>
      <div className="min-h-screen bg-white text-black antialiased">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
          <PageHeader
            title="PS-PhilGEPS Procurement Radar"
            subtitle={<>philgeps.gov.ph{portal.newToday > 0 && ` · ${portal.newToday} new today`}</>}
            status={portal.status}
            actions={
              <>
                {portal.reloadButton}
                {portal.syncButton}
              </>
            }
          />
          {portal.notices}
          <OcrHealthNotice />
          {children}
        </div>
      </div>
      <ScrapeProgress job={portal.ringJob} name="PS-PhilGEPS" onCancel={portal.cancelSync} onDismiss={portal.closeRing} />
      <AutoFetchBar job={portal.barJob} running="Hourly PS-PhilGEPS Sync" done="PS-PhilGEPS updated" onDismiss={portal.dismissBar} />
    </>
  );
}
