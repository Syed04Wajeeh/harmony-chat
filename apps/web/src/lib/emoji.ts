export interface EmojiEntry {
  emoji: string;
  name: string;
  keywords?: string;
}

/** A small curated set; reactions accept any single emoji, but this covers everyday use. */
export const EMOJI: readonly EmojiEntry[] = [
  { emoji: '👍', name: 'thumbs up', keywords: 'yes ok like +1' },
  { emoji: '👎', name: 'thumbs down', keywords: 'no dislike -1' },
  { emoji: '❤️', name: 'red heart', keywords: 'love' },
  { emoji: '😂', name: 'tears of joy', keywords: 'lol laugh funny' },
  { emoji: '🤣', name: 'rolling on the floor', keywords: 'rofl laugh' },
  { emoji: '😊', name: 'smiling', keywords: 'happy blush' },
  { emoji: '😀', name: 'grinning', keywords: 'smile happy' },
  { emoji: '😁', name: 'beaming', keywords: 'grin' },
  { emoji: '😅', name: 'sweat smile', keywords: 'phew nervous' },
  { emoji: '😉', name: 'winking', keywords: 'wink' },
  { emoji: '😍', name: 'heart eyes', keywords: 'love' },
  { emoji: '🥰', name: 'smiling with hearts', keywords: 'love' },
  { emoji: '😘', name: 'blowing a kiss', keywords: 'kiss' },
  { emoji: '😎', name: 'sunglasses', keywords: 'cool' },
  { emoji: '🤔', name: 'thinking', keywords: 'hmm' },
  { emoji: '😐', name: 'neutral', keywords: 'meh' },
  { emoji: '🙄', name: 'rolling eyes', keywords: 'ugh' },
  { emoji: '😮', name: 'surprised', keywords: 'wow' },
  { emoji: '😲', name: 'astonished', keywords: 'shock' },
  { emoji: '😢', name: 'crying', keywords: 'sad tear' },
  { emoji: '😭', name: 'sobbing', keywords: 'sad cry' },
  { emoji: '😡', name: 'angry', keywords: 'mad rage' },
  { emoji: '😴', name: 'sleeping', keywords: 'zzz tired' },
  { emoji: '🤯', name: 'mind blown', keywords: 'wow' },
  { emoji: '🥳', name: 'partying', keywords: 'celebrate birthday' },
  { emoji: '🤝', name: 'handshake', keywords: 'deal agree' },
  { emoji: '🙏', name: 'folded hands', keywords: 'please thanks pray' },
  { emoji: '👏', name: 'clapping', keywords: 'applause bravo' },
  { emoji: '🙌', name: 'raising hands', keywords: 'hooray praise' },
  { emoji: '👋', name: 'waving', keywords: 'hello hi bye' },
  { emoji: '💪', name: 'flexed biceps', keywords: 'strong' },
  { emoji: '👀', name: 'eyes', keywords: 'look watching' },
  { emoji: '🔥', name: 'fire', keywords: 'hot lit' },
  { emoji: '✨', name: 'sparkles', keywords: 'shiny new' },
  { emoji: '🎉', name: 'party popper', keywords: 'celebrate congrats' },
  { emoji: '💯', name: 'hundred', keywords: 'perfect score' },
  { emoji: '✅', name: 'check mark', keywords: 'done yes' },
  { emoji: '❌', name: 'cross mark', keywords: 'no wrong' },
  { emoji: '⚠️', name: 'warning', keywords: 'careful' },
  { emoji: '❓', name: 'question mark', keywords: 'what' },
  { emoji: '❗', name: 'exclamation', keywords: 'important' },
  { emoji: '💡', name: 'light bulb', keywords: 'idea' },
  { emoji: '🚀', name: 'rocket', keywords: 'launch ship' },
  { emoji: '🐛', name: 'bug', keywords: 'issue error' },
  { emoji: '🛠️', name: 'tools', keywords: 'fix build' },
  { emoji: '📌', name: 'pushpin', keywords: 'pin' },
  { emoji: '📎', name: 'paperclip', keywords: 'attach' },
  { emoji: '📚', name: 'books', keywords: 'read book club' },
  { emoji: '☕', name: 'coffee', keywords: 'tea break' },
  { emoji: '🍕', name: 'pizza', keywords: 'food' },
  { emoji: '🍻', name: 'cheers', keywords: 'beer drinks' },
  { emoji: '🎮', name: 'video game', keywords: 'play gaming' },
  { emoji: '🎵', name: 'music note', keywords: 'song' },
  { emoji: '🌟', name: 'glowing star', keywords: 'favorite' },
  { emoji: '🌈', name: 'rainbow', keywords: 'pride' },
  { emoji: '☀️', name: 'sun', keywords: 'sunny weather' },
  { emoji: '🌙', name: 'crescent moon', keywords: 'night' },
  { emoji: '🐱', name: 'cat', keywords: 'kitten pet' },
  { emoji: '🐶', name: 'dog', keywords: 'puppy pet' },
  { emoji: '🎂', name: 'birthday cake', keywords: 'party' },
  { emoji: '🏆', name: 'trophy', keywords: 'win' },
  { emoji: '💔', name: 'broken heart', keywords: 'sad' },
];

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '😮', '😢'] as const;

export function searchEmoji(query: string): readonly EmojiEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return EMOJI;
  return EMOJI.filter(
    (entry) => entry.name.includes(needle) || (entry.keywords?.includes(needle) ?? false),
  );
}
