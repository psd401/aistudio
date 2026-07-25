/**
 * Atrium TagPills — tag chips for the Meridian library cards (#1336).
 *
 * Replaces the old `tags.join(" · ")` muted paragraph on document cards (and the
 * complete absence of tags on artifact cards) with real pills, capped with a
 * "+N" overflow pill so a heavily-tagged object cannot blow out the card
 * height. Presentation only.
 */

/** How many tag pills render before the rest collapse into a "+N" pill. */
const MAX_VISIBLE_TAGS = 3;

export function TagPills({
  tags,
  max = MAX_VISIBLE_TAGS,
}: {
  tags: string[];
  /** Pills rendered before the "+N" overflow pill. */
  max?: number;
}): React.JSX.Element | null {
  if (tags.length === 0) return null;
  const visible = tags.slice(0, max);
  const overflow = tags.length - visible.length;
  return (
    <ul className="mer-tag-pills">
      {visible.map((tag) => (
        <li key={tag} className="mer-tag-pill">
          {tag}
        </li>
      ))}
      {overflow > 0 && (
        <li
          className="mer-tag-pill mer-tag-pill-more"
          // The visible "+N" is terse; spell it out for assistive tech and give
          // sighted users the full list on hover.
          title={tags.slice(max).join(", ")}
          aria-label={`${overflow} more ${overflow === 1 ? "tag" : "tags"}: ${tags
            .slice(max)
            .join(", ")}`}
        >
          +{overflow}
        </li>
      )}
    </ul>
  );
}
