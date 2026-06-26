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
  const p = MODEL_PRICING[model];
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

function buildArticlePrompt(input) {
  const {
    businessName = 'the business',
    businessType = 'local service business',
    service = 'general cleaning',
    city = 'Florida',
    keyword = '',
    tone = 'helpful, local, professional',
    targetAudience = 'homeowners and renters'
  } = input || {};

  const system = 'You are an SEO content writer for local service businesses. You always reply with valid JSON only — no prose, no code fences.';

  const user = `You are an SEO content writer for a local residential cleaning company in Florida.

Write a helpful, non-spammy blog article for homeowners and renters.

Business: ${businessName}
Business type: ${businessType}
Service: ${service}
City/area: ${city}
Target keyword: ${keyword}
Audience: ${targetAudience}
Tone: ${tone}

Requirements:
- Write in clear American English.
- Sound local and practical, not generic.
- Do not overpromise.
- Do not mention fake statistics.
- Do not claim certifications unless provided.
- Include practical cleaning advice.
- Mention when hiring a professional cleaner makes sense.
- Naturally include the city/area and service.
- Include a soft call to action for ${businessName}.
- Markdown body should be 700–1100 words with H2/H3 subheadings and a short intro and conclusion.
- The slug must be lowercase, hyphen-separated, no special characters.
- metaDescription must be under 160 characters.

Return valid JSON only with exactly these keys:
{
  "title": string,
  "slug": string,
  "metaDescription": string,
  "markdown": string,
  "suggestedExcerpt": string,
  "suggestedSocialPost": string
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
// Public generators
// ---------------------------------------------------------------------------

async function generateArticle(input) {
  const model = input.model || DEFAULT_MODEL;
  const { system, user } = buildArticlePrompt(input);
  const result = await callLLM({ system, user, model, temperature: 0.7, maxTokens: 3000 });
  const data = extractJson(result.raw);

  // Light shape validation — keeps downstream code honest.
  const required = ['title', 'slug', 'metaDescription', 'markdown', 'suggestedExcerpt', 'suggestedSocialPost'];
  for (const key of required) {
    if (!(key in data)) throw new Error(`LLM response missing field: ${key}`);
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

module.exports = {
  generateArticle,
  generateReviewPost,
  // exported for tests
  _internal: { extractJson, buildArticlePrompt, buildReviewPostPrompt, estimateCostUsd }
};
