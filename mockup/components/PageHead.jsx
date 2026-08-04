export default function PageHead({ title, sub, children }) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      {sub && <span className="sub">{sub}</span>}
      <span className="spacer" />
      {children}
    </div>
  );
}
