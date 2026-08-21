// AI content generation service.
// Wraps an LLM provider (OpenAI Chat Completions by default) and provides:
//   - generateArticle({ businessName, businessType, service, city, keyword, tone, targetAudience })
//   - generateReviewPost({ businessName, businessType, city, reviewText, reviewRating, reviewerName, platform, tone })
//
// Returns: { data, raw, prompt, model, usage } where `data` is the parsed JSON object
// the model produced. Throws on transport errors or unparseable responses.
//
// Provider is chosen by AI_PROVIDER env var (default: 'openai').
// Currently only 'openai' is implemented but the shape is provider-agnostic so a
// future provider (anthropic, etc.) can plug in without route changes.

const axios = require('axios');

const DEFAULT_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';
// Article generation gets its own model knob — an SEO article is more
// demanding than a review-post caption. Falls back to AI_MODEL so today's
// deployment continues to use gpt-4o-mini until we benchmark and flip.
const DEFAULT_ARTICLE_MODEL = process.env.AI_ARTICLE_MODEL || DEFAULT_MODEL;
const DEFAULT_PROVIDER = (process.env.AI_PROVIDER || 'openai').toLowerCase();
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

// Per-1K-token prices for cost estimation (USD). Best-effort; adjust as needed.
const MODEL_PRICING = {
  'gpt-4o-mini':   { prompt: 0.00015, completion: 0.0006 },
  'gpt-4o':        { prompt: 0.0025,  completion: 0.01   },
  'gpt-4.1-mini':  { prompt: 0.0004,  completion: 0.0016 },
  'gpt-4.1':       { prompt: 0.002,   completion: 0.008  }
};

function estimateCostUsd(model, usage) {
  if (!usage) return null;
  // OpenAI returns the versioned model id in the response (e.g.
  // "gpt-4o-mini-2024-07-18"). Match against the price table by longest
  // prefix so any dated variant maps to its family's price.
  let p = MODEL_PRICING[model];
  if (!p && model) {
    const family = Object.keys(MODEL_PRICING)
      .filter((k) => String(model).startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (family) p = MODEL_PRICING[family];
  }
  if (!p) return null;
  const promptCost = (usage.prompt_tokens || 0) / 1000 * p.prompt;
  const completionCost = (usage.completion_tokens || 0) / 1000 * p.completion;
  return Number((promptCost + completionCost).toFixed(6));
}

// Extract first JSON object from a string. Models occasionally wrap JSON in code
// fences or add leading commentary; we tolerate that here.
function extractJson(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('LLM returned empty content');
  }
  let trimmed = text.trim();

  // Strip ```json ... ``` or ``` ... ``` fences.
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) trimmed = fenceMatch[1].trim();

  try {
    return JSON.parse(trimmed);
  } catch (_) {
    // Fall through to brace search.
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    const candidate = trimmed.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch (e) {
      throw new Error(`Could not parse JSON from LLM response: ${e.message}`);
    }
  }
  throw new Error('LLM response did not contain a JSON object');
}

async function callOpenAI({ system, user, model, temperature = 0.7, maxTokens = 2500 }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');

  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' }
  };

  const resp = await axios.post(OPENAI_URL, body, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    timeout: 90_000
  });

  const choice = resp.data?.choices?.[0];
  const content = choice?.message?.content;
  if (!content) throw new Error('LLM returned no content');

  return {
    raw: content,
    usage: resp.data?.usage || null,
    model: resp.data?.model || model
  };
}

async function callLLM(args) {
  if (DEFAULT_PROVIDER !== 'openai') {
    throw new Error(`Unsupported AI_PROVIDER: ${DEFAULT_PROVIDER}`);
  }
  return callOpenAI(args);
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

// Enhanced article prompt.
//
// Design choices worth calling out (they push back on common "AI-blog" tells):
//
//   1. Structure is adaptive. The prompt gives a menu of section types and
//      asks the model to pick the layout that fits the search intent — no
//      universal "Intro/H2/H2/FAQ/Conclusion" mould.
//   2. Word count is a target range (1500–2500), not a hard box. Justified
//      longer content is allowed; padding is explicitly forbidden.
//   3. Internal links are drawn ONLY from the known site URLs passed in.
//      When none are provided the model is instructed not to invent them.
//   4. Structured output extends the legacy 6-field JSON with tags, FAQ,
//      searchIntent, imageSuggestions, and suggestedInternalLinks — enough
//      for the analyzer + UI to work without re-parsing prose.
//   5. The body must start at H2 (the article title is the H1 rendered by
//      the site). The analyzer's heading_hierarchy check enforces this.
function buildArticlePrompt(input) {
  const {
    businessName = 'the business',
    businessType = 'local service business',
    service = 'general cleaning',
    city = 'Florida',
    keyword = '',
    tone = 'helpful, local, professional',
    targetAudience = 'homeowners and renters',
    articleTopic = '',
    knownInternalUrls = [],
  } = input || {};

  const system = 'You are a senior SEO content writer for local service businesses. You write in clear American English, sound local and specific, and never fabricate statistics or credentials. You always reply with valid JSON only — no prose, no code fences.';

  const internalLinksBlock = Array.isArray(knownInternalUrls) && knownInternalUrls.length
    ? `Available internal pages on the business's own website (use these for internal links — do NOT invent URLs):
${knownInternalUrls.slice(0, 25).map((u) => `- ${typeof u === 'string' ? u : (u.url || '')}${typeof u === 'object' && u.title ? `  (${u.title})` : ''}`).join('\n')}`
    : `Internal pages available: NONE. Do NOT invent internal links. Skip the suggestedInternalLinks array (return []).`;

  const user = `You are writing one long-form SEO article for a local service business.

Business: ${businessName}
Business type: ${businessType}
Primary service: ${service}
City / service area: ${city}
Target keyword: "${keyword}"
${articleTopic ? `Article topic angle: ${articleTopic}` : ''}
Target audience: ${targetAudience}
Tone: ${tone}

${internalLinksBlock}

# Search intent

Before writing, silently decide the search intent behind "${keyword}" — informational, transactional, comparison, how-to, list, or FAQ — and let that dictate the article's structure. Different keywords deserve different layouts. Do not use the same template for every article.

# Structure — pick what fits, do not use everything

**MANDATORY first block**: 1–2 short opening paragraphs (60–120 words total) that name the topic, mention the target keyword naturally, and preview what the reader will get. This intro comes BEFORE any H2, BEFORE any "Key Takeaways" callout, BEFORE any list. Do NOT start the article with a heading — start with prose.

After the intro, pick from these sections in any order that reads naturally:
- "Key Takeaways" callout (3–6 crisp bullet points) — useful for long articles
- Definition / background section
- Step-by-step or how-to walkthrough
- Comparison (best done as a table)
- Pros/cons or checklist (list format)
- Cost / pricing section (table where amounts vary by dimension)
- Common mistakes / what to avoid
- FAQ — 3–6 real questions people ask about "${keyword}" — only if it fits the intent
- Conclusion or "Key takeaways" wrap-up with a soft CTA

Choose the combination that best answers the search intent. Do NOT include an FAQ or a comparison table if the topic doesn't call for it. Vary the layout between articles — this is important.

# Formatting rules

- The article title is the H1 rendered by the site. The body MUST open with the intro paragraphs, then move to H2 for the first section. Never emit an H1 (# ) in the body.
- Never start the body with a heading. Never start the body with a list. Never start the body with a "Key Takeaways" callout — the intro comes first.
- Use H2 for major sections. Use H3 for sub-points inside a section. Do not skip heading levels.
- Write short, scannable paragraphs (target 2–5 sentences, ~60–90 words). Avoid walls of text.
- Use bullet or numbered lists where they improve scanning.
- Use markdown tables when data has 2+ dimensions (e.g. "add-on | typical cost").
- If you include an FAQ, put each question as an H3.
- Any callouts should be clearly labeled (e.g. an H3 "Key takeaways" followed by a bullet list).

# Length

Target 1500–2500 words. Longer is allowed IF the extra content is genuinely useful. Do NOT pad to hit a word count.

# Keyword usage

- Use the target keyword in: the title, the introduction, at least one H2 or H3, and the conclusion.
- Density should be natural — a handful of exact uses plus close variants. Do NOT stuff the keyword.

# Trust and quality

- Do NOT invent statistics, awards, certifications, or guarantees.
- Do NOT claim you serve areas the business doesn't (only the given city).
- Where mentioning cost, give ranges typical for ${city} and note that pricing varies.
- Mention when hiring a professional makes sense; also when DIY is fine.
- Include a soft CTA for ${businessName} near the end.

# Internal links

- Only link to URLs from the list above. Use descriptive anchor text (e.g. "see our deep cleaning service" — not "click here" / "learn more").
- Do NOT force internal links if none are relevant.

# Images

- Do NOT put any image markdown in the body. The site inserts the hero image itself.
- In imageSuggestions, list 2–4 specific images that would strengthen the article (each with a descriptive alt including relevant semantic phrases). These are hints for the editor, not required to be present.

# Output — return valid JSON only, exactly these keys:

{
  "title": string,                          // 45–65 chars, includes keyword
  "slug": string,                           // lowercase, hyphens only, no leading/trailing hyphen
  "metaDescription": string,                // MUST be 140–160 chars (aim for 145–158). Includes keyword naturally. Do NOT return anything shorter than 140 chars.
  "markdown": string,                       // article body starting at H2
  "suggestedExcerpt": string,               // 150–220 chars, standalone summary
  "suggestedSocialPost": string,            // 1–2 sentences for a GBP/Facebook post
  "tags": string[],                         // 3–8 lowercase tag words
  "searchIntent": string,                   // one of: informational | how-to | comparison | list | transactional | FAQ | other
  "faq": [{"question": string, "answer": string}],  // [] if none
  "imageSuggestions": [{"description": string, "alt": string}],  // 2–4 suggestions
  "suggestedInternalLinks": [{"anchor": string, "url": string}]  // may be [] if none available
}`;

  return { system, user };
}

// Targeted repair prompt: given the previous article JSON and the analyzer's
// findings, ask the model to output an improved JSON in the SAME schema,
// changing ONLY what's needed to address the failed / low-confidence checks.
// Used by generateArticleWithSeo for the single bounded repair pass, and by
// the frontend "Fix with AI" action for scoped fixes.
function buildArticleRepairPrompt({ previousJson, analysis, keyword, businessName, knownInternalUrls = [] }) {
  const failedChecks = (analysis?.checks || []).filter(
    (c) => c.status === 'failed' || (c.status === 'warning' && c.weight >= 2),
  );

  const failedBlock = failedChecks
    .slice(0, 20)
    .map((c) => `- [${c.status}] ${c.label}${c.value ? ` (${c.value})` : ''} — ${c.recommendation || 'improve this'}`)
    .join('\n');

  const internalLinksBlock = Array.isArray(knownInternalUrls) && knownInternalUrls.length
    ? `Available internal URLs (use only these; do NOT invent):\n${knownInternalUrls.slice(0, 25).map((u) => `- ${typeof u === 'string' ? u : (u.url || '')}`).join('\n')}`
    : `No internal URLs available. Do NOT invent internal links.`;

  const system = 'You are a senior SEO editor. You revise an existing article JSON to address specific SEO issues without rewriting sections that are already good. You always reply with valid JSON only — no prose, no code fences.';

  const user = `An article was generated for the keyword "${keyword}" for ${businessName}. A deterministic SEO analyzer found the following issues:

${failedBlock || '(no significant issues — return the article unchanged)'}

${internalLinksBlock}

Revise the article to fix these issues:
- Keep the overall structure and voice.
- Only edit what needs editing. Do not rewrite the whole article.
- If a check is about metadata (title / slug / metaDescription / tags), fix that field.
- If a check is about content structure (headings, paragraph length, missing intro/conclusion, missing keyword in headings), edit just those sections.
- If internal links are required, use ONLY the URLs listed above.
- Do NOT introduce fake statistics or claims to satisfy a check.
- Do NOT stuff the keyword to satisfy density — natural placement in title + intro + one heading + conclusion is enough.

Previous article JSON:
${JSON.stringify(previousJson)}

Return valid JSON only, in the SAME schema as the original (title, slug, metaDescription, markdown, suggestedExcerpt, suggestedSocialPost, tags, searchIntent, faq, imageSuggestions, suggestedInternalLinks). Every key from the previous JSON must be present in the response.`;

  return { system, user };
}

function buildReviewReplyPrompt(input) {
  const {
    businessName = 'the business',
    businessType = 'local service business',
    city = '',
    reviewText = '',
    reviewRating = null,
    reviewerName = '',
    tone = 'warm, professional, personal',
    existingReply = ''
  } = input || {};

  const ratingNum = Number(reviewRating);
  const isPositive = ratingNum >= 4;
  const isNegative = ratingNum > 0 && ratingNum <= 3;
  const stance = isPositive
    ? 'The review is positive. Thank the customer warmly and reinforce one specific thing they mentioned.'
    : isNegative
      ? 'The review is negative or mixed. Acknowledge their experience, apologize sincerely for what they described, avoid being defensive, and invite them to contact the business directly to make it right. Do not include a phone number, email, or URL unless it is present in the input.'
      : 'Rating is unknown. Respond warmly and briefly.';

  const system = 'You are the business owner replying directly to a customer review on Google Business Profile. You always reply with valid JSON only — no prose, no code fences.';

  const user = `You are the owner of ${businessName} (${businessType}) replying to a customer review on Google Business Profile${city ? ` in ${city}` : ''}.

Reviewer name: ${reviewerName || 'unknown'}
Review rating: ${reviewRating !== null && reviewRating !== undefined ? reviewRating : 'unknown'}
Review text: ${reviewText || '(no written comment — rating only)'}
${existingReply ? `Existing draft to improve on: ${existingReply}` : ''}
Tone: ${tone}

${stance}

Rules:
- Address the reviewer by first name only if provided; otherwise a warm generic opener.
- Sound human — this is the owner replying, not a marketing bot.
- Reference something specific from the review when possible (a room, a service, a detail).
- No hashtags. No emojis. No calls to book. This is a reply, not a promo post.
- Do not include private info (last names, addresses, phone, email) unless present in the review itself.
- Do not invent facts, discounts, or promises the business hasn't made.
- Keep it 2–5 sentences, under 800 characters.
- If the review is empty (rating only), keep it very short — 1–2 sentences — and don't quote or invent anything.

Return valid JSON only with exactly this key:
{
  "reply": string
}`;

  return { system, user };
}

function buildReviewPostPrompt(input) {
  const {
    businessName = 'the business',
    businessType = 'local service business',
    city = '',
    reviewText = '',
    reviewRating = null,
    reviewerName = '',
    tone = 'warm, grateful, professional'
  } = input || {};

  const system = 'You are a marketing assistant for local service businesses. You always reply with valid JSON only — no prose, no code fences.';

  const user = `You are a marketing assistant for a local residential cleaning company.

Create a warm social media / Google Business Profile post based on a customer review.

Business: ${businessName}
Business type: ${businessType}
City/area: ${city}
Review rating: ${reviewRating !== null && reviewRating !== undefined ? reviewRating : 'unknown'}
Reviewer name: ${reviewerName || 'unknown'}
Review text: ${reviewText}
Tone: ${tone}

Rules:
- Be grateful and professional.
- Do not include private details (no last names, addresses, phone, email).
- Use only the reviewer's first name, or "one of our customers" if the name is missing or ambiguous.
- Do not exaggerate or make claims not supported by the review.
- Do not write fake testimonials. If the review text is empty, write a generic thank-you that does not quote anything.
- Do not mention discounts unless provided.
- Make it sound natural for a cleaning company.
- Include a soft call to action.
- caption: long-form social caption (Instagram/Facebook style), 2–4 short paragraphs.
- shortCaption: under 200 characters, suitable for Twitter/X.
- googleBusinessPost: 1500-character max, suitable for a GMB update post.
- hashtags: array of 4–8 relevant hashtag strings, each starting with #.

Return valid JSON only with exactly these keys:
{
  "caption": string,
  "shortCaption": string,
  "googleBusinessPost": string,
  "hashtags": string[]
}`;

  return { system, user };
}

// ---------------------------------------------------------------------------
// Vision helper — used by generatePostFromImages
// ---------------------------------------------------------------------------
async function callOpenAIVision({ system, userText, images, model, temperature = 0.7, maxTokens = 500 }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');

  // Vision expects the user content to be an array of parts, mixing text and
  // image_url items. image_url.url may be a public URL or a data: URL —
  // the caller decides which per image.
  const contentParts = [{ type: 'text', text: userText }];
  for (const img of images) {
    if (img.base64) {
      contentParts.push({
        type: 'image_url',
        image_url: {
          url: `data:${img.mimeType || 'image/jpeg'};base64,${img.base64}`,
          detail: 'auto',
        },
      });
    } else if (img.url) {
      contentParts.push({
        type: 'image_url',
        image_url: { url: img.url, detail: 'auto' },
      });
    }
  }

  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: contentParts },
    ],
    temperature,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
  };

  const resp = await axios.post(OPENAI_URL, body, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: 90_000,
  });

  const content = resp.data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM returned no content');
  return { raw: content, usage: resp.data?.usage || null, model: resp.data?.model || model };
}

// ---------------------------------------------------------------------------
// Public generators
// ---------------------------------------------------------------------------

// Article model gets more headroom than review-post captions — the enhanced
// prompt asks for 1500–2500 words plus a structured JSON envelope.
const ARTICLE_MAX_TOKENS = 6000;

// Validate + normalize the LLM's structured output. Enforces the six legacy
// fields (title/slug/metaDescription/markdown/suggestedExcerpt/
// suggestedSocialPost) — throws if missing — and defaults the new fields
// (tags/faq/searchIntent/imageSuggestions/suggestedInternalLinks) so the
// downstream code never crashes on a partial model response.
function normalizeArticleOutput(data) {
  const requiredLegacy = ['title', 'slug', 'metaDescription', 'markdown', 'suggestedExcerpt', 'suggestedSocialPost'];
  for (const key of requiredLegacy) {
    if (!(key in data)) throw new Error(`LLM response missing field: ${key}`);
  }
  return {
    title: String(data.title || '').trim(),
    slug: String(data.slug || '').trim(),
    metaDescription: String(data.metaDescription || '').trim(),
    markdown: String(data.markdown || ''),
    suggestedExcerpt: String(data.suggestedExcerpt || '').trim(),
    suggestedSocialPost: String(data.suggestedSocialPost || '').trim(),
    tags: Array.isArray(data.tags)
      ? data.tags.map((t) => String(t || '').trim().toLowerCase()).filter(Boolean).slice(0, 12)
      : [],
    searchIntent: data.searchIntent ? String(data.searchIntent).trim() : '',
    faq: Array.isArray(data.faq)
      ? data.faq
          .map((f) => ({ question: String(f?.question || '').trim(), answer: String(f?.answer || '').trim() }))
          .filter((f) => f.question && f.answer)
          .slice(0, 8)
      : [],
    imageSuggestions: Array.isArray(data.imageSuggestions)
      ? data.imageSuggestions
          .map((i) => ({ description: String(i?.description || '').trim(), alt: String(i?.alt || '').trim() }))
          .filter((i) => i.description || i.alt)
          .slice(0, 6)
      : [],
    suggestedInternalLinks: Array.isArray(data.suggestedInternalLinks)
      ? data.suggestedInternalLinks
          .map((l) => ({ anchor: String(l?.anchor || '').trim(), url: String(l?.url || '').trim() }))
          .filter((l) => l.anchor && l.url)
          .slice(0, 10)
      : [],
  };
}

async function generateArticle(input) {
  const model = input.model || DEFAULT_ARTICLE_MODEL;
  const { system, user } = buildArticlePrompt(input);
  const result = await callLLM({ system, user, model, temperature: 0.7, maxTokens: ARTICLE_MAX_TOKENS });
  const data = normalizeArticleOutput(extractJson(result.raw));

  return {
    data,
    raw: result.raw,
    prompt: user,
    model: result.model,
    usage: result.usage,
    costUsd: estimateCostUsd(result.model, result.usage)
  };
}

// Targeted repair pass. Runs the same schema through the model with the
// analyzer's failure list. Never asked to invent internal URLs; may return
// the article unchanged if it decides the analyzer's issues are subjective.
async function repairArticle({ previousJson, analysis, keyword, businessName, knownInternalUrls, model }) {
  const chosenModel = model || DEFAULT_ARTICLE_MODEL;
  const { system, user } = buildArticleRepairPrompt({ previousJson, analysis, keyword, businessName, knownInternalUrls });
  const result = await callLLM({ system, user, model: chosenModel, temperature: 0.5, maxTokens: ARTICLE_MAX_TOKENS });
  const data = normalizeArticleOutput(extractJson(result.raw));
  return {
    data,
    raw: result.raw,
    prompt: user,
    model: result.model,
    usage: result.usage,
    costUsd: estimateCostUsd(result.model, result.usage),
  };
}

async function generateReviewReply(input) {
  const model = input.model || DEFAULT_MODEL;
  const { system, user } = buildReviewReplyPrompt(input);
  const result = await callLLM({ system, user, model, temperature: 0.7, maxTokens: 500 });
  const data = extractJson(result.raw);

  if (typeof data.reply !== 'string' || !data.reply.trim()) {
    throw new Error('LLM response missing non-empty "reply" string');
  }

  return {
    data,
    raw: result.raw,
    prompt: user,
    model: result.model,
    usage: result.usage,
    costUsd: estimateCostUsd(result.model, result.usage)
  };
}

async function generateReviewPost(input) {
  const model = input.model || DEFAULT_MODEL;
  const { system, user } = buildReviewPostPrompt(input);
  const result = await callLLM({ system, user, model, temperature: 0.7, maxTokens: 1200 });
  const data = extractJson(result.raw);

  const required = ['caption', 'shortCaption', 'googleBusinessPost', 'hashtags'];
  for (const key of required) {
    if (!(key in data)) throw new Error(`LLM response missing field: ${key}`);
  }
  if (!Array.isArray(data.hashtags)) {
    throw new Error('hashtags must be an array');
  }

  return {
    data,
    raw: result.raw,
    prompt: user,
    model: result.model,
    usage: result.usage,
    costUsd: estimateCostUsd(result.model, result.usage)
  };
}

// Vision-based post generator. Takes an array of images (either base64 or
// public URLs) and returns a GBP-appropriate caption grounded in what the
// model actually sees. Uses the same audit / cost accounting as the other
// generators via aiJobs.
async function generatePostFromImages(input) {
  const {
    businessName = 'the business',
    businessType = 'local service business',
    city = '',
    tone = 'warm, professional, engaging',
    images = [],
    includeCallToAction = false,
    ctaType = null,
    postType = 'UPDATE',
    additionalContext = '',
  } = input || {};

  if (!Array.isArray(images) || images.length === 0) {
    throw new Error('generatePostFromImages requires at least one image');
  }

  const system =
    'You are the business owner writing a Google Business Profile post. Look at the images and write a caption that reflects what is actually visible. Always reply with valid JSON only — no prose, no code fences.';

  const multi = images.length > 1;
  const userText = `Business: ${businessName}
Business type: ${businessType}${city ? `\nLocation: ${city}` : ''}
Post type: ${postType}
Tone: ${tone}${additionalContext ? `\nExtra context: ${additionalContext}` : ''}

You are looking at ${images.length === 1 ? 'one image' : `${images.length} images`}, in the order provided.

Do this:
1. Describe what is in each image, one line per image, referring to them as Image 1, Image 2, etc. Be concrete — mention rooms, surfaces, tools, before/after, team members, results.
2. Write a single Google Business Profile caption (150-500 chars) that reflects the full set: if images are a before/after pair, call that out; if it's a job walkthrough, reference the sequence; if unrelated, pick the strongest one or two visual details to lead with.
3. Sound like the owner — conversational, not agency-speak.
4. No hashtags. Use emoji sparingly and only when natural.
5. Do not invent facts (prices, awards, guarantees) that aren't grounded in what is visible or the business context above.
${includeCallToAction ? `6. End with a soft CTA appropriate for a ${ctaType || 'BOOK'} action.` : '6. No hard sell.'}

Return valid JSON with exactly these keys:
{
  "text": string,${multi ? '\n  "imageDescriptions": string[]  // one per image, in order,' : ''}
  "imageDescription": string  // one-sentence summary of the whole set
}`;

  const model = input.model || DEFAULT_MODEL;
  const result = await callOpenAIVision({
    system,
    userText,
    images,
    model,
    temperature: 0.7,
    // Scaled by image count — per-image descriptions + main caption need
    // room to breathe on larger sets.
    maxTokens: Math.min(2000, 400 + images.length * 120),
  });
  const data = extractJson(result.raw);
  if (typeof data.text !== 'string' || !data.text.trim()) {
    throw new Error('LLM response missing non-empty "text" string');
  }

  return {
    data: {
      text: data.text.trim(),
      imageDescription: (data.imageDescription || '').trim(),
      imageDescriptions: Array.isArray(data.imageDescriptions)
        ? data.imageDescriptions.map((s) => (s || '').toString().trim()).filter(Boolean)
        : [],
    },
    raw: result.raw,
    prompt: userText,
    model: result.model,
    usage: result.usage,
    costUsd: estimateCostUsd(result.model, result.usage),
  };
}

module.exports = {
  generateArticle,
  repairArticle,
  generateReviewPost,
  generateReviewReply,
  generatePostFromImages,
  normalizeArticleOutput,
  // exported for tests
  _internal: {
    extractJson,
    buildArticlePrompt,
    buildArticleRepairPrompt,
    buildReviewPostPrompt,
    buildReviewReplyPrompt,
    estimateCostUsd,
    DEFAULT_ARTICLE_MODEL,
  },
};
