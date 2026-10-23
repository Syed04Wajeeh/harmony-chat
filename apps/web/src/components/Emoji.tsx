import { parseCustomEmoji } from '@harmony/shared';

export const emojiUrl = (id: string, name: string) =>
  `/api/emoji/${id}/${encodeURIComponent(name)}`;

/** A custom emoji image; sized by CSS to the surrounding text (or larger when jumbo). */
export function CustomEmoji({ id, name }: { id: string; name: string }) {
  return (
    <img
      className="emoji"
      src={emojiUrl(id, name)}
      alt={`:${name}:`}
      title={`:${name}:`}
      loading="lazy"
      draggable={false}
    />
  );
}

/** A reaction or status emoji: a Unicode character, or a `<:name:id>` token drawn as an image. */
export function EmojiValue({ value }: { value: string }) {
  const custom = parseCustomEmoji(value);
  return custom ? <CustomEmoji id={custom.id} name={custom.name} /> : <>{value}</>;
}
