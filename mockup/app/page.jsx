import { redirect } from 'next/navigation';

/*
 * `/` serves 我的资源.
 *
 * The contributor's first question is "what am I lending, and on what terms" —
 * and on a fresh host the answer is "nothing", because no onboarding path writes
 * a preset. Landing here puts that in front of them rather than making them find
 * it, which is the same reason the previous console landed on the classification
 * step it was missing.
 */
export default function Home() {
  redirect('/resources');
}
