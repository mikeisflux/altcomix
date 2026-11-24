import { processEmailQueue, recoverStuckEmails } from '../lib/email.ts';
import type { Job } from '../server.ts';

const job: Job = {
  name: 'email-queue',
  everyMs: 10_000,
  async run() {
    const recovered = await recoverStuckEmails();
    const { sent, failed } = await processEmailQueue(25);
    if (!sent && !failed && !recovered) return;
    return `sent ${sent}, failed ${failed}, recovered ${recovered}`;
  },
};

export default job;
