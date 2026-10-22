'use client';

import { useEffect, useRef, useState } from 'react';
import { authFetch } from '@/lib/authFetch';

// Live picture of the PS-PhilGEPS log-in page while connecting. The log-in runs out of sight with
// everything filled in; the person clicks "I'm not a robot" (and any image challenge) on this picture
// and each click is passed to the real page. Refreshed twice a second.
export default function PsLiveLogin() {
  const [src, setSrc] = useState(null);
  const [clicked, setClicked] = useState(null);
  const imgRef = useRef(null);

  useEffect(() => {
    let stopped = false;
    let current = null;
    const load = async () => {
      try {
        const res = await fetch('/api/ps-philgeps/live', { cache: 'no-store' });
        if (res.status === 200) {
          const url = URL.createObjectURL(await res.blob());
          if (stopped) return URL.revokeObjectURL(url);
          setSrc(url);
          if (current) URL.revokeObjectURL(current);
          current = url;
        }
      } catch {}
    };
    load();
    const timer = setInterval(load, 500);
    return () => {
      stopped = true;
      clearInterval(timer);
      if (current) URL.revokeObjectURL(current);
    };
  }, []);

  // Picture pixels → page pixels (the picture is shown scaled to fit)
  const click = async (e) => {
    const img = imgRef.current;
    const box = img.getBoundingClientRect();
    const x = ((e.clientX - box.left) * img.naturalWidth) / box.width;
    const y = ((e.clientY - box.top) * img.naturalHeight) / box.height;
    setClicked({ left: e.clientX - box.left, top: e.clientY - box.top, at: Date.now() });
    await authFetch('/api/ps-philgeps/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x, y }),
    }).catch(() => {});
  };

  if (!src) {
    return <div className="rounded-[14px] border border-[#E2E8F0] px-4 py-10 text-center text-sm text-black/62">Opening the PS-PhilGEPS log-in page…</div>;
  }

  return (
    <div className="relative w-full max-w-[1000px] rounded-[14px] border border-[#1EA0DA]/40 overflow-hidden">
      {/* eslint-disable-next-line @next/next/no-img-element -- live JPEG frames from a blob URL */}
      <img ref={imgRef} src={src} alt="PS-PhilGEPS log-in page" onClick={click} className="block w-full cursor-pointer select-none" draggable={false} />
      {clicked && (
        <span
          key={clicked.at}
          aria-hidden
          className="pointer-events-none absolute h-6 w-6 -ml-3 -mt-3 rounded-full border-2 border-[#1EA0DA] animate-ping"
          style={{ left: clicked.left, top: clicked.top }}
        />
      )}
    </div>
  );
}
