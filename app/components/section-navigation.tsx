import Link from "next/link";

export function SectionNavigation({ label, sections, policyLabel }: {
  label: string;
  sections: Array<{ id: string; label: string }>;
  policyLabel: string;
}) {
  return (
    <nav aria-label={label} className="section-navigation">
      <ul>
        {sections.map(({ id, label }) => <li key={id}><a href={`#${id}`}>{label}</a></li>)}
        <li><Link href="/normativa" prefetch={false}>{policyLabel}</Link></li>
      </ul>
    </nav>
  );
}
