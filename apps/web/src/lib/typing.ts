/** "Ada is typing…", "Ada and Linus are typing…", "Several people are typing…". */
export function typingText(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0] ?? ''} is typing…`;
  if (names.length === 2) return `${names[0] ?? ''} and ${names[1] ?? ''} are typing…`;
  return 'Several people are typing…';
}
