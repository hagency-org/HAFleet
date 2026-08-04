import { redirect } from 'next/navigation';

/*
 * `/` redirects to `/overview` in the prototype.
 *
 * In the real dashboard it does NOT: `/` keeps serving today's monitor until
 * every surface in the migration table has a destination, and Overview lives at
 * `/overview` throughout. The rail links `/overview` from day one so no route
 * changes twice. Here there is no monitor to preserve, so the redirect stands in
 * for the eventual end state.
 */
export default function Home() {
  redirect('/overview');
}
