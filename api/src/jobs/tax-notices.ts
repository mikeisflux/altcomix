import { sendTaxNotices } from '../lib/tax.ts';
import type { Job } from '../server.ts';

/**
 * Brands whose earnings this calendar year (or last) have reached the tax
 * reporting limit and that have no tax information form on file: one in-app
 * notification and one email to the owners, once per brand per year.
 *
 * A job rather than a hook in the ledger, because earnings arrive from several
 * places (sales, tips, monthly settlement, refunds that are later reversed)
 * and the limit itself can be changed in /admin.
 */
const job: Job = {
  name: 'tax-notices',
  everyMs: 10 * 60_000,
  async run() {
    const told = await sendTaxNotices();
    if (!told) return;
    return `asked ${told} ${told === 1 ? 'brand' : 'brands'} for tax information`;
  },
};

export default job;
