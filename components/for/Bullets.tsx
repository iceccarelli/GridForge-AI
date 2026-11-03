export function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="mt-3 list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-mute">
      {items.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  );
}
