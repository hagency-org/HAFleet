/*
 * `/` IS 我的资源, rather than a redirect to it.
 *
 * It was `redirect('/resources')`, which a static export cannot honour — the
 * exported index.html came out as Next's error page, so the published site had a
 * broken front door. A server redirect also needs a server, and this prototype
 * should be servable from any static host.
 *
 * Two URLs render one page, which the rail already accommodated: the resources
 * entry carries `also: ['/']`, so it marks itself current either way.
 */
export { default } from './resources/page';
