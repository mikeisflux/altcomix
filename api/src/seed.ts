import { randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import sharp from 'sharp';
import { exec, one, pool } from './db.ts';
import { hashPassword } from './lib/crypto.ts';
import { acceptUpload, publishRelease, queueDetectJob, runPendingJobs, tempDir } from './lib/ingest.ts';
import { migrate } from './migrate.ts';

/**
 * Demo data for trying the web app: one brand, one series, two published
 * releases. The pages are drawn here with sharp (panel grids, flat colours,
 * simple shapes: no artwork from anywhere else) and go through the same
 * upload -> ingestion -> frame detection -> publish path as a creator's files:
 * release 1 as a CBZ, release 2 as a PDF.
 *
 *   npm run seed -w api                      demo account (password printed)
 *   npm run seed -w api -- you@example.com   attach the demo brand to your account
 *   npm run seed -w api -- --force           rebuild the demo series
 */

type Panel = [number, number, number, number];
const LAYOUTS: Panel[][] = [
  [[0.05, 0.04, 0.9, 0.3], [0.05, 0.37, 0.44, 0.27], [0.51, 0.37, 0.44, 0.27], [0.05, 0.67, 0.9, 0.29]],
  [[0.05, 0.04, 0.44, 0.45], [0.51, 0.04, 0.44, 0.45], [0.05, 0.52, 0.44, 0.44], [0.51, 0.52, 0.44, 0.44]],
  [[0.05, 0.04, 0.9, 0.22], [0.05, 0.29, 0.28, 0.32], [0.36, 0.29, 0.28, 0.32], [0.67, 0.29, 0.28, 0.32], [0.05, 0.64, 0.55, 0.32], [0.63, 0.64, 0.32, 0.32]],
  [[0.05, 0.04, 0.4, 0.92], [0.48, 0.04, 0.47, 0.44], [0.48, 0.51, 0.47, 0.45]],
  [[0.05, 0.04, 0.9, 0.44], [0.05, 0.51, 0.9, 0.45]],
  [[0.05, 0.04, 0.55, 0.26], [0.63, 0.04, 0.32, 0.56], [0.05, 0.33, 0.26, 0.63], [0.34, 0.33, 0.26, 0.27], [0.34, 0.63, 0.61, 0.33]],
];
const PALETTES = [
  ['#1d3557', '#457b9d', '#a8dadc', '#e63946', '#f1faee'],
  ['#264653', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51'],
  ['#3d348b', '#7678ed', '#f7b801', '#f18701', '#f35b04'],
  ['#2b2d42', '#8d99ae', '#edf2f4', '#ef233c', '#d90429'],
];

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** One synthetic comic page as PNG. `index` 0 is a full-bleed cover. */
export async function synthPage(seed: number, index: number, opts: { width?: number; height?: number; gutter?: string } = {}): Promise<Buffer> {
  const w = opts.width ?? 1400;
  const h = opts.height ?? 2100;
  const rand = rng(seed * 7919 + index * 104729 + 17);
  const palette = PALETTES[seed % PALETTES.length];
  const pickColour = () => palette[Math.floor(rand() * palette.length)];
  let body: string;
  if (index === 0) {
    const [a, b, c] = [palette[0], palette[3], palette[2]];
    body = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/>
      <circle cx="${w * 0.7}" cy="${h * 0.3}" r="${w * 0.28}" fill="${c}" opacity="0.9"/>
      <rect x="${w * 0.25}" y="${h * 0.42}" width="${w * 0.3}" height="${h * 0.4}" rx="40" fill="${palette[4]}"/>
      <circle cx="${w * 0.4}" cy="${h * 0.36}" r="${w * 0.11}" fill="${palette[4]}"/>
      <rect x="${w * 0.33}" y="${h * 0.34}" width="${w * 0.05}" height="${h * 0.012}" fill="${a}"/><rect x="${w * 0.42}" y="${h * 0.34}" width="${w * 0.05}" height="${h * 0.012}" fill="${a}"/>
      <rect x="0" y="${h * 0.86}" width="${w}" height="${h * 0.09}" fill="${a}"/>
      <rect x="${w * 0.08}" y="${h * 0.89}" width="${w * 0.5}" height="${h * 0.03}" fill="${palette[2]}"/>`;
  } else {
    const layout = LAYOUTS[(seed + index) % LAYOUTS.length];
    const gutter = opts.gutter ?? ((seed + index) % 5 === 4 ? '#0b0b0d' : '#ffffff');
    const panels = layout
      .map(([x, y, pw, ph], i) => {
        const px = x * w, py = y * h, ww = pw * w, hh = ph * h;
        const bg = pickColour();
        const fg = palette.find((c) => c !== bg) ?? '#ffffff';
        const horizon = py + hh * (0.55 + rand() * 0.25);
        const cx = px + ww * (0.25 + rand() * 0.5);
        const r = Math.min(ww, hh) * (0.12 + rand() * 0.08);
        const bubbleX = px + ww * (rand() < 0.5 ? 0.22 : 0.74);
        return `<g clip-path="url(#p${i})"><rect x="${px}" y="${py}" width="${ww}" height="${hh}" fill="${bg}"/>
          <rect x="${px}" y="${horizon}" width="${ww}" height="${py + hh - horizon}" fill="${fg}" opacity="0.55"/>
          <rect x="${cx - r * 0.8}" y="${horizon - r * 1.6}" width="${r * 1.6}" height="${r * 2.4}" rx="${r * 0.3}" fill="#f5efe0"/>
          <circle cx="${cx}" cy="${horizon - r * 2.3}" r="${r * 0.8}" fill="#f5efe0"/>
          <ellipse cx="${bubbleX}" cy="${py + hh * 0.2}" rx="${ww * 0.16}" ry="${hh * 0.1}" fill="#ffffff" stroke="#111111" stroke-width="4"/>
          <rect x="${bubbleX - ww * 0.09}" y="${py + hh * 0.18}" width="${ww * 0.18}" height="6" fill="#111111"/>
          <rect x="${bubbleX - ww * 0.07}" y="${py + hh * 0.21}" width="${ww * 0.14}" height="6" fill="#111111"/></g>
          <clipPath id="p${i}"><rect x="${px}" y="${py}" width="${ww}" height="${hh}"/></clipPath>`;
      })
      .join('');
    body = `<rect width="${w}" height="${h}" fill="${gutter}"/>${panels}`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

/** A PDF with one full-page image per page. */
export async function imagesToPdf(images: Buffer[]): Promise<Buffer> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  for (const img of images) {
    const image = new mupdf.Image(img);
    // 150 DPI page size in points.
    const w = (image.getWidth() * 72) / 150;
    const h = (image.getHeight() * 72) / 150;
    const resources = doc.addObject({ XObject: { Im0: doc.addImage(image) } });
    doc.insertPage(-1, doc.addPage([0, 0, w, h], 0, resources, `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`));
  }
  const out = Buffer.from(doc.saveToBuffer('compress').asUint8Array());
  doc.destroy();
  return out;
}

async function waitForJobs(releaseId: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    await runPendingJobs();
    const open = await one<{ n: number }>(`select count(*)::int as n from jobs where release_id = $1 and status in ('queued','running')`, [releaseId]);
    if (!open!.n) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const failed = await one<{ error: string }>(`select error from jobs where release_id = $1 and status = 'failed' limit 1`, [releaseId]);
  if (failed) throw new Error(`Ingestion failed: ${failed.error}`);
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const email = (args.find((a) => a.includes('@')) ?? 'demo@altcomix.test').toLowerCase();
  await migrate(() => {});

  let user = await one<{ id: string; username: string }>('select id, username from users where lower(email) = $1 and deleted_at is null', [email]);
  let password: string | null = null;
  if (!user) {
    password = randomBytes(12).toString('base64url');
    let username = email.split('@')[0].replace(/[^A-Za-z0-9_]/g, '_').slice(0, 20).padEnd(3, '_');
    if (await one('select 1 from users where lower(username) = lower($1)', [username])) username = `${username.slice(0, 16)}_${randomBytes(2).toString('hex')}`;
    user = await one(
      `insert into users (email, username, display_name, password_hash, email_verified_at, prefs)
       values ($1,$2,$3,$4, now(), '{"notify":{"releases":true}}') returning id, username`,
      [email, username, 'Demo Creator', await hashPassword(password)],
    );
  }

  let brand = await one<{ id: string }>(
    `select p.id from publishers p join publisher_members m on m.publisher_id = p.id
      where m.user_id = $1 and p.slug like 'demo-comics%' and p.deleted_at is null limit 1`,
    [user!.id],
  );
  if (!brand) {
    let slug = 'demo-comics';
    for (let i = 2; await one('select 1 from publishers where slug = $1', [slug]); i++) slug = `demo-comics-${i}`;
    brand = await one(
      `insert into publishers (slug, name, bio, country, timezone, website, socials, monthly_goal_cents, verified_at)
       values ($1, 'Demo Comics', 'A demo brand with machine-drawn sample pages, for trying out AltComix.', 'US', 'America/New_York',
               null, '{}', 10000, now()) returning id`,
      [slug],
    );
    await exec(`insert into publisher_members (publisher_id, user_id, role) values ($1,$2,'owner')`, [brand!.id, user!.id]);
  }

  const existing = await one<{ id: string }>(`select id from series where publisher_id = $1 and slug like 'paper-robots%' and deleted_at is null`, [brand!.id]);
  if (existing && !force) {
    console.log(`Demo series already exists for ${email}. Run with --force to rebuild it.`);
  } else {
    if (existing) await exec('update series set deleted_at = now(), slug = slug || $2 where id = $1', [existing.id, `-old-${Date.now().toString(36)}`]);
    let slug = 'paper-robots';
    for (let i = 2; await one('select 1 from series where slug = $1', [slug]); i++) slug = `paper-robots-${i}`;
    const series = await one<{ id: string }>(
      `insert into series (publisher_id, slug, title, description, type, layout, reading_dir, language, status, visibility, genre, themes, audiences,
                           art_styles, tags, access_model, free_preview, default_price_cents, pub_year, update_frequency)
       values ($1, $2, 'Paper Robots', $3, 'comic', 'paged', 'ltr', 'en', 'ongoing', 'public', 'Sci-Fi', '{Robots,Friendship}', '{"All Ages"}',
               '{Minimalist}', '{demo,robots}', 'premium', '{"mode":"automatic"}', 199, extract(year from now())::int, 'Monthly')
       returning id`,
      [brand!.id, slug, 'Sample series generated by the seed script. Every page is a synthetic panel grid, useful for testing the reader, the paywall and frame-by-frame guided view.'],
    );
    await exec(`insert into contributors (series_id, name, role, user_id, position) values ($1, 'Demo Creator', 'Creator', $2, 0)`, [series!.id, user!.id]);

    const dir = await tempDir();
    try {
      const specs = [
        { number: 1, title: 'Unfolding', pages: 8, as: 'cbz' as const, synopsis: 'A robot made of paper wakes up in a recycling bin.' },
        { number: 2, title: 'Creases', pages: 6, as: 'pdf' as const, synopsis: 'Rain is coming, and paper does not like rain.' },
      ];
      for (const spec of specs) {
        const release = await one<{ id: string }>(
          `insert into releases (series_id, number, kind, language, title, synopsis, download_price_cents) values ($1,$2,'issue','en',$3,$4,299) returning id`,
          [series!.id, spec.number, spec.title, spec.synopsis],
        );
        const images: Buffer[] = [];
        for (let i = 0; i < spec.pages; i++) images.push(await synthPage(spec.number, i));
        const file = join(dir, `paper-robots-${spec.number}.${spec.as}`);
        if (spec.as === 'cbz') {
          const entries: Record<string, Uint8Array> = {};
          images.forEach((img, i) => (entries[`page_${i + 1}.png`] = img)); // 1..8 un-padded: natural order matters
          await writeFile(file, zipSync(entries, { level: 0 }));
        } else {
          await writeFile(file, await imagesToPdf(images));
        }
        await acceptUpload(release!.id, [{ path: file, filename: `Paper Robots ${spec.number}.${spec.as}` }], user!.id);
        await waitForJobs(release!.id);
        await queueDetectJob(release!.id, false, user!.id);
        await waitForJobs(release!.id);
        await publishRelease(release!.id);
        const done = await one('select page_count, (select count(*)::int from pages p where p.release_id = r.id and jsonb_array_length(p.frames) > 0) as framed from releases r where id = $1', [release!.id]);
        console.log(`  release ${spec.number} "${spec.title}": ${done!.page_count} pages from ${spec.as.toUpperCase()}, frames on ${done!.framed}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    console.log(`Seeded series "Paper Robots" (/series/${slug}) under brand Demo Comics.`);
  }

  console.log(`Account: ${email}`);
  if (password) console.log(`Password: ${password}   (generated just now; it is not stored anywhere else)`);
  else console.log('Password: unchanged (the account already existed).');
}

if (import.meta.main) {
  try {
    await main();
  } finally {
    await pool.end();
  }
}
