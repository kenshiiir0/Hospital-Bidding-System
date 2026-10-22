'use client';

// Three dots bouncing one after another: shows a fetch is still alive between progress updates
export default function WorkingDots({ className = 'bg-current' }) {
  return (
    <span className="inline-flex items-end gap-0.5 h-2.5 align-middle" aria-hidden>
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className={`h-1 w-1 rounded-full animate-bounce ${className}`}
          style={{ animationDelay: `${delay}ms`, animationDuration: '900ms' }}
        />
      ))}
    </span>
  );
}
