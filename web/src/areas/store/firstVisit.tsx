import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Navigate } from 'react-router';

/**
 * The very first time a browser opens the site's front door it is shown the
 * welcome page; every visit after that goes straight to the store. Only the
 * home address does this: a link to a series or any other page opens that page.
 */
const KEY = 'nsfwcomix:welcomed';
let rememberedThisLoad = false; // fallback when the browser will not store anything (private windows)

function welcomed(): boolean {
  if (rememberedThisLoad) return true;
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function markWelcomed(): void {
  rememberedThisLoad = true;
  try {
    window.localStorage.setItem(KEY, '1');
  } catch {
    // nothing can be stored: the welcome page is then shown once per page load at most
  }
}

/** Wraps the store's home page. */
export function FirstVisit({ children }: { children: ReactNode }) {
  if (!welcomed()) return <Navigate to="/welcome" replace />;
  return <>{children}</>;
}

/** Call from the welcome page: once it has been shown, the home address is the store. */
export function useMarkWelcomed(): void {
  useEffect(() => markWelcomed(), []);
}
