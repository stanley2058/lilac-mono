/** Deterministic long conversations for exercising the timeline rail against real paging. */

export type ScriptTurn = { text: string; answer: string; at: number };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const between = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  return { next, pick, between };
}

const searchSubjects = [
  "the p95 latency on /search",
  "the shard rebalancer",
  "the query planner cache",
  "BM25 scoring for short queries",
  "the ingest backlog",
  "the replica lag alert",
  "GC pauses on the index nodes",
  "the synonym expansion step",
  "the cold-start warmup job",
  "the CJK tokenizer",
  "the rate limiter in front of search",
  "the nightly reindex",
  "the autocomplete endpoint",
  "the filter bitmap cache",
  "the cross-region failover drill",
  "the vector rerank stage",
];
const searchAsks = [
  "Why did {s} regress after yesterday's deploy?",
  "Summarize what we know about {s} so far.",
  "Draft a rollback plan for {s}.",
  "Compare the two fixes for {s} and pick one.",
  "Write a quick benchmark for {s}.",
  "What should on-call watch for {s} over the weekend?",
  "Explain {s} to someone joining the rotation.",
  "Is {s} related to the memory spike on Tuesday?",
  "List the open questions about {s}.",
  "Check my reasoning: I think {s} is bound on disk I/O.",
  "Here's the flame graph for {s}. What stands out?",
  "Can you turn the notes on {s} into a status update for the team?",
];
const searchFindings = [
  "The regression lines up with the cache key change in build 4127.",
  "Most of the time goes to decoding postings lists, not scoring.",
  "Shards 7 and 12 hold twice the documents of their neighbors.",
  "The warmup job finishes after traffic arrives, so the first minute runs cold.",
  "Replica lag peaks during the hourly compaction window.",
  "Allocation rate doubled once the rerank batch grew past 64 candidates.",
  "The planner falls back to a full scan when a filter matches more than 40% of documents.",
  "Synonym expansion fans one query into as many as 18 sub-queries.",
  "Disk reads are flat; the CPU profile points at JSON decoding instead.",
  "The rate limiter counts retries as new requests, which amplifies spikes.",
  "Autocomplete hits a separate cluster that never received the config change.",
];
const searchSteps = [
  "Pin the cache key format back to the previous version behind a flag.",
  "Move the warmup job ahead of the readiness probe.",
  "Cap synonym expansion at 6 variants per term.",
  "Rebalance shards 7 and 12 during the low-traffic window.",
  "Batch rerank requests at 32 and measure allocation again.",
  "Add a per-shard p95 panel so the next regression shows up in one place.",
  "Exclude retries from the limiter budget.",
  "Schedule compaction outside the replica catch-up window.",
];

function searchAnswer(r: ReturnType<typeof random>, subject: string, index: number): string {
  const findings = Array.from({ length: r.between(1, 3) }, () => r.pick(searchFindings));
  const steps = Array.from({ length: r.between(2, 4) }, () => r.pick(searchSteps));
  const parts = [
    `Looking at ${subject}: ${findings[0]}`,
    ...(findings.length > 1 ? [findings.slice(1).join(" ")] : []),
    `Next steps:\n\n${steps.map((step) => `- ${step}`).join("\n")}`,
  ];
  if (index % 7 === 3)
    parts.push(
      `\`\`\`ts\nconst started = performance.now();\nawait search({ q: "running shoes", limit: 20 });\nconsole.log(\`p95 sample: \${(performance.now() - started).toFixed(1)}ms\`);\n\`\`\``,
    );
  if (index % 11 === 5)
    parts.push(
      "| Stage | Before | After |\n| --- | --- | --- |\n| Decode | 41 ms | 18 ms |\n| Score | 12 ms | 11 ms |\n| Rerank | 27 ms | 22 ms |",
    );
  return parts.join("\n\n");
}

export function searchInvestigation(now: number, turns = 320): ScriptTurn[] {
  const r = random(7);
  let at = now - 40 * DAY_MS;
  return Array.from({ length: turns }, (_, index) => {
    at += r.next() < 0.15 ? r.between(10, 30) * HOUR_MS : r.between(3, 25) * MINUTE_MS;
    const subject = r.pick(searchSubjects);
    const ask = r.pick(searchAsks).replace("{s}", subject);
    const text =
      index % 37 === 9
        ? `${ask} See [the incident doc](https://example.com/incidents/${index}) for the timeline.`
        : ask;
    return { text, answer: searchAnswer(r, subject, index), at: Math.min(at, now - HOUR_MS) };
  });
}

const chapters = [
  "the lighthouse keeper's first night",
  "the storm that cut the island off",
  "Mara finding the ledger in the cellar",
  "the ferryman who never takes payment",
  "the argument over the broken lens",
  "the winter the lamp went dark",
  "Ines arriving with the mainland letters",
  "the drowned bell under the pier",
];
const craftAsks = [
  "Draft the opening paragraph for {c}.",
  "Tighten this scene about {c}. It drags in the middle.",
  "Give me three ways {c} could end.",
  "Make the dialogue in {c} sound less formal.",
  "What's the emotional beat of {c}?",
  "Rewrite {c} from Mara's point of view.",
  "Does {c} contradict anything earlier in the book?",
  "Suggest a chapter title for {c}.",
];
const prose = [
  "The lamp room smelled of kerosene and salt, and the glass hummed when the wind came round from the north.",
  "Mara counted the steps twice on the way down, as if the stairwell might have grown in the night.",
  "Nobody on the island said the ferryman's name aloud; they only nodded toward the water when he was late.",
  "Ines set the letters on the table without a word, and the oldest one was addressed to a man who had been dead for years.",
  "By the third night the storm had a rhythm, and the house learned to breathe with it.",
  "The ledger listed ships that had never reached the harbor, each with a small cross drawn in the margin.",
];

export function novelDraft(now: number, turns = 180): ScriptTurn[] {
  const r = random(23);
  let at = now - 21 * DAY_MS;
  return Array.from({ length: turns }, (_, index) => {
    at += r.next() < 0.2 ? r.between(8, 20) * HOUR_MS : r.between(2, 14) * MINUTE_MS;
    const chapter = r.pick(chapters);
    const text = r.pick(craftAsks).replace("{c}", chapter);
    const paragraphs = Array.from({ length: r.between(1, 4) }, () => r.pick(prose));
    const answer =
      index % 5 === 0
        ? `Here is a revision of ${chapter}.\n\n${paragraphs.map((line) => `> ${line}`).join("\n>\n")}`
        : `${paragraphs.join(" ")}\n\nThis keeps the focus on ${chapter} and leaves the reveal for later.`;
    return { text, answer, at: Math.min(at, now - HOUR_MS) };
  });
}

/** Replies whose final height depends on content that loads after the row mounts. */
function mediaAnswer(index: number): string {
  const nodes = 3 + (index % 5);
  const steps = Array.from(
    { length: nodes },
    (_, step) => `  S${step}[Step ${index}.${step}] --> S${step + 1}`,
  ).join("\n");
  const rows = Array.from(
    { length: 4 + (index % 7) },
    (_, row) => `| Run ${row} | ${index * 3 + row} ms | $x_{${row}}^2$ |`,
  ).join("\n");
  const blocks = [
    `| Run | Latency | Term |\n| --- | --- | --- |\n${rows}`,
    `![Chart ${index}](/fixture-image/900x${260 + (index % 6) * 70}-${index}.svg)`,
    `\`\`\`mermaid\nflowchart TD\n${steps}\n\`\`\``,
    `$$\n\\sum_{i=0}^{${index + 4}} \\frac{x_i^{${index}}}{i + ${index + 1}} = \\int_0^{${index + 1}} f(x)\\,dx\n$$`,
    `\`\`\`html-preview-file\nreport-${index}.html\n\`\`\``,
  ];
  const picked = Array.from(
    { length: 2 + (index % 3) },
    (_, offset) => blocks[(index + offset) % blocks.length]!,
  );
  return [`Results for run ${index}.`, ...picked, `That covers run ${index}.`].join("\n\n");
}

export function mediaReport(now: number, turns = 60): ScriptTurn[] {
  return Array.from({ length: turns }, (_, index) => ({
    text: `Report on run ${index}`,
    answer: mediaAnswer(index),
    at: now - (turns - index) * HOUR_MS,
  }));
}

export function tripPlanning(now: number): ScriptTurn[] {
  const steps: [string, string][] = [
    [
      "Plan a three-day trip to Lisbon in October.",
      "Day one in Alfama, day two in Belém, day three for Sintra.",
    ],
    ["Which day is best for Sintra?", "Go on a weekday. Pena Palace is quieter before 10:00."],
    [
      "How do I get there from the city?",
      "Take the train from Rossio. It runs every 20 minutes and takes 40 minutes.",
    ],
    [
      "Is the Lisboa Card worth it?",
      "Yes if you visit three or more museums. It also covers the Sintra train.",
    ],
    ["Where should we eat in Alfama?", "Try Taberna Sal Grosso for dinner. Book two days ahead."],
    ["Add a fado show to day one.", "Added Clube de Fado at 21:30 after dinner."],
    ["What should I pack?", "A light jacket, walking shoes with grip, and a small umbrella."],
    ["Will it rain much?", "October averages about eight rainy days, usually short showers."],
    ["Swap day two and day three.", "Done. Sintra is now day two and Belém day three."],
    [
      "Find a pastry shop near Belém.",
      "Pastéis de Belém is the obvious one. Go before 11:00 to skip the line.",
    ],
    [
      "How much cash should we bring?",
      "About €60 each for small cafés and the tram. Cards work almost everywhere else.",
    ],
    [
      "Can we fit in a day trip to Cascais?",
      "Only if you drop Belém. The train from Cais do Sodré takes 40 minutes.",
    ],
    [
      "Keep Belém. Summarize the final plan.",
      "Day one Alfama and fado, day two Sintra, day three Belém and the riverside.",
    ],
    [
      "Send me the train times for Sintra.",
      "Trains leave Rossio at :08, :28, and :48 past each hour from 06:00.",
    ],
    [
      "What's the best viewpoint at sunset?",
      "Miradouro da Senhora do Monte faces west and is less crowded than Santa Luzia.",
    ],
    ["Thanks, that's everything.", "Have a great trip."],
  ];
  return steps.map(([text, answer], index) => ({
    text,
    answer,
    at: now - 5 * DAY_MS + index * 9 * MINUTE_MS,
  }));
}

const dmOpeners: [string, string][] = [
  [
    "What's a quick dinner with leftover rice and eggs?",
    "Fried rice. Scramble the eggs first, then add cold rice, soy sauce, and scallions.",
  ],
  [
    "Remind me how the 4% rule works.",
    "Withdraw 4% of your portfolio in year one, then adjust that amount for inflation each year.",
  ],
  ["Translate 'see you at the station' into Japanese.", "駅で会いましょう (eki de aimashō)."],
  [
    "How long should I rest steak after grilling?",
    "About five minutes for a 2 cm steak. Tent it loosely with foil.",
  ],
  [
    "Help me reply to Sam about rescheduling.",
    "Hi Sam, Thursday doesn't work anymore. Could we move to Friday at the same time?",
  ],
  [
    "What's the difference between git rebase and merge?",
    "Rebase replays your commits on a new base for a linear history. Merge keeps both histories with a merge commit.",
  ],
  [
    "Add oat milk and lemons to my shopping list.",
    "Added oat milk and lemons. The list has seven items now.",
  ],
  [
    "How often should I feed a sourdough starter?",
    "Once a day at room temperature, or once a week if it lives in the fridge.",
  ],
  [
    "Summarize the article I sent this morning.",
    "It argues that small, frequent releases reduce incident severity, using three case studies from payments teams.",
  ],
  ["What time is sunset tomorrow?", "Sunset is at 17:42 tomorrow."],
  [
    "Explain compound interest with a quick example.",
    "€1,000 at 5% grows to €1,050 in year one and €1,102.50 in year two, because interest earns interest.",
  ],
  [
    "Suggest a book like Piranesi.",
    "Try The Starless Sea by Erin Morgenstern. It has the same dreamlike, labyrinthine feel.",
  ],
  [
    "Is it safe to run the dishwasher overnight?",
    "Generally yes, but many fire services recommend running appliances while you're awake.",
  ],
  [
    "Draft a birthday message for my sister.",
    "Happy birthday! Thanks for always being the first person I call. Dinner's on me this weekend.",
  ],
  ["How do I convert 350°F to Celsius?", "350°F is about 177°C. Most recipes round it to 180°C."],
  [
    "Why is my basil wilting?",
    "Usually too little water or too much afternoon sun. Water at the base and move it to morning light.",
  ],
  [
    "What's a good stretch for a stiff lower back?",
    "Try the knees-to-chest stretch: lie on your back and hug both knees for 30 seconds.",
  ],
  [
    "Remind me what we decided about the bike.",
    "You decided to service the old bike this spring and revisit buying a new one in the fall.",
  ],
];
const dmFollowUps: [string, string][] = [
  ["Can you make that shorter?", "Sure, here's the short version."],
  [
    "What about a vegetarian option?",
    "Swap the meat for firm tofu and add a splash of rice vinegar.",
  ],
  ["Thanks!", "Anytime."],
  ["Remind me about this tomorrow at 9.", "I'll remind you tomorrow at 09:00."],
  ["Is there a cheaper way?", "Buy in bulk or check the weekly market on Saturday."],
  [
    "Explain that like I'm new to it.",
    "Think of it as a recipe: the same steps, in the same order, every time.",
  ],
  ["And how long does that take?", "About twenty minutes start to finish."],
  [
    "Could you put that in a table?",
    "| Item | Amount |\n| --- | --- |\n| Rice | 2 cups |\n| Eggs | 3 |",
  ],
  ["Does that change if it's raining?", "Only slightly. Allow ten extra minutes for travel."],
  ["Save that to my notes.", "Saved to your notes under today's date."],
  [
    "What did you mean by the second point?",
    "I meant that the order matters more than the exact amounts.",
  ],
  ["Give me two alternatives.", "Option one is quicker, option two is cheaper. Both work."],
];

/**
 * DM context windows reaching back four months. Each window ends more than the default two-hour
 * context gap before the next one starts.
 */
export function directMessageHistory(now: number, until: number, windows = 75): ScriptTurn[][] {
  const r = random(41);
  const span = until - now + 120 * DAY_MS;
  const starts = Array.from(
    { length: windows },
    (_, index) => now - 120 * DAY_MS + Math.floor((span / windows) * (index + r.next() * 0.6)),
  );
  return starts.map((start, index) => {
    const [text, answer] = dmOpeners[(index * 7) % dmOpeners.length]!;
    const length = r.next() < 0.25 ? r.between(8, 18) : r.between(1, 6);
    let at = start;
    return [
      { text, answer, at },
      ...Array.from({ length: length - 1 }, () => {
        at += r.between(1, 12) * MINUTE_MS;
        const [follow, reply] = r.pick(dmFollowUps);
        return { text: follow, answer: reply, at };
      }),
    ];
  });
}
