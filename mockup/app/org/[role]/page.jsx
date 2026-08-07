import { notFound, redirect } from 'next/navigation';
import { roles, retiredRoles, resolveRoleKey } from '@/lib/mock-data';
import RoleDetail from './RoleDetail';

export function generateStaticParams() {
  return [...roles, ...retiredRoles].map((r) => ({ role: r.key }));
}

export default async function RolePage({ params }) {
  const { role } = await params;
  const resolved = resolveRoleKey(role);
  if (!resolved) notFound();
  // A retired key resolves rather than 404s, and it redirects to the live role
  // instead of rendering under the dead name — the same rule dispatch follows.
  // A bookmark saved against /org/review keeps working and lands somewhere true.
  if (resolved !== role) redirect(`/org/${resolved}`);
  return <RoleDetail roleKey={resolved} />;
}
