// Pure text/markdown extraction helpers used by the deterministic SEO analyzer.
// Everything here is dependency-free and side-effect-free so it stays cheap to
// call on every article edit.

const crypto = require('crypto');

// Strip common markdown-only syntax so word counts / keyword hits reflect what
// a reader actually sees. Preserves link text (drops the URL), image alt text,
// and text inside emphasis marks. Does NOT try to be a full markdown parser.
function markdownToPlainText(markdown) {
  if (!markdown) return '';
  let s = String(markdown);

  // Fenced code blocks — drop wholesale (code doesn't count as prose).
  s = s.replace(/```[\s\S]*?```/g, ' ');
  // Inline code.
  s = s.replace(/`[^`]*`/g, ' ');
  // Images: keep alt text, drop URL.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, ' $1 ');
  // Links: keep anchor text, drop URL.
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Reference-style link definitions.
  s = s.replace(/^\s*\[[^\]]+\]:\s*.+$/gm, ' ');
  // Heading markers.
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  // Blockquote marker.
  s = s.replace(/^\s{0,3}>\s?/gm, '');
  // List markers.
  s = s.replace(/^\s{0,3}[-*+]\s+/gm, '');
  s = s.replace(/^\s{0,3}\d+\.\s+/gm, '');
  // HTML tags (from callouts, tables, etc).
  s = s.replace(/<[^>]+>/g, ' ');
  // Emphasis / bold markers.
  s = s.replace(/(\*\*|__|\*|_|~~)/g, '');
  // Horizontal rules.
  s = s.replace(/^\s{0,3}(-{3,}|_{3,}|\*{3,})\s*$/gm, ' ');
  // Table pipes.
  s = s.replace(/\|/g, ' ');

  return s.replace(/\s+/g, ' ').trim();
}

function countWords(text) {
  if (!text) return 0;
  const cleaned = String(text).trim();
  if (!cleaned) return 0;
  return cleaned.split(/\s+/).filter(Boolean).length;
}

// Split the plain-text article into paragraphs by blank lines in the original
// markdown. We split on the original so we don't dissolve list items into a
// single paragraph.
function extractParagraphs(markdown) {
  if (!markdown) return [];
  // Drop fenced code blocks so they don't count as long paragraphs.
  const src = String(markdown).replace(/```[\s\S]*?```/g, '');
  return src
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    // Skip heading-only, list-only, image-only, table blocks — they read
    // differently to a scanner.
    .filter((block) => {
      const first = block.split('\n')[0].trim();
      if (/^#{1,6}\s/.test(first)) return false;
      if (/^[-*+]\s/.test(first)) return false;
      if (/^\d+\.\s/.test(first)) return false;
      if (/^!\[/.test(first)) return false;
      if (/^\|/.test(first)) return false;
      return true;
    })
    .map((block) => markdownToPlainText(block));
}

// Extract every ATX heading as { level, text, raw, index }. Index is the line
// number in the original markdown, useful for detecting "conclusion near end".
function extractHeadings(markdown) {
  if (!markdown) return [];
  const lines = String(markdown).split('\n');
  const headings = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Track fenced blocks so ``` # not real heading is ignored.
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) {
      headings.push({
        level: m[1].length,
        text: m[2].trim(),
        raw: line,
        line: i,
      });
    }
  }
  return headings;
}

// Extract markdown links as { text, url, isMalformed }.
// Malformed = empty text, empty url, or url starts with " " / "#".
function extractLinks(markdown) {
  if (!markdown) return [];
  const links = [];
  // Skip code blocks — code often contains `[foo](bar)` samples.
  const src = String(markdown).replace(/```[\s\S]*?```/g, '');
  const re = /\[([^\]]*)\]\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const text = (m[1] || '').trim();
    const url = (m[2] || '').trim();
    const isImage = m.index > 0 && src[m.index - 1] === '!';
    if (isImage) continue;
    const isMalformed =
      !text || !url || /^\s/.test(url) || url === '#';
    links.push({ text, url, isMalformed });
  }
  return links;
}

// Extract images as { alt, url }. Both markdown ![alt](url) and inline <img>.
function extractImages(markdown) {
  if (!markdown) return [];
  const images = [];
  const src = String(markdown).replace(/```[\s\S]*?```/g, '');
  const mdRe = /!\[([^\]]*)\]\(([^)]*)\)/g;
  let m;
  while ((m = mdRe.exec(src)) !== null) {
    images.push({ alt: (m[1] || '').trim(), url: (m[2] || '').trim(), source: 'markdown' });
  }
  const imgRe = /<img\b([^>]*)>/gi;
  while ((m = imgRe.exec(src)) !== null) {
    const attrs = m[1] || '';
    const src2 = (attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    const alt = (attrs.match(/\balt\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    images.push({ alt: alt.trim(), url: src2.trim(), source: 'html' });
  }
  return images;
}

// Detect an FAQ section: any H2 whose text contains "FAQ" / "Frequently asked",
// followed by question-shaped H3s or bolded questions. Returns { present, count }.
function detectFaq(markdown) {
  if (!markdown) return { present: false, count: 0 };
  const headings = extractHeadings(markdown);
  const faqH2Idx = headings.findIndex(
    (h) => h.level === 2 && /\b(faq|frequently\s+asked\s+questions?)\b/i.test(h.text),
  );
  if (faqH2Idx === -1) return { present: false, count: 0 };
  // Count H3s after the FAQ heading, before the next H2.
  let count = 0;
  for (let i = faqH2Idx + 1; i < headings.length; i++) {
    if (headings[i].level === 2) break;
    if (headings[i].level === 3) count++;
  }
  return { present: true, count };
}

// Whether the article has a conclusion-ish section near the end. Looks for an
// H2 in the last 30% of headings whose text signals a wrap-up.
function detectConclusion(markdown) {
  const headings = extractHeadings(markdown);
  if (headings.length === 0) return { present: false };
  const rx = /\b(conclusion|wrap[-\s]?up|final\s+thoughts?|takeaway|takeaways|summary|the\s+bottom\s+line|key\s+takeaways)\b/i;
  const tail = headings.slice(Math.floor(headings.length * 0.6));
  const hit = tail.find((h) => rx.test(h.text));
  return { present: !!hit };
}

// The intro is the prose between the top of the document and the first H2.
function extractIntro(markdown) {
  if (!markdown) return '';
  const src = String(markdown);
  // Everything up to the first H2. If no H2, first 500 chars of plain text.
  const h2Idx = src.search(/^\s{0,3}##\s+/m);
  const region = h2Idx === -1 ? src.slice(0, 3000) : src.slice(0, h2Idx);
  return markdownToPlainText(region).trim();
}

function extractConclusionText(markdown) {
  const headings = extractHeadings(markdown);
  const rx = /\b(conclusion|wrap[-\s]?up|final\s+thoughts?|takeaway|takeaways|summary|the\s+bottom\s+line|key\s+takeaways)\b/i;
  const src = String(markdown || '');
  const lines = src.split('\n');
  // Pick the last H2 whose text matches, then take everything from that line
  // onward. Fall back to the last 400 words of the article.
  let concIdx = -1;
  for (const h of headings) {
    if (h.level === 2 && rx.test(h.text)) concIdx = h.line;
  }
  if (concIdx !== -1) {
    return markdownToPlainText(lines.slice(concIdx).join('\n'));
  }
  const plain = markdownToPlainText(src);
  const words = plain.split(/\s+/);
  return words.slice(Math.max(0, words.length - 400)).join(' ');
}

// Count occurrences of the keyword (case-insensitive, word-boundary-ish) in
// the plain-text version. Whole-phrase match — for "house cleaning tampa" we
// count occurrences of that exact phrase, not the individual words.
function countKeywordOccurrences(plainText, keyword) {
  if (!plainText || !keyword) return 0;
  const kw = String(keyword).trim().toLowerCase();
  if (!kw) return 0;
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Word boundary at each end where the keyword edge is a word char.
  const leadBoundary = /^\w/.test(kw) ? '(?<![\\w])' : '';
  const tailBoundary = /\w$/.test(kw) ? '(?![\\w])' : '';
  let re;
  try {
    re = new RegExp(leadBoundary + escaped + tailBoundary, 'gi');
  } catch {
    re = new RegExp(escaped, 'gi');
  }
  const matches = plainText.match(re);
  return matches ? matches.length : 0;
}

function containsKeyword(text, keyword) {
  return countKeywordOccurrences(text, keyword) > 0;
}

// Rough tokenization — used for slug/keyword alignment.
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
}

// Deterministic content fingerprint for cache invalidation on the seo_metadata
// JSONB blob. Any change to fields the analyzer reads MUST change this hash.
function contentHash({ keyword, title, slug, metaDescription, markdown, tags, images }) {
  const h = crypto.createHash('sha256');
  const payload = JSON.stringify({
    keyword: keyword || '',
    title: title || '',
    slug: slug || '',
    metaDescription: metaDescription || '',
    markdown: markdown || '',
    tags: Array.isArray(tags) ? tags.slice().sort() : [],
    // Only alt/url matter for the analyzer; ignore ordering surprises.
    images: Array.isArray(images)
      ? images.map((i) => ({ url: i.url || '', alt: i.alt || '', isHero: !!i.isHero }))
      : [],
  });
  h.update(payload);
  return h.digest('hex').slice(0, 32);
}

module.exports = {
  markdownToPlainText,
  countWords,
  extractParagraphs,
  extractHeadings,
  extractLinks,
  extractImages,
  detectFaq,
  detectConclusion,
  extractIntro,
  extractConclusionText,
  countKeywordOccurrences,
  containsKeyword,
  tokenize,
  contentHash,
};
