-- Minimum age is 18 (privacy page and terms).
update cms_pages set body = replace(body, $a$NSFWComix is not intended for children under the age at which they can consent to data processing in their country. *[Owner: confirm the minimum age.]*$a$, $b$NSFWComix is for adults. You must be 18 or older to use it.$b$);
update cms_pages set body = replace(body, $a$*[Owner: state the minimum age.]*$a$, $b$You must be 18 or older to have an account.$b$);
