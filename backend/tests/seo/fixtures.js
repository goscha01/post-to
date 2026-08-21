// Fixture articles used by SEO analyzer tests.
// Each fixture is an object shaped like the analyzer's `analyze()` input.
// Names describe the situation the fixture exercises; assertions in the test
// file spot-check individual rules per fixture rather than every check.
//
// Real-world-ish content (Florida residential cleaning). The point is to give
// the deterministic analyzer realistic input, not to publish these.

const spotlessContext = {
  internalHostnames: ['spotless.homes', 'www.spotless.homes'],
  knownInternalUrls: [
    '/services/deep-cleaning',
    '/services/recurring-cleaning',
    '/services/move-out-cleaning',
    '/about',
    '/pricing',
    '/blog',
  ],
};

// Reusable 1,700-word body about routine house cleaning in Tampa.
// Intentionally well-structured — used as the "strong article" baseline and
// mutated for the negative fixtures.
const STRONG_BODY = `Keeping a home clean in Tampa's humid climate takes more than the occasional weekend blitz. Between salt-tinted air by the coast, pollen through the shoulder months, and the sand that finds its way inside on any beach day, most families benefit from routine house cleaning services that fit around real life. Whether you're a first-time homeowner in South Tampa or a busy renter in Seminole Heights, the right cadence turns a chore into a background hum you barely notice.

This guide walks through what a good routine cleaning covers, how often to book it, what it actually costs in Tampa, and how to work with a service so nothing gets missed. If you've been on the fence about whether it's worth the money, we'll help you think it through.

## What routine house cleaning services actually cover

A recurring visit is different from a one-time deep clean. The goal is to keep an already-tidy home consistently fresh, not to reset a home that hasn't been touched in months. Most Tampa cleaners will handle the following on every visit:

- Kitchen: countertops, exterior of appliances, cooktop, sink, and floors
- Bathrooms: toilets, tubs, sinks, mirrors, and floors
- Living areas: dusting flat surfaces, vacuuming rugs and upholstery, mopping hard floors
- Bedrooms: dusting, vacuuming, changing linens on request
- Trash removal and general tidying

What isn't included by default: baseboards on every visit, inside the oven, inside the fridge, and windows. These are usually add-ons, or they land on a rotating schedule so you're not paying for them weekly.

### Add-ons that pay for themselves in humidity

Florida's climate is unusually rough on a few surfaces. Consider asking your cleaner to rotate through:

- Ceiling fan blades — they collect a fine biofilm here
- Grout in showers — mildew appears fast if you're not running the fan
- Sliding door tracks — a magnet for sand and mineral dust
- Cabinet fronts — greasy vapor sticks in warm kitchens

## How often should you schedule routine house cleaning services?

The most common rhythm we see in Tampa homes is every other week. Weekly makes sense if you have young kids, indoor pets, or you work long hours and don't have time for the small in-between maintenance. Monthly can work for smaller households that pick up after themselves — but expect the visit itself to run a bit longer or cost slightly more because each session is doing three-to-four weeks of work.

### The bi-weekly sweet spot

Bi-weekly is popular for good reason:

1. Bathrooms and floors stay ahead of Tampa's humidity, which mildews grout and dulls tile fast if you fall behind
2. The visit stays predictable in length and price, because the cleaner knows exactly what state the home will be in
3. You still get one weekend a month completely free of house tasks

## What routine cleaning costs in Tampa

Pricing varies with home size, number of bathrooms, and whether you have pets. For a typical 2- or 3-bedroom Tampa home the going rate for a recurring visit runs from about $120 for a smaller condo up to around $220 for a larger single-family home. Deep cleans are separate and priced higher — usually the initial visit, then routine pricing takes over.

Add-ons that impact the price:

| Add-on | Typical add-on cost |
|---|---|
| Interior of oven | $30–$50 |
| Interior of fridge | $25–$40 |
| Interior windows | $50–$100 |
| Laundry (per load) | $15 |
| Baseboards (whole home) | $30 |

Prices trend higher during snowbird season and around holidays, when demand spikes. Booking a standing appointment locks in a rate.

### Should you tip?

Tipping is appreciated but not expected on routine visits. If you do tip, $10–$20 per visit is typical. For deep cleans or move-outs, 15–20% of the visit price is a reasonable ballpark.

## How to work with a cleaner so nothing gets missed

Routine cleaning works best when you and the cleaner are on the same page. A few things that make a real difference:

- Keep a note in a shared spot (fridge, notes app, text thread) with anything one-off — "guests coming Saturday, please prioritize the guest bath"
- Do a two-minute walk-through the first few visits so the cleaner learns your preferences
- Say what matters most to you — some households care most about floors, others care most about bathrooms
- Communicate when something is off, not weeks later

## Common mistakes to avoid

The most common issue we see with new customers isn't the cleaning itself — it's expectations. A recurring visit is not a deep clean. If your home hasn't had a proper reset in a year, book a deep clean first and let routine service take over.

Other pitfalls:

- Skipping the first walk-through, then being frustrated when the cleaner missed something
- Booking too infrequently to actually stay ahead of the mess
- Assuming the cleaner will move heavy furniture — they won't, for safety reasons

## Choosing a cleaner in Tampa

Look for a service that is licensed and insured, that gives you the same team when possible, and that has a clear pricing structure — no surprise charges. Ask how they handle cancellations and last-minute reschedules; life happens, and a good service builds in flexibility.

We recommend picking a company that will send the same person or pair to your home most weeks. Familiarity builds trust and speeds up the visit — your cleaner already knows where the vacuum lives and which shelf the coffee mugs go on.

## Key takeaways

- Bi-weekly is the sweet spot for most Tampa homes, given the humidity
- Expect to spend $120–$220 per recurring visit for a typical single-family home
- Add-ons like fan blades and grout matter more here than in a drier climate
- Book a deep clean first if you're starting from a home that's been neglected

If you're ready to hand off routine cleaning to a team that gets Florida homes, [book a visit with Spotless Homes](/services/recurring-cleaning) or [see our full service list](/services/deep-cleaning) for one-time deep cleans.

## Frequently asked questions

### How long does a routine house cleaning visit take?

Most bi-weekly visits for a 2- or 3-bedroom Tampa home take between 90 minutes and three hours, depending on size, pets, and add-ons.

### Do I need to be home during the cleaning?

You don't. Most customers give their cleaner a lockbox code or leave a key. Just let the office know your access preference.

### What if I need to skip a visit?

Any reputable Tampa cleaner will let you skip or reschedule with a day or two of notice — no charge. Same-day cancellations may have a small fee.

### Are cleaning supplies included?

Usually yes, but always confirm. Some customers prefer their cleaner use specific eco-friendly or fragrance-free products, and most services will accommodate that if you provide them.

### Are your cleaners background-checked?

Yes. Any legitimate Tampa cleaning service will background-check their team members. Ask before you book if it's not on their website.
`;

function make(overrides = {}) {
  return {
    keyword: 'routine house cleaning services',
    title: 'Routine House Cleaning Services in Tampa: A Complete Guide',
    slug: 'routine-house-cleaning-services-tampa',
    metaDescription:
      'Routine house cleaning services in Tampa: what they cover, how often to book, what they cost, and how to make bi-weekly cleaning work in Florida humidity.',
    markdown: STRONG_BODY,
    tags: ['tampa', 'cleaning', 'home maintenance', 'residential'],
    heroImage: 'https://cdn.spotless.homes/blog/routine-cleaning-hero.jpg',
    heroAlt: 'A tidy Tampa living room after a routine cleaning visit',
    images: [],
    searchIntent: 'informational',
    ...spotlessContext,
    ...overrides,
  };
}

const fixtures = {
  // 1. Strong article — should score green with almost everything passing.
  strong: make(),

  // 2. Short article — flags word_count and probably paragraph rules.
  short: make({
    markdown:
      '## What routine house cleaning services cover\n\nRoutine house cleaning services keep your Tampa home consistently fresh.\n\n## When to book\n\nBi-weekly works for most homes.\n',
  }),

  // 3. Missing keyword everywhere.
  missingKeyword: make({
    title: 'A Guide to Keeping Your Home Sparkling',
    slug: 'guide-to-keeping-your-home-sparkling',
    metaDescription: 'Tips for keeping any Florida home clean, week after week, without burning a weekend on it.',
    heroAlt: 'A bright, tidy living room',
    markdown: STRONG_BODY
      .replace(/routine house cleaning services/gi, 'periodic tidying-up')
      .replace(/routine cleaning/gi, 'periodic tidy-up')
      .replace(/routine visit/gi, 'periodic visit'),
  }),

  // 4. Keyword stuffing — jam the phrase in unnaturally.
  stuffed: (() => {
    const stuffed = STRONG_BODY + '\n\n' +
      Array.from({ length: 90 }).map(() => 'Routine house cleaning services routine house cleaning services routine house cleaning services.').join(' ');
    return make({ markdown: stuffed });
  })(),

  // 5. Bad heading hierarchy — jumps H2 → H4 and starts body with H1.
  badHierarchy: make({
    markdown:
      '# Routine House Cleaning Services\n\nIntroduction paragraph talking about routine house cleaning services in Tampa and how they work.\n\n#### Deep clean vs routine\n\nSome details.\n\n## What is included\n\nMore prose about the topic and what routine house cleaning services in Tampa actually cover for a typical home.\n\n#### Sub-sub-heading skipping levels\n\nEven more.\n',
  }),

  // 6. No internal links at all (but knownInternalUrls is provided).
  noInternalLinks: make({
    markdown: STRONG_BODY
      .replace('[book a visit with Spotless Homes](/services/recurring-cleaning)', 'call our team')
      .replace('[see our full service list](/services/deep-cleaning)', 'ask about deep cleans'),
  }),

  // 7. Poor anchor text ("click here", "learn more").
  poorAnchors: make({
    markdown: STRONG_BODY
      .replace('[book a visit with Spotless Homes](/services/recurring-cleaning)', '[click here](/services/recurring-cleaning)')
      .replace('[see our full service list](/services/deep-cleaning)', '[learn more](/services/deep-cleaning)'),
  }),

  // 8. Missing image alt — hero present but empty alt, body image with no alt.
  missingImageAlt: make({
    heroAlt: '',
    markdown:
      STRONG_BODY + '\n\n![](https://cdn.spotless.homes/blog/kitchen.jpg)\n',
  }),

  // 9. Long paragraphs — one 400-word wall.
  longParagraphs: make({
    markdown:
      Array.from({ length: 40 }).map(() =>
        'Routine house cleaning services in Tampa take a lot of pressure off the household calendar because Florida homes get a lot of use from indoor-outdoor living, and everything from sand from the coast to pollen through spring finds its way onto floors and counters, and once you fall behind on baseboards or grout in the shower, catching up takes real effort and often a deep clean, which is why most families we see settle into a bi-weekly rhythm within the first month of hiring a service.'
      ).join(' ') + '\n\n## Section two heading\n\nShort paragraph.',
  }),

  // 10. Missing meta description entirely.
  missingMeta: make({ metaDescription: '' }),

  // 11. Meta description oversized (200+ chars).
  oversizedMeta: make({
    metaDescription:
      'This is a really really really long meta description that keeps rambling about routine house cleaning services in Tampa Florida and how they work and what they cost and every single detail you might want including humidity and sand and grout and Florida living in the summer season for real.',
  }),

  // 12. Malformed markdown — unbalanced code fence, headings with no space.
  malformedMarkdown: make({
    markdown:
      '## Routine house cleaning services\n\nSome intro about routine house cleaning services in Tampa.\n\n##NoSpace\n\nThis heading is malformed. And this fenced code block never closes:\n\n```\nnot closed\n\n## Section\n\nMore text.\n',
  }),

  // 13. FAQ article — search intent flagged, FAQ present.
  faqArticle: make({
    searchIntent: 'FAQ',
    markdown: STRONG_BODY,
  }),

  // 14. Legitimate article without FAQ — searchIntent isn't Q&A, so the rule
  //     should return N/A rather than a warning.
  noFaqOk: make({
    markdown: STRONG_BODY.replace(/## Frequently asked questions[\s\S]*$/i, ''),
  }),

  // 15. Article with lists and a table — lists_present + wall-of-text checks.
  listsAndTables: make(),
};

module.exports = { fixtures, STRONG_BODY, make, spotlessContext };
