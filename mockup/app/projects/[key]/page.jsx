import { notFound } from 'next/navigation';
import { projects } from '@/lib/mock-data';
import ProjectDetail from './ProjectDetail';

export function generateStaticParams() {
  return projects.map((p) => ({ key: p.key }));
}

export default async function ProjectPage({ params }) {
  const { key } = await params;
  if (!projects.some((p) => p.key === key)) notFound();
  return <ProjectDetail projectKey={key} />;
}
