export interface LyricLine {
  time: number;
  text: string;
}
export function parseLrc(text: string): LyricLine[] {
  const output: LyricLine[] = [];
  const plain: string[] = [];
  const wordTimestamp = /\[\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]\]/g;
  const timestamp = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const normalized = line.replace(wordTimestamp, '');
    const matches = [...normalized.matchAll(timestamp)];
    const content = normalized
      .replace(timestamp, '')
      .replace(/<\d+,\d+>/g, '')
      .trim();
    if (!content) continue;
    plain.push(content);
    for (const match of matches) {
      const fraction = (match[3] || '').padEnd(3, '0').slice(0, 3);
      output.push({
        time:
          Number(match[1]) * 60 +
          Number(match[2]) +
          Number(fraction || 0) / 1000,
        text: content,
      });
    }
  }
  if (output.length) return output.sort((a, b) => a.time - b.time);
  return plain.map((line) => ({ time: Number.POSITIVE_INFINITY, text: line }));
}
