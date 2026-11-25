-- Terms: prices do not include sales tax; it is added at checkout.
update cms_pages set body = replace(body, $a$- Prices are shown before you pay.$a$, $b$- Prices are shown before you pay and do not include sales tax. Where tax applies, it is added at checkout and shown before you confirm.$b$) where slug = 'terms';
