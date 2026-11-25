-- Availability section: the uptime target replaces the owner placeholder.
update cms_pages set body = replace(body, '*[Owner: decide whether to state an uptime target. Do not publish a number you are not measuring.]*', 'Our target is 98% uptime.');
