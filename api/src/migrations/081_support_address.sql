-- Support section: the support address replaces the owner placeholder.
update cms_pages set body = replace(body, '*[Owner: state the support channel and the response time you can actually meet.]*', 'Email [support@nsfwcomix.com](mailto:support@nsfwcomix.com).');
