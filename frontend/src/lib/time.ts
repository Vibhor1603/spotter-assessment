/** Parse API timestamps that may be naive UTC or already offset-aware. */
export function parseUTC(iso: string): Date {
  const s = iso.trim()
  if (!s) return new Date(NaN)
  // Already has Z or ±offset after the time portion
  if (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
    return new Date(s)
  }
  // Open-Meteo / naive UTC: "2026-10-13T12:00" or "...:00:00"
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    return new Date(s.endsWith('Z') ? s : `${s}Z`)
  }
  return new Date(s)
}

export function formatLocalDateTime(iso: string): string {
  try {
    return parseUTC(iso).toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

export function formatLocalTime(iso: string): string {
  try {
    return parseUTC(iso).toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
    })
  } catch {
    return iso
  }
}

export function formatArrival(iso: string): string {
  try {
    return parseUTC(iso).toLocaleString(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}
