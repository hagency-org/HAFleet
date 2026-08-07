import { redirect } from 'next/navigation';

/*
 * `/` serves the Organization chart.
 *
 * It served the flat Workforce roster until the console grew two lines of report.
 * Of the two entrances, the dotted line is the right landing: this is the house's
 * own console, the resource plane is what it owns, and the solid line depends on a
 * join the backend cannot make yet — /projects opens empty on any real fleet
 * because no group has been bridged.
 *
 * Landing on Org also puts 分类 in front of the operator, which is the step that
 * has never had a surface and is the reason every agent returns role=null.
 *
 * In the real dashboard `/` keeps serving today's monitor until every surface in
 * the migration table has a destination; here there is no monitor to preserve,
 * so the redirect stands in for the end state.
 */
export default function Home() {
  redirect('/org');
}
