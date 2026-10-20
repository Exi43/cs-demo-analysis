// Kleine UI-Icons (Strich-Icons, keine Emojis)
const P: Record<string, string> = {
  library: 'M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v6H4zM14 15h6v6h-6z',
  analysis: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  replay: 'M8 5v14l11-7z',
  multi: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5',
  stats: 'M3 5h18M3 12h18M3 19h18M9 5v14',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  clock: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  star: 'M12 3l2.8 5.8 6.2.9-4.5 4.4 1.1 6.3L12 17.3 6.4 20.4l1.1-6.3L3 9.7l6.2-.9z',
  target: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8',
  shuffle: 'M4 7h4l8 10h4M4 17h4l3-4M16 7h4M18 5l2 2-2 2M18 15l2 2-2 2',
  upload: 'M12 16V4M6 10l6-6 6 6M4 20h16',
  check: 'M5 12l5 5 9-10',
  x: 'M6 6l12 12M18 6L6 18',
}

export function Icon({ name, size = 18, className }: { name: keyof typeof P | string; size?: number; className?: string }) {
  return (
    <svg className={`ico ${className ?? ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d={P[name] ?? ''} /></svg>
  )
}
