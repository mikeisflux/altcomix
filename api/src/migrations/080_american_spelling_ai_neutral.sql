-- Live CMS pages: drop the passages about AI-generated comics (the platform takes
-- no position against AI) and switch the seeded text to American spellings.
-- Only the exact seeded wording is touched; pages an admin has rewritten are left as they are.

update cms_pages set body = replace(body, E'## No generative AI\n\nNSFWComix does not accept AI-generated comics. Everything here is made by people.\n\n', '');
update cms_pages set body = replace(body, E'## 6. Made by people\n\nAI-generated comics are not accepted, and your pages are not used to train a model.\n\n', '');
update cms_pages set body = replace(body, E'**Do you accept AI-generated comics?**\nNo.\n\n', '');
update cms_pages set body = replace(body, E'- It was not made with generative AI.\n', '');
update cms_pages set body = regexp_replace(body, E'- \\*\\*(No )?AI-generated comics\\.\\*\\* Art or writing produced by generative AI is not accepted\\. Tools that assist a human artist \\(lettering, flatting helpers, colou?r correction\\) are fine\\.\n', '', 'g');

update cms_pages set body = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(body,
  'catalogue', 'catalog'), 'Catalogue', 'Catalog'), 'colour', 'color'), 'criticise', 'criticize'), 'labelled', 'labeled'),
  'labelling', 'labeling'), 'Labelling', 'Labeling'), 'licence', 'license'), 'itemised', 'itemized'), 'favourite', 'favorite')
 where body ~ '(catalogue|Catalogue|colour|criticise|labelled|abelling|licence|itemised|favourite)';

update contributors set role = 'Penciler' where role = 'Penciller';

-- Contact page: the copyright address replaces the owner placeholder.
update cms_pages set body = replace(body, '*[Owner: add the support email address, a postal address if you are required to publish one, and the address that receives copyright notices.]*', '[copyright@nsfwcomix.com](mailto:copyright@nsfwcomix.com)') where slug = 'contact';
