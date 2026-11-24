export function money(cents: number | null | undefined, currency = 'usd'): string {
  const n = (cents ?? 0) / 100;
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: n % 1 === 0 ? 0 : 2 }).format(n);
}

/** Always two decimals, for ledgers and receipts. */
export function moneyExact(cents: number | null | undefined, currency = 'usd'): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format((cents ?? 0) / 100);
}

export function compact(n: number | null | undefined): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n ?? 0);
}

export function number(n: number | null | undefined): string {
  return new Intl.NumberFormat().format(n ?? 0);
}

export function date(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' }): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(undefined, opts).format(new Date(iso));
}

export function dateTime(iso: string | null | undefined): string {
  return date(iso, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [[60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [4.35, 'week'], [12, 'month'], [Infinity, 'year']];
  let v = s;
  for (const [size, unit] of steps) {
    if (Math.abs(v) < size) return rtf.format(-Math.round(v), unit);
    v /= size;
  }
  return date(iso);
}

export function bytes(n: number | null | undefined): string {
  let v = n ?? 0;
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 || v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function percent(fraction: number, digits = 0): string {
  return new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: digits }).format(fraction);
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${number(n)} ${n === 1 ? one : many}`;
}

/** "+12" / "−3.1K" for period-over-period deltas. */
export function delta(n: number): string {
  if (!n) return '0';
  return (n > 0 ? '+' : '−') + compact(Math.abs(n));
}
