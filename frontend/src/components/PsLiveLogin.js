'use client';

import { useEffect, useRef, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { supabase } from '@/lib/supabase';

// Live picture of the PS-PhilGEPS log-in page while connecting. The log-in runs out of sight with
// everything filled in; the person clicks "I'm not a robot" (and any image challenge) on this picture
// and each click is passed to the real page.
// streamId (the cloud log-in, tools/ps-connect-cloud.js): pictures and clicks travel on the private Realtime
// channel "ps-connect:<id>" (team accounts only), a fraction of a second each way. Without it, or while the
// channel isn't delivering, the picture is fetched every POLL_MS through the server and clicks are posted.
// Until the first click only the log-in box shows (FOCUS, in page pixels of the 1000 x 760 picture), so it reads
// as a step of the dashboard rather than a whole website; after it, the whole page, so Google's picture puzzle
// (which opens beside the box) is never cut off.
const FOCUS = { x: 500, y: 330, w: 360, h: 430 };
const POLL_MS = 700;
// The channel counts as live while a picture came on it this recently
const STREAM_FRESH_MS = 3000;

export default function PsLiveLogin({ streamId = null }) {
  const [src, setSrc] = useState(null);
  const [clicked, setClicked] = useState(null);
  const [whole, setWhole] = useState(false);
  const imgRef = useRef(null);
  const channelRef = useRef(null);
  const streamedAt = useRef(0);

  // The live channel (cloud log-in)
  useEffect(() => {
    if (!streamId) return;
    let channel;
    let stopped = false;
    (async () => {
      await supabase.realtime.setAuth().catch(() => {});
      if (stopped) return;
      channel = supabase.channel(`ps-connect:${streamId}`, { config: { private: true, broadcast: { self: false } } });
      channel
        .on('broadcast', { event: 'frame' }, ({ payload }) => {
          if (!payload?.f) return;
          streamedAt.current = Date.now();
          setSrc(`data:image/jpeg;base64,${payload.f}`);
        })
        .subscribe((status) => {
          if (status !== 'SUBSCRIBED') return;
          channelRef.current = channel;
          channel.send({ type: 'broadcast', event: 'hello', payload: {} });
        });
    })();
    return () => {
      stopped = true;
      channelRef.current = null;
      if (channel) supabase.removeChannel(channel);
    };
  }, [streamId]);

  // The fallback: the picture through the server, while the channel isn't delivering
  useEffect(() => {
    let stopped = false;
    let current = null;
    const load = async () => {
      if (Date.now() - streamedAt.current < STREAM_FRESH_MS) return;
      try {
        // (signed in: on the deployed dashboard the picture comes from the cloud log-in, lib/psCloudConnect.mjs)
        const res = await authFetch('/api/ps-philgeps/live', { cache: 'no-store' });
        if (res.status === 200 && Date.now() - streamedAt.current >= STREAM_FRESH_MS) {
          const url = URL.createObjectURL(await res.blob());
          if (stopped) return URL.revokeObjectURL(url);
          setSrc(url);
          if (current) URL.revokeObjectURL(current);
          current = url;
        }
      } catch {}
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
      if (current) URL.revokeObjectURL(current);
    };
  }, []);

  // Shown pixels → page pixels (the picture is scaled to fit, and cropped to FOCUS until the first click)
  const click = async (e) => {
    const img = imgRef.current;
    const frame = e.currentTarget.getBoundingClientRect();
    const view = whole ? { x: 0, y: 0, w: img.naturalWidth } : FOCUS;
    const scale = view.w / frame.width;
    const x = view.x + (e.clientX - frame.left) * scale;
    const y = view.y + (e.clientY - frame.top) * scale;
    setClicked({ left: e.clientX - frame.left, top: e.clientY - frame.top, at: Date.now() });
    setTimeout(() => setWhole(true), 600);
    // Every click on its own, straight to the log-in page on the live channel; else through the server
    if (channelRef.current && Date.now() - streamedAt.current < STREAM_FRESH_MS) {
      const sent = await channelRef.current.send({ type: 'broadcast', event: 'click', payload: { x, y } }).catch(() => null);
      if (sent === 'ok') return;
    }
    await authFetch('/api/ps-philgeps/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x, y }),
    }).catch(() => {});
  };

  if (!src) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-[14px] border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-14 text-center">
        <span className="h-8 w-8 animate-spin rounded-full border-[3px] border-[#1EA0DA]/25 border-t-[#1EA0DA]" aria-hidden />
        <p className="text-sm font-medium text-[#12769F]">Opening the secure log-in…</p>
        <p className="text-xs text-black/62">Usually under a minute</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full" style={{ maxWidth: whole ? 720 : 380 }}>
      <div
        onClick={click}
        className="relative w-full cursor-pointer select-none overflow-hidden rounded-[14px] border border-[#E2E8F0] bg-[#0B2545] shadow-sm"
        style={whole ? undefined : { aspectRatio: `${FOCUS.w} / ${FOCUS.h}` }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- live JPEG frames (data or blob URL) */}
        <img
          ref={imgRef}
          src={src}
          alt="PS-PhilGEPS log-in"
          draggable={false}
          className="block max-w-none"
          style={
            whole
              ? { width: '100%' }
              : { width: `${(1000 / FOCUS.w) * 100}%`, marginLeft: `${(-FOCUS.x / FOCUS.w) * 100}%`, marginTop: `${(-FOCUS.y / FOCUS.w) * 100}%` }
          }
        />
        {clicked && (
          <span
            key={clicked.at}
            aria-hidden
            className="pointer-events-none absolute h-6 w-6 -ml-3 -mt-3 rounded-full border-2 border-[#1EA0DA] animate-ping"
            style={{ left: clicked.left, top: clicked.top }}
          />
        )}
      </div>
      {!whole && (
        <button type="button" onClick={() => setWhole(true)} className="mt-2 w-full text-center text-xs text-black/46 underline underline-offset-2 hover:text-[#12769F]">
          Show the whole page
        </button>
      )}
    </div>
  );
}
