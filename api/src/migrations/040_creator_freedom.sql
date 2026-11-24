-- Positioning: creator freedom and adult-friendly publishing are the point of
-- the platform. Rewrites the content policy draft and adds the creator
-- promise. Pages an admin has already edited (updated_by set) are left alone.

insert into cms_pages (slug, title, body) values
('creator-promise', 'The creator promise', $md$
**Draft for the owner to confirm.** Every line below is a commitment readers and creators will hold you to. Fill in the bracketed parts, and remove any line you are not ready to keep.

## Make the book you want

AltComix exists because creators keep getting told, with a day's notice, that work they were invited to publish is no longer welcome. This is what we promise instead.

## 1. Adult work is allowed

Sex, nudity and mature themes are welcome here when the work is labelled for adults. Explicit is not a violation. Adult titles have a proper place in the store and in search for readers who have confirmed they are 18 or older; they are not buried or quietly de-listed.

## 2. Rules do not change overnight

If the content policy changes, we announce it at least **[NOTICE PERIOD, e.g. 30 days]** before it takes effect. Work published under the old rules is not removed for breaking new ones without talking to you first.

## 3. A reason and an appeal, from a person

If a title is ever taken down, you are told which rule it broke, and you can appeal to a person. Reply to the notice and someone reads it.

## 4. You own it

You keep the copyright. Publishing here is non-exclusive: sell the same book anywhere else, crowdfund it, print it. You can download your original files or remove a series whenever you like.

## 5. Readers keep what they bought

If a title leaves the store, readers who already bought it keep access to their copy. The only exception is content that cannot legally stay available.

## 6. Made by people

AI-generated comics are not accepted, and your pages are not used to train a model.

## The edges

Freedom has edges, and they are short enough to state up front. They are in the [content policy](/p/content-policy).
$md$)
on conflict (slug) do nothing;

update cms_pages set title = 'Content policy', updated_at = now(), body = $md$
**Draft.** This page is a first draft written during setup, not legal advice. Laws on adult content and age checks differ by country and by US state; have this reviewed before launch.

## The short version

Make the book you want. Label it honestly. Stay inside a short list of hard limits.

## Adult content is welcome

AltComix is for all kinds of comics, including comics made for adults. **Explicit sexual content, nudity, graphic violence and mature themes are allowed** when the work:

- is marked **Not safe for work** on the series or release, with the content advisories that apply, and
- stays inside the hard limits below.

Adult titles are shown only to readers who have confirmed they are 18 or older. They appear in the store, in search and in recommendations for those readers like any other title.

## Hard limits

These apply to everything, however it is labelled, and they do not have exceptions.

- **No sexual content involving minors.** That includes characters who are, or are presented as, under 18, whatever age the story claims. Removed immediately and reported where the law requires.
- **No sexual depictions of real, identifiable people** without their consent, and no content that harasses or exposes private information about a real person.
- **Nothing you do not have the right to publish.** No scans of other people's books and no unlicensed translations. Parody and fan work can be legitimate, but if a rights holder sends a valid complaint we have to act on it; see the copyright process in the [terms](/p/terms).
- **No content that is illegal** to distribute where we operate, and no content promoting violence against people because of who they are.
- **No AI-generated comics.** Art or writing produced by generative AI is not accepted. Tools that assist a human artist (lettering, flatting helpers, colour correction) are fine.

## Labelling

- Mark a series or a single release **Not safe for work** if you would think twice before showing it to a parent or a boss.
- Use the advisories (nudity, sexual content, graphic violence and so on) so readers can choose.
- Covers and banners can appear in link previews outside AltComix, where there is no age check. Keep explicit imagery off the cover itself.

Moderators may add a missing label. That is a label, not a penalty.

## Comments and community

Be civil. Criticise the work, not the person. Spam, slurs and harassment are removed.

## Reporting and enforcement

Use the **Report** option on any series, release, comment or profile. Reports are read by a person. A report that a title is "too explicit" is not, on its own, a reason to remove a correctly labelled adult title.

When we act on a title, the brand owner is told what was done and which rule applies.

## Appeals and changes

If you think a decision was wrong, reply to the notice and a person will look again. Changes to this policy follow the [creator promise](/p/creator-promise): announced in advance, never overnight.
$md$
where slug = 'content-policy' and updated_by is null;
