/**
 * Google reCAPTCHA v3: invisible, score based. The script is only loaded when
 * an admin has turned the check on (the site key is then in public settings),
 * and only on the forms that use it.
 */
type Grecaptcha = { ready: (cb: () => void) => void; execute: (key: string, opts: { action: string }) => Promise<string> };

let loading: Promise<Grecaptcha> | null = null;

function load(siteKey: string): Promise<Grecaptcha> {
  loading ??= new Promise<Grecaptcha>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}`;
    s.async = true;
    s.onload = () => {
      const g = (window as unknown as { grecaptcha?: Grecaptcha }).grecaptcha;
      if (g) g.ready(() => resolve(g));
      else reject(new Error('reCAPTCHA did not start'));
    };
    s.onerror = () => {
      loading = null;
      reject(new Error('Could not load the spam check. Turn off any blocker for this page and try again.'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/** A fresh token for one form submission, or undefined when the check is off. */
export async function recaptchaToken(siteKey: string | undefined, action: 'register' | 'forgot'): Promise<string | undefined> {
  if (!siteKey) return undefined;
  const g = await load(siteKey);
  return g.execute(siteKey, { action });
}
