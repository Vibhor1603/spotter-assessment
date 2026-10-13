import { useEffect, useState } from 'react'

/** Subscribe to a CSS media query. SSR-safe default: false. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}

/** Phone / narrow layout — keep in sync with RouteMap padding breakpoint. */
export const MOBILE_MQ = '(max-width: 860px)'
