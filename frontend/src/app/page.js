'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

export default function Home() {
  const [bids, setBids] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [scraping, setScraping] = useState(false);
  const [scrapeError, setScrapeError] = useState('');

  // Fetch opportunities live from Supabase
  const fetchBids = async () => {
    setLoading(true);
    await loadBids();
  };

  // Initial load uses this directly: loading already starts true
  const loadBids = async () => {
    const { data, error } = await supabase
      .from('philgeps_opportunities')
      .select('*')
      .order('id', { ascending: false });

    if (error) console.error('Error fetching bids:', error.message);
    else setBids(data || []);
    setLoading(false);
  };

  // Run the Puppeteer scraper on the server, then reload the table
  const triggerScrape = async () => {
    setScraping(true);
    setScrapeError('');
    try {
      const res = await fetch('/api/scrape', { method: 'POST' });
      const result = await res.json();
      if (!result.ok) setScrapeError(result.error);
    } catch (err) {
      setScrapeError(err.message);
    }
    await fetchBids();
    setScraping(false);
  };

  useEffect(() => {
    loadBids();

    // Listen for new inserts in philgeps_opportunities in real-time
    const channel = supabase
      .channel('philgeps_changes')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'philgeps_opportunities' },
        (payload) => {
          console.log('New hospital tender added:', payload.new);
          // Skip rows already loaded (e.g. by fetchBids after a manual scrape)
          setBids((prevBids) =>
            prevBids.some((bid) => bid.id === payload.new.id)
              ? prevBids
              : [payload.new, ...prevBids]
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Match against both the tender title and the procuring entity (hospital)
  const query = search.toLowerCase();
  const filteredBids = bids.filter((bid) =>
    `${bid.title || ''} ${bid.procuring_entity || ''}`.toLowerCase().includes(query)
  );

  return (
    <div className="min-h-screen bg-[#0b0f19] text-slate-100 antialiased">
      <div className="max-w-7xl mx-auto px-6 py-10 space-y-8">

        {/* Header Bar */}
        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-6 border-b border-slate-800/80">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white">Hospital Opportunity Radar</h1>
            <p className="text-slate-400 text-sm mt-1">PhilGEPS Automated Procurement Intelligence</p>
          </div>
          <button
            onClick={triggerScrape}
            disabled={scraping}
            className="inline-flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-300 disabled:cursor-wait disabled:shadow-none text-white px-4 py-2.5 rounded-lg text-sm font-medium transition shadow-lg shadow-blue-500/10 active:scale-95 disabled:active:scale-100"
          >
            {scraping ? '⏳ Scraping PhilGEPS...' : '🔄 Refresh Table'}
          </button>
        </header>

        {scrapeError && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-300 text-sm rounded-xl px-4 py-3">
            Scrape failed: {scrapeError}
          </div>
        )}

        {/* Metrics Row */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <div className="bg-slate-900/60 border border-slate-800 p-5 rounded-2xl backdrop-blur-sm">
            <span className="text-slate-400 text-xs font-semibold uppercase tracking-wider">Total Opportunities</span>
            <div className="text-3xl font-bold text-white mt-2">{bids.length}</div>
          </div>
          <div className="bg-slate-900/60 border border-slate-800 p-5 rounded-2xl backdrop-blur-sm">
            <span className="text-slate-400 text-xs font-semibold uppercase tracking-wider">Target Category</span>
            <div className="text-xl font-bold text-emerald-400 mt-2 truncate">Drugs & Medicines</div>
          </div>
          <div className="bg-slate-900/60 border border-slate-800 p-5 rounded-2xl backdrop-blur-sm">
            <span className="text-slate-400 text-xs font-semibold uppercase tracking-wider">Pipeline Connection</span>
            <div className="text-xl font-bold text-blue-400 mt-2 flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-blue-500 animate-pulse" />
              Live Database
            </div>
          </div>
        </section>

        {/* Search Input Bar */}
        <div className="relative">
          <input
            type="text"
            placeholder="Search by tender title or hospital name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-slate-900/80 border border-slate-800 text-slate-100 placeholder-slate-500 rounded-xl px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition shadow-inner"
          />
        </div>

        {/* Data Grid Table */}
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl backdrop-blur-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm border-collapse">
              <thead>
                <tr className="bg-slate-950/40 border-b border-slate-800 text-slate-400 text-xs uppercase tracking-wider">
                  <th className="py-4 px-5 w-16 text-center">#</th>
                  <th className="py-4 px-6">Opportunity Title / Procuring Entity</th>
                  <th className="py-4 px-6 w-48">Category</th>
                  <th className="py-4 px-6 w-32 text-center">Status</th>
                  <th className="py-4 px-6 w-36 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-normal">
                {loading ? (
                  <tr>
                    <td colSpan="5" className="py-12 text-center text-slate-500">
                      Fetching live opportunities from database...
                    </td>
                  </tr>
                ) : filteredBids.length === 0 ? (
                  <tr>
                    <td colSpan="5" className="py-12 text-center text-slate-500">
                      No matching records found.
                    </td>
                  </tr>
                ) : (
                  filteredBids.map((bid, index) => (
                    <tr key={bid.id || index} className="hover:bg-slate-800/40 transition-colors">
                      <td className="py-4 px-5 text-center text-slate-500 font-mono text-xs">{index + 1}</td>
                      <td className="py-4 px-6 font-medium text-slate-200 leading-relaxed max-w-xl">
                        <div className="line-clamp-2">{bid.title}</div>
                        {bid.procuring_entity && (
                          <div className="text-xs font-normal text-slate-500 mt-1 truncate">{bid.procuring_entity}</div>
                        )}
                      </td>
                      <td className="py-4 px-6 text-slate-400 text-xs">{bid.category}</td>
                      <td className="py-4 px-6 text-center">
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                          {bid.status || 'NEW'}
                        </span>
                      </td>
                      <td className="py-4 px-6 text-right">
                        <a
                          href={bid.detail_link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs font-semibold text-blue-400 hover:text-blue-300 transition"
                        >
                          Open Tender <span className="text-[10px]">↗</span>
                        </a>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </div>
  );
}
