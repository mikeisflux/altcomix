-- Creator Promise: 30 days' notice before a content-policy change.
update cms_pages set body = replace(body, $a$**[NOTICE PERIOD, e.g. 30 days]**$a$, '**30 days**');
