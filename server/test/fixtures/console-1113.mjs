// The owner's console test of 2026-11-13 (Claude Code 2.1.323, NEXT.md §10): each relay
// time, the preview's command as relayed, and the hook's report with its delay after the
// relay. The relay folded runs of spaces only; the hook always came 22-26 ms after.
export const CONSOLE_1113 = [
  { at: 0, preview: 'touch t1.txt', report: 'touch t1.txt', after: 23 },
  { at: 21063, preview: 'touch t2.txt\ntouch t3.txt', report: 'touch t2.txt\ntouch t3.txt', after: 22 },
  { at: 36972, preview: 'touch\tt4.txt', report: 'touch\tt4.txt', after: 22 },
  { at: 50765, preview: "printf 'a b' > t5.txt", report: "printf 'a  b' > t5.txt", after: 24 },
  { at: 65882, preview: ' touch t6.txt ', report: '  touch t6.txt  ', after: 26 }
];
