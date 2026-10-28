// Kleine UI-Icons (Strich-Icons, keine Emojis)
const P: Record<string, string> = {
  library: 'M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v6H4zM14 15h6v6h-6z',
  analysis: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  replay: 'M8 5v14l11-7z',
  pause: 'M8 5v14M16 5v14',
  again: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v5h5',
  zoom: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14M21 21l-5-5M8 11h6M11 8v6',
  xhair: 'M12 3v5M12 16v5M3 12h5M16 12h5M12 11.5v1',
  camera: 'M3 7h12v10H3zM15 10l6-3v10l-6-3',
  cube: 'M12 2l9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10',
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
  clipboard: 'M9 3h6v4H9zM15 5h4v16H5V5h4M9 12h6M9 16h4',
  folder: 'M3 5h6l2 2h10v12H3z',
  check: 'M5 12l5 5 9-10',
  x: 'M6 6l12 12M18 6L6 18',
  team: 'M9 11a4 4 0 1 0 0-8a4 4 0 1 0 0 8M2 21v-1a6 6 0 0 1 12 0v1M16 3.5a4 4 0 0 1 0 7.5M22 21v-1a6 6 0 0 0-4-5.6',
  nade: 'M7 14a5 5 0 1 0 10 0a5 5 0 1 0-10 0M10 9V6h4v3M14 7l3 3M10 7a2 2 0 1 1-3 1.7',
}

export function Icon({ name, size = 18, className }: { name: keyof typeof P | string; size?: number; className?: string }) {
  return (
    <svg className={`ico ${className ?? ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d={P[name] ?? ''} /></svg>
  )
}
