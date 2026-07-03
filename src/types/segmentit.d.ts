// segmentit 无官方类型声明，这里补最小声明（仅覆盖本插件用到的 API）
declare module 'segmentit/dist/esm/segmentit.js' {
  export interface SegmentWord {
    w: string;
    p: number;
  }
  export interface DoSegmentOptions {
    simple?: boolean;
    stripPunctuation?: boolean;
    stripStopword?: boolean;
    convertSynonym?: boolean;
  }
  export class Segment {
    POSTAG: Record<string, number>;
    use(mods: unknown): Segment;
    loadDict(dict: string | string[], type?: string, convertToLower?: boolean): Segment;
    loadSynonymDict(dict: string | string[]): Segment;
    loadStopwordDict(dict: string | string[]): Segment;
    doSegment(text: string, options: { simple: true } & DoSegmentOptions): string[];
    doSegment(text: string, options?: DoSegmentOptions): SegmentWord[];
  }
  export function useDefault(segment: Segment): Segment;
  export const POSTAG: Record<string, number>;
}
