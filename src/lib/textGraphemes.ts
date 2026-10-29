/**
 * Grapheme-safe string utilities using Intl.Segmenter with Array.from fallback.
 * Prevents slicing multibyte characters, combining diacritics, or surrogate pairs.
 */

interface SegmentData {
  segment: string;
  index: number;
  input: string;
}

interface CustomSegmenter {
  segment(input: string): Iterable<SegmentData>;
}

let segmenterInstance: CustomSegmenter | null = null;

function getSegmenter(): CustomSegmenter | null {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    if (!segmenterInstance) {
      const SegmenterClass = (Intl as any).Segmenter;
      segmenterInstance = new SegmenterClass(undefined, { granularity: 'grapheme' });
    }
    return segmenterInstance;
  }
  return null;
}

export function splitGraphemes(text: string): string[] {
  if (!text) return [];
  const segmenter = getSegmenter();
  if (segmenter) {
    return Array.from(segmenter.segment(text), (s: SegmentData) => s.segment);
  }
  return Array.from(text);
}

export function graphemeLength(text: string): number {
  if (!text) return 0;
  return splitGraphemes(text).length;
}

export function truncateGraphemes(
  text: string,
  maxGraphemes: number,
  ellipsis: string = '…'
): string {
  if (!text) return '';
  if (maxGraphemes <= 0) return '';

  const graphemes = splitGraphemes(text);
  if (graphemes.length <= maxGraphemes) {
    return text;
  }

  const ellipsisGraphemes = splitGraphemes(ellipsis);
  const ellipsisLen = ellipsisGraphemes.length;

  if (maxGraphemes <= ellipsisLen) {
    return graphemes.slice(0, maxGraphemes).join('');
  }

  const keepCount = maxGraphemes - ellipsisLen;
  return graphemes.slice(0, keepCount).join('') + ellipsis;
}
