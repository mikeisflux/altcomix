-- Legal pages: the owner's answers replace the placeholders (operator name, refunds,
-- governing law, creator tax reporting). Only the exact seeded wording is touched.
update cms_pages set body = replace(body, $a$*[Owner: legal name and address of the operator]*$a$, $b$NSFW Comix$b$);
update cms_pages set body = replace(body, $a$*[Owner: legal name of the operator]*$a$, $b$NSFW Comix$b$);
update cms_pages set body = replace(body, $a$- Prices are shown before you pay. *[Owner: state how taxes are handled.]*$a$, $b$- Prices are shown before you pay.$b$);
update cms_pages set body = replace(body, $a$*[Owner: state your refund policy, including any legal right to withdraw that applies to your customers.]*$a$, $b$All sales are final. We do not give refunds.$b$);
update cms_pages set body = replace(body, $a$*[Owner: state the governing law and courts.]*$a$, $b$These terms are governed by the laws of the State of Indiana, and any dispute is heard in the state or federal courts located in Indiana.$b$);
update cms_pages set body = replace(body, $a$*[Owner: state any tax forms or identity checks you require.]*$a$, $b$If your earnings in a calendar year reach the tax reporting limit, Studio asks you to fill in a tax information form, and payouts wait until it is complete. We use it to send you, and file, the tax form the law requires for that year.$b$);
