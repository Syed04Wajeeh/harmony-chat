import { PERK_LABELS, type Perk } from '@harmony/shared';

/** Marks a feature that needs a perk; the title says which and why. */
export function PerkBadge({ perk, locked = true }: { perk: Perk; locked?: boolean }) {
  const { name, description } = PERK_LABELS[perk];
  return (
    <span
      className="perk-badge"
      data-locked={locked || undefined}
      title={locked ? `Needs the "${name}" perk. ${description} Ask an admin to grant it.` : name}
    >
      Perk
    </span>
  );
}
