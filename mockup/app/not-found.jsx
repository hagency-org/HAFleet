import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="empty">
      <div className="big">No such page</div>
      <p className="small">
        Every destination in the rail resolves to a route. If you reached this from one,
        that is the bug the route-inventory test exists to catch.
      </p>
      <Link className="btn primary" href="/overview">Back to overview</Link>
    </div>
  );
}
