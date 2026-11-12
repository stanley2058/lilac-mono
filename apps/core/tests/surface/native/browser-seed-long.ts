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

/** Long-form replies for checking reading comfort in normal threads and DMs. */
export const longArticles: [string, string][] = [
  [
    "Write me a long guide to running a blameless postmortem.",
    `# Running a blameless postmortem

A postmortem is the meeting and document a team produces after an incident. Its purpose is to understand how the system, including the people who operate it, produced an outcome nobody wanted. A blameless postmortem starts from the assumption that everyone involved acted reasonably given what they knew at the time. That assumption is not politeness. It is a practical choice: people who expect blame hide details, and the details are where the lessons live.

This guide covers what to do before the meeting, how to run it, what the written record should contain, and how to make sure the follow-up work actually happens.

## Before the meeting

Start the document while memories are fresh. Ideally the incident commander or a designated scribe opens it within a day of resolution. The first draft does not need analysis. It needs a timeline.

Build the timeline from evidence rather than recollection wherever you can. Chat logs, alert history, deploy records, dashboards, and pager acknowledgements all carry timestamps. Recollection fills the gaps between those records, and it is useful there, but it drifts quickly. Two engineers who were on the same call will remember the order of events differently within a week.

For each entry, record three things:

- **What happened**, in plain language.
- **What the people involved knew** at that moment, including what they could see on their screens.
- **What they decided to do**, and why that seemed sensible.

The second item is the one most teams skip, and it is the most valuable. When an engineer restarted the wrong service, the useful question is not why they made a mistake. It is what the dashboard showed them that made the wrong service look like the right one.

Invite the people who were involved, the owners of the affected systems, and anyone who will have to carry out follow-up work. Keep the group small enough that everyone can speak. Eight people is usually the upper limit for a productive discussion.

## Running the meeting

Open by restating the ground rules. The facilitator should say out loud that the goal is to understand the system, that nobody is being evaluated, and that hindsight makes every decision look more obvious than it was. Saying this feels redundant to experienced teams. Say it anyway, because new members are listening for whether it is true.

Walk through the timeline in order. At each decision point, ask the person who made it to describe what they saw. Resist the urge to jump ahead to the root cause. Incidents rarely have a single root cause, and teams that hunt for one tend to stop at the first plausible answer, which is often a person.

Useful questions keep the discussion on conditions rather than conduct:

1. What information was available at this point, and where was it?
2. What would have needed to be true for a different action to look correct?
3. Has this situation happened before, and what did we do then?
4. Which safeguards were expected to catch this, and why did they not?
5. What surprised you?

The last question is often the most productive. Surprise marks the gap between the system people believe they operate and the one they actually operate. Every surprise is a candidate for a fix, a document, or an alert.

Watch for counterfactual language. Phrases like "should have" and "failed to" describe a world that did not happen and quietly assign fault. When they appear, the facilitator can redirect gently: "What made the other path harder to see?" This keeps the conversation honest without lecturing anyone.

Keep track of time. A one-hour meeting is enough for most incidents. If the discussion runs long, schedule a second session rather than rushing the end, because the end is where action items are decided.

## What the document should contain

The finished document is read far more often than the meeting is remembered. Write it for an engineer who joins the team next year and wants to know why a strange-looking safeguard exists.

A good structure looks like this:

| Section | Contents |
| --- | --- |
| Summary | Two or three sentences on what happened and the impact |
| Impact | Who was affected, for how long, and how badly |
| Timeline | The evidence-based sequence of events |
| Contributing factors | The conditions that made the incident possible |
| What went well | Detection, response, and recovery that worked |
| Action items | Owned, dated tasks with a clear definition of done |

The "what went well" section is not decoration. Teams that only record failures gradually lose track of the practices that keep incidents short. If the on-call engineer found the problem in four minutes because a runbook was current, write that down, so the runbook stays current.

Use specific numbers. "Some users saw errors" tells a future reader nothing. "About 4% of checkout requests returned 500 errors for 37 minutes" tells them the scale and lets them compare incidents over time.

## Action items that survive

The most common way postmortems fail is quiet: the meeting goes well, the document is thorough, and the action items never ship. Three habits prevent this.

First, give every action item exactly one owner. Shared ownership means no ownership. The owner does not have to do the work personally, but they are responsible for it getting done or being explicitly dropped.

Second, prefer fewer, sharper items. Ten vague tasks like "improve monitoring" will sit in the backlog for a year. Two concrete tasks like "alert when queue depth exceeds 10,000 for five minutes" will ship next sprint.

Third, review open items on a schedule. A short monthly review of every postmortem action item older than thirty days keeps the list honest. Items that no longer make sense should be closed with a note explaining why. That note is useful history too.

## A note on culture

Blamelessness does not mean nobody is accountable. People are still responsible for doing their jobs well. The distinction is that accountability means explaining what happened and helping fix it, while blame means being punished for an outcome. Teams that confuse the two get shorter postmortems and longer incidents.

The best signal that the practice is working is who volunteers information. When engineers start a postmortem by saying "I made the change that triggered this, and here is what I was thinking," the team has built enough trust to learn from its failures. That trust takes months to build and one careless meeting to lose, so protect it.`,
  ],
  [
    "Explain how DNS resolution works, in depth.",
    `# How DNS resolution works

Every time you type a hostname into a browser, something has to turn that name into an address a network can route to. The Domain Name System does that job. It is one of the oldest pieces of internet infrastructure still in daily use, and it works well enough that most people never think about it until it breaks.

This explanation follows a single lookup from start to finish, then covers caching, record types, and the failure modes that cause most real-world DNS trouble.

## The players

A lookup involves several kinds of servers, each with a narrow job.

The **stub resolver** lives on your machine. It is usually part of the operating system, and it does very little on its own. It takes a question like "what is the address of \`docs.example.com\`?", sends it to a configured recursive resolver, and waits for an answer.

The **recursive resolver** does the real work. Your internet provider runs one, and public ones are operated by several large companies. It accepts questions from stub resolvers, finds the answers by asking other servers, and caches what it learns.

The **authoritative servers** hold the actual records. Each zone in the DNS hierarchy has authoritative servers that can answer definitively for names inside it. They do not go looking for answers elsewhere. They either know or they say the name does not exist.

## Following one lookup

Suppose the recursive resolver has just started and its cache is empty. A client asks for \`docs.example.com\`.

The resolver begins at the top of the hierarchy. It ships with a list of root server addresses, called root hints, so it can always start somewhere. It asks a root server about \`docs.example.com\`. The root server does not know the answer, but it knows who handles \`.com\`, so it replies with a referral: a list of the \`.com\` name servers.

The resolver asks one of the \`.com\` servers the same question. That server also does not know the final answer, but it knows which name servers are authoritative for \`example.com\`, so it returns another referral.

The resolver then asks an \`example.com\` name server. This server is authoritative for the zone, so it returns the record the client wanted, or a definitive statement that the name does not exist.

The resolver hands the answer back to the stub resolver, which hands it to the application. The browser can now open a connection.

\`\`\`text
client      -> recursive resolver : docs.example.com A?
resolver    -> root server        : docs.example.com A?
root        -> resolver           : ask the .com servers
resolver    -> .com server        : docs.example.com A?
.com        -> resolver           : ask ns1.example.com
resolver    -> ns1.example.com    : docs.example.com A?
ns1         -> resolver           : 203.0.113.42
resolver    -> client             : 203.0.113.42
\`\`\`

That is a lot of round trips for one address. In practice almost nobody pays that cost, because of caching.

## Caching and time to live

Every DNS record carries a time to live, or TTL, measured in seconds. It tells resolvers how long they may keep the record before asking again. A TTL of 300 means a resolver can reuse the answer for five minutes.

Caching happens at every layer. The recursive resolver caches the final answer, and it also caches the referrals it collected along the way. After one lookup for \`docs.example.com\`, it already knows the \`.com\` servers and the \`example.com\` servers. A later lookup for \`api.example.com\` can skip straight to the authoritative server. Operating systems and browsers keep small caches of their own, so a repeated lookup often never leaves your machine.

Choosing a TTL is a tradeoff. Long TTLs reduce load and make lookups fast, but changes take a long time to reach everyone. Short TTLs let you move traffic quickly, but every expiration costs another query. A common approach is to keep TTLs moderate during normal operation and lower them a day or two before a planned migration, so the switch propagates quickly when it happens.

## Common record types

Most day-to-day DNS work involves a handful of record types.

| Type | Holds | Typical use |
| --- | --- | --- |
| \`A\` | An IPv4 address | Pointing a name at a server |
| \`AAAA\` | An IPv6 address | The same, for IPv6 |
| \`CNAME\` | Another name | Aliasing one name to another |
| \`MX\` | A mail server and priority | Routing email for a domain |
| \`TXT\` | Arbitrary text | Domain verification, email policy |
| \`NS\` | A name server | Delegating a zone |

A \`CNAME\` deserves special mention because it causes frequent confusion. It says "this name is an alias; go look up that other name instead." The resolver follows the chain and returns the final address. A name with a \`CNAME\` cannot hold other records, which is why you usually cannot put one at the apex of a domain, where \`NS\` and other records must live.

## When things go wrong

Most DNS incidents fall into a few patterns.

**Stale caches.** Someone changes a record, but clients keep using the old value until the TTL expires. If the old TTL was a day, the change takes up to a day to reach everyone, no matter how quickly the new record was published. The fix is planning: lower the TTL well before the change.

**Negative caching.** When a name does not exist, resolvers cache that fact too, for a duration set by the zone. If a service queries a name before it is created, it may keep getting "does not exist" for a while after the record appears. This often surprises teams that create records and immediately test them.

**Broken delegation.** The parent zone lists name servers for a child zone. If those name servers stop answering, or the parent lists servers that were decommissioned, lookups fail even though the records themselves are fine. Checking delegation with a tool like \`dig +trace\` shows each step of the walk and usually reveals where it breaks.

**Resolver outages.** If the recursive resolver a machine depends on becomes unavailable, every lookup fails at once, and the symptoms look like a total network outage. Configuring more than one resolver reduces the risk, as long as both are not behind the same failure point.

## Closing thoughts

DNS is a distributed, cached, eventually consistent database that the entire internet depends on. Most of its surprises come from that last property. Once you think of every change as something that propagates over time rather than something that happens at once, DNS behavior becomes much easier to predict.`,
  ],
  [
    "How should I take care of a cast-iron pan? Go into detail.",
    `# Caring for a cast-iron pan

A cast-iron pan is one of the few kitchen tools that improves with use. With reasonable care it will outlast the person who bought it. The care is not complicated, but it runs against habits most people learned from stainless steel and nonstick pans, so it helps to understand why each step matters.

## What seasoning is

Bare cast iron is porous and rusts easily. Seasoning is a thin layer of oil that has been heated until it polymerizes, turning from a liquid into a hard, slick coating bonded to the metal. That coating protects the iron from moisture and gives the pan its nonstick behavior.

Seasoning is built up in layers. Each time you cook with oil at high heat, a little more polymerizes onto the surface. This is why a well-used pan looks dark and glossy while a new one can look dull and grey. The pan is not getting dirtier. It is getting better protected.

## Cleaning after cooking

The old rule that you must never use soap on cast iron comes from a time when soaps contained lye, which can strip seasoning. Modern dish soap is mild, and a small amount will not hurt a properly seasoned pan. What does hurt it is soaking.

A good routine looks like this:

1. Clean the pan while it is still warm, since food releases more easily.
2. Rinse with hot water and scrub with a brush or a non-scratch sponge. Use a little soap if the pan is greasy.
3. For stuck food, scrub with coarse salt and a splash of water, which acts as a gentle abrasive.
4. Dry the pan immediately and completely with a towel.
5. Set it on a burner over low heat for a minute or two to drive off remaining moisture.
6. While it is warm, wipe a very thin layer of oil over the cooking surface with a paper towel.

The final step is where people most often go wrong. The layer should be so thin that the pan looks almost dry. Excess oil does not polymerize properly. It turns sticky and can go rancid in storage.

## What to avoid

A few habits do real damage.

- **Soaking.** Leaving the pan in a sink of water is the fastest way to get rust.
- **The dishwasher.** The long hot cycle and harsh detergent will strip seasoning and leave the pan rusty.
- **Storing it wet.** Even a thin film of water can cause rust spots overnight.
- **Long simmers of acidic food early on.** Tomato sauce or wine simmered for an hour can wear away young seasoning. A well-established pan handles acidic food better, and a quick deglaze is fine at any stage.

None of these mistakes are permanent. They just mean extra work to restore the surface.

## Fixing rust and sticky spots

If a pan develops rust, scrub the rusty area with steel wool until you reach bare metal, wash it, dry it thoroughly, and re-season it. Small spots can be fixed on the stovetop. A pan with widespread rust benefits from a full oven seasoning.

To season in the oven, coat the entire pan, inside and out, with a very thin layer of a neutral oil with a high smoke point. Wipe it off as though you made a mistake, leaving only what clings to the surface. Place the pan upside down in an oven at around 230 to 260 °C for an hour, with a sheet of foil on a lower rack to catch drips. Let it cool in the oven. Repeating this three or four times builds a durable base layer.

Sticky patches mean oil was applied too thickly and did not fully polymerize. Heating the pan in the oven at high temperature for an hour usually finishes the job. If not, scrub the sticky area and start that spot again with a thinner coat.

## Cooking to build seasoning

The easiest way to maintain a pan is to cook in it often. Searing, shallow frying, and roasting vegetables with oil all add to the seasoning. Eggs and delicate fish are harder on a young pan, so it can help to save them until the surface has had a few weeks of regular use.

Preheat the pan gradually. Cast iron heats unevenly at first, and putting a cold pan on a high flame can create hot spots or, in rare cases, crack the iron. Five minutes over medium heat gives an even, steady surface that holds its temperature when food goes in.

## Storage

Store the pan in a dry place. If you stack other pans on top of it, put a paper towel between them to protect the surface and absorb any humidity. Leaving the lid on a stored pan can trap moisture, so keep lids off or slightly ajar.

Taken together, the routine is short: cook with it, clean it while warm, dry it completely, and give it a light coat of oil. Done consistently, that is all a cast-iron pan needs to keep getting better for decades.`,
  ],
];
