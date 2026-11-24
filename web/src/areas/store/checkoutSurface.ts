/**
 * How a browser should be shown the hosted payment page.
 *
 * 'embed': the page is framed inside our own dialog and the buyer never
 * leaves the site (desktop browsers, Android Chrome).
 * 'redirect': the whole browser visits the page and is sent back to our
 * return address when it is done.
 *
 * iPhones and iPads cannot be trusted with a card form inside a cross-origin
 * frame: the card fields sit two frames deep and iOS WebKit will not give
 * them keyboard focus, so a buyer taps the field and nothing happens. In-app
 * browsers (Facebook, Instagram, X and the like) add their own trouble by
 * blocking the pop-up the payment page would otherwise fall back on. Both get
 * the plain top-level page, which has no nesting and needs no pop-up.
 *
 * Pure: pass `navigator.userAgent` and `navigator.maxTouchPoints`. iPadOS
 * identifies itself as a desktop Mac, and only the touch points tell them
 * apart. (Tested in api/src/lib/checkout-surface.test.ts.)
 */
export type CheckoutSurface = 'embed' | 'redirect';

const IOS = /iPhone|iPad|iPod/i;
// Facebook / Messenger, Instagram, X (Twitter), LINE, Snapchat, TikTok, Pinterest,
// any Android WebView ("; wv)") and the Google app's built-in browser.
const IN_APP = /FBAN|FBAV|FB_IAB|Instagram|Twitter|TwitterAndroid|Line\/|Snapchat|TikTok|musical_ly|Pinterest|; wv\)|GSA\//i;

export function checkoutSurfaceFor(userAgent: string | null | undefined, touchPoints = 0): CheckoutSurface {
  const ua = userAgent || '';
  if (IOS.test(ua)) return 'redirect';
  if (/Macintosh/i.test(ua) && touchPoints > 1) return 'redirect';
  if (IN_APP.test(ua)) return 'redirect';
  return 'embed';
}
