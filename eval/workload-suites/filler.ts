/**
 * Template filler conversations: ordinary chat on everyday topics, written
 * without digits so seeded values (costs, codes, dates) stay unique tokens in
 * a history. Each topic has user turns and longer assistant turns; a session
 * samples a topic and a run of exchanges from it.
 */
import type { Rng } from '../generators/seeded.ts';
import type { ChatMessage } from './types.ts';

export interface FillerTopic { id: string; opener: string; user: readonly string[]; assistant: readonly string[] }

export const FILLER_TOPICS: readonly FillerTopic[] = [
  {
    id: 'trip-planning',
    opener: "I'm trying to plan a long weekend away and I keep going back and forth on the details.",
    user: [
      'Would it be better to drive or take the train if I want to arrive rested?',
      'I want at least one morning with nothing scheduled at all.',
      'Can you help me think about what to pack for weather that keeps changing?',
      "I'd like a mix of museums and walking, but not too much of either.",
      'Is it a bad idea to book the hotel before I know the exact plans?',
      'My partner wants to see a show and I would rather find a good bookstore.',
      'How early should I leave if I want to avoid the worst traffic?',
      'I always overpack. Help me be strict about it this time.',
      'What is a reasonable way to split the days so nobody gets bored?',
      'Should I bring a proper camera or just use my phone?',
    ],
    assistant: [
      'A train usually wins on rest: you can read, nap or look out the window, and you arrive without the fatigue of watching the road. Driving gives you flexibility for side trips, so the choice depends on whether you want freedom on the way or energy on arrival.',
      'Protecting one empty morning is a good instinct. Put it in the middle of the trip rather than the end, so it works as a reset instead of a rushed last day, and resist filling it when an idea comes up the night before.',
      'Layers work best for changeable weather: a light base, something warm you can tie around your waist, and a thin waterproof shell. Shoes matter more than anything else, so bring one comfortable pair you have already broken in.',
      'You could anchor each day with one indoor stop and let the walking happen between them. That keeps the pace relaxed and gives you somewhere to retreat if it rains.',
      'Booking early is usually fine if the room is refundable. It removes one source of stress, and you can still change plans once the rest of the trip takes shape.',
      'You could split the evening: an early show and a late browse, or the other way around. Many bookstores in busy neighborhoods stay open late, which makes this easier than it sounds.',
      'Leaving before the morning rush or after it has fully cleared usually helps the most. The middle of the rush is where most of the lost time comes from.',
      'A strict approach is to lay everything out, then put back a third of it. Plan outfits around a couple of colors so every piece works with every other one.',
      'Alternate a busy day with a gentle one, and let each person pick one thing that is non-negotiable. That keeps everyone invested without overloading anyone.',
      'If the camera is part of the fun for you, bring it. If it would feel like a chore to carry, your phone will capture the trip just fine.',
    ],
  },
  {
    id: 'spreadsheet',
    opener: 'Can you help me untangle a budgeting spreadsheet that has gotten out of hand?',
    user: [
      'I have too many tabs and I never know which one is the real one.',
      'Should I track categories monthly or just keep a running list?',
      'The formulas break every time I add a new row.',
      'I want a quick way to see whether I am over or under for the month.',
      'Is it worth separating fixed costs from things that vary?',
      'My partner and I share some expenses but not others. How do I show that?',
      'I keep forgetting to update it. Any tricks?',
      'Would a chart help, or is that overkill?',
    ],
    assistant: [
      'Pick one tab as the source of truth and turn the others into views that only read from it. Rename the main one clearly so there is never a question about where new entries go.',
      'A running list with a category column is easier to maintain, and you can summarize it by month with a pivot table. That gives you both views without double entry.',
      'Formatting the range as a table usually fixes that, because formulas then extend automatically to new rows. It also makes the references easier to read.',
      'A single summary cell that subtracts spending from the plan, with conditional formatting for color, gives you a glance-able answer without opening every tab.',
      'Yes. Fixed costs rarely need attention once they are set, so separating them lets you focus on the categories you can actually change.',
      'Add a column for who paid and another for how it is split. A small summary at the top can then show who owes whom without any manual math.',
      'Tie the update to something you already do, like a weekly coffee or a Sunday evening routine. Small and regular beats thorough and rare.',
      'A simple bar chart of categories against plan can help if you are a visual person. Keep it to one chart so it stays useful rather than decorative.',
    ],
  },
  {
    id: 'cooking',
    opener: 'I want to cook more at home but I get stuck on what to make during the week.',
    user: [
      'What are some dinners that are hard to mess up?',
      'I end up wasting vegetables because I buy too many.',
      'Is batch cooking on Sunday actually worth it?',
      'How do I make leftovers less boring?',
      'I like spicy food but my roommate does not.',
      'What should always be in the pantry?',
      'Any advice for cooking rice without it going mushy?',
      'I want to get better at seasoning without following recipes exactly.',
    ],
    assistant: [
      'Sheet pan dinners, simple stir fries and pasta with a quick sauce are very forgiving. They tolerate small timing mistakes and let you swap ingredients freely.',
      'Plan meals around two or three vegetables per week and buy only those. Choose ones that keep well, like cabbage, carrots and onions, as your backup.',
      'It helps most when you cook components rather than whole meals: a grain, a protein and a sauce you can combine differently through the week.',
      'Change the format: yesterday’s roast becomes today’s tacos or a grain bowl. A fresh topping like herbs, pickles or a squeeze of citrus also makes a big difference.',
      'Cook the base mild and keep the heat on the side: chili crisp, hot sauce or fresh chilies at the table let each person adjust their own plate.',
      'Good olive oil, canned tomatoes, a couple of dried pastas, rice, beans, stock, garlic, onions and a few spices cover a surprising number of meals.',
      'Rinse it first, use a measured amount of water, keep the lid on and let it rest off the heat before fluffing. Resting is the step most people skip.',
      'Taste as you go and adjust salt, acid and heat one at a time. Over time you learn what each one does, which is what lets you drift away from recipes.',
    ],
  },
  {
    id: 'workout',
    opener: 'I want to build a workout routine I will actually stick with.',
    user: [
      'I get bored doing the same thing every week.',
      'How do I fit strength training around a busy schedule?',
      'Is it bad to skip warmups when I am short on time?',
      'My knees complain when I run on pavement.',
      'Should I work out in the morning or the evening?',
      'How do I know if I am pushing too hard?',
      'I want something I can do at home without much equipment.',
    ],
    assistant: [
      'Rotate between a few formats on a cycle, for example strength, a longer easy cardio session and something playful like a class or a hike. Variety keeps it interesting without losing structure.',
      'Short full-body sessions a few times a week work well. Focus on compound movements like squats, pushes, pulls and hinges, which give a lot of benefit per minute.',
      'A short warmup is worth keeping even on busy days. A few minutes of easy movement lowers injury risk and usually makes the main work feel better.',
      'Softer surfaces like trails or a track can help, along with gradual increases in distance. Strengthening the hips and legs also takes load off the knees.',
      'The best time is the one you can protect consistently. Mornings avoid schedule creep; evenings often feel stronger. Try both for a couple of weeks and compare.',
      'Persistent soreness, poor sleep and dreading every session are signs to back off. You should finish most workouts feeling like you could have done a little more.',
      'Bodyweight circuits, a resistance band and a pair of adjustable dumbbells cover nearly everything you need at home.',
    ],
  },
  {
    id: 'job-search',
    opener: "I'm thinking about looking for a new role and I'm not sure where to start.",
    user: [
      'How do I describe my current work without underselling it?',
      'Is it worth reaching out to people I have not talked to in years?',
      'I am nervous about salary conversations.',
      'Should I apply widely or focus on a few places?',
      'How do I prepare for interviews without sounding rehearsed?',
      'I do not want my manager to find out yet.',
      'What questions should I ask the interviewer?',
    ],
    assistant: [
      'Lead with outcomes rather than tasks: what changed because of your work, who benefited and how. Concrete examples carry more weight than adjectives.',
      'Usually yes. A short, honest note that explains what you are exploring is welcome far more often than people expect, and it rarely feels awkward on the receiving end.',
      'Research ranges ahead of time and let them name a number first when you can. Framing it around the scope of the role keeps the conversation calm.',
      'A focused list tends to work better. Tailored applications to places you genuinely want get more responses than a broad, generic approach.',
      'Prepare a handful of stories and practice telling them out loud in different orders. That keeps the substance ready while the wording stays natural.',
      'Keep your search off work devices, schedule interviews around normal breaks and be selective about who you tell. Discretion is normal and expected.',
      'Ask what success looks like in the first months, how the team makes decisions and what the hardest part of the role is. The answers tell you a lot.',
    ],
  },
  {
    id: 'garden',
    opener: 'I want to get the garden into better shape this season.',
    user: [
      'Some of my plants look tired no matter what I do.',
      'How often should I water if the weather is unpredictable?',
      'Is it too late to plant anything new?',
      'Slugs keep getting to the lettuce.',
      'Should I bother with compost?',
      'I want something that flowers for a long time.',
    ],
    assistant: [
      'Check the soil first: tired plants often have compacted or depleted soil. Loosening it and adding organic matter helps more than extra fertilizer.',
      'Water deeply and less often, checking a finger’s depth of soil before you do. Morning watering reduces evaporation and disease.',
      'Usually not. Fast growers like herbs, salad greens and some annual flowers can still do well, especially if you start with young plants.',
      'Copper tape, beer traps and evening hand-picking all help. Encouraging birds and frogs also keeps numbers down over time.',
      'Compost is one of the best things you can do for soil structure, and a simple heap in a corner is enough to get started.',
      'Cosmos, salvia and many kinds of geranium flower for months, especially if you remove the faded blooms regularly.',
    ],
  },
  {
    id: 'reading-habit',
    opener: 'I used to read a lot and I want to get back into it.',
    user: [
      'I start books and never finish them.',
      'Should I read on paper or on a screen?',
      'How do I pick what to read next?',
      'I only have small pockets of time.',
      'Is it fine to read several books at once?',
      'I forget most of what I read.',
    ],
    assistant: [
      'Give yourself permission to drop books that are not working. Finishing becomes easier when every book you keep is one you want to read.',
      'Whichever you will actually pick up. Many people use paper at home and a phone or e-reader for commutes and waiting rooms.',
      'Keep a short list of things friends recommended, and alternate between something easy and something more demanding.',
      'Keep a book within reach in the places you already wait. Small pockets add up surprisingly fast over a few weeks.',
      'Absolutely. Different books suit different moods and times of day, and switching can keep momentum going.',
      'A few lines of notes after each session, or telling someone about the book, helps the ideas stick much better.',
    ],
  },
  {
    id: 'home-office',
    opener: 'My home office setup is making me miserable by the afternoon.',
    user: [
      'My back hurts after long calls.',
      'The light in the room is terrible in the evening.',
      'I get distracted by everything on my desk.',
      'Is a standing setup worth trying?',
      'Noise from the street is driving me up the wall.',
      'How do I separate work time from home time when it is the same room?',
    ],
    assistant: [
      'Check the chair height and screen position first: feet flat, screen at eye level and elbows close to your body. Standing up between calls also helps.',
      'Add a warm lamp behind or beside the screen rather than relying on an overhead light. It reduces glare and eye strain.',
      'Clear everything that is not part of the current task into a drawer or box. A clean surface makes it easier to start work.',
      'Many people like alternating rather than standing all day. Start with short periods and see how your body responds.',
      'Soft furnishings, a rug and heavy curtains absorb a lot of noise, and a fan or white noise can mask the rest.',
      'A small ritual at the start and end of the day helps: a walk, closing the laptop or changing the lighting can mark the boundary.',
    ],
  },
  {
    id: 'kids-schedule',
    opener: 'Our family calendar has become impossible to keep track of.',
    user: [
      'Everyone has their own activities and they overlap.',
      'Should we use a shared digital calendar or a paper one on the fridge?',
      'Mornings are chaos.',
      'How do we handle the weeks where nothing fits?',
      'The kids want more say in weekend plans.',
    ],
    assistant: [
      'A weekly planning chat on Sunday helps a lot: go through the week together and spot conflicts before they happen.',
      'Many families use both: a shared digital calendar for details and reminders, and a simple paper view on the fridge so everyone sees the week.',
      'Prepare as much as possible the night before: clothes, bags and lunches. A short checklist by the door keeps everyone on track.',
      'Decide early which activities can flex and which cannot. Carpools and swaps with other parents also relieve a lot of pressure.',
      'Let each child pick one weekend activity in rotation. It builds ownership and reduces arguments about what to do.',
    ],
  },
  {
    id: 'learning-language',
    opener: 'I want to learn a new language before a trip next year.',
    user: [
      'Apps feel like games but I am not sure I am learning.',
      'How much time should I spend each day?',
      'Speaking is the part that scares me.',
      'Should I focus on grammar or vocabulary first?',
      'I tried before and gave up after a few weeks.',
    ],
    assistant: [
      'Apps are good for habit and vocabulary, but pair them with listening and speaking practice so you can actually use the words.',
      'A small daily amount beats a long weekly session. Consistency builds memory far more effectively than cramming.',
      'Start by talking to yourself, then try short exchanges with a tutor or exchange partner. Mistakes are part of the process and everyone makes them.',
      'Start with the most common words and phrases you will actually need, and pick up grammar as patterns appear.',
      'Set a modest goal tied to the trip, like ordering food or asking for directions. Clear goals make it easier to keep going.',
    ],
  },
  {
    id: 'sleep',
    opener: "I've been sleeping badly and it's starting to affect everything.",
    user: [
      'I scroll on my phone in bed and know I should not.',
      'Is it bad to have coffee in the afternoon?',
      'I wake up in the middle of the night and cannot get back to sleep.',
      'Weekends throw off my whole schedule.',
      'Does the temperature of the room matter much?',
    ],
    assistant: [
      'Charging the phone outside the bedroom is one of the simplest changes with a big payoff. A paper book makes a good replacement habit.',
      'Caffeine lingers for hours, so an afternoon cup can affect sleep even if you fall asleep easily. Try cutting it off earlier for a couple of weeks.',
      'If you are awake for a while, get up and do something quiet in dim light until you feel sleepy again, rather than lying there frustrated.',
      'Keeping wake-up time roughly consistent, even on weekends, is one of the most effective ways to stabilize sleep.',
      'Yes. A cool, dark and quiet room helps most people sleep more deeply.',
    ],
  },
  {
    id: 'moving',
    opener: "We're moving soon and I want the packing to go smoothly this time.",
    user: [
      'Where do I even start?',
      'How do I decide what to get rid of?',
      'Should we hire movers or do it ourselves?',
      'I always lose the important papers during a move.',
      'How do we make the first night in the new place less miserable?',
    ],
    assistant: [
      'Start with the rooms you use least, like storage areas and guest rooms, and leave the kitchen and bedrooms for last.',
      'If you have not used something in a long time and would not buy it again, it is probably a good candidate to donate or sell.',
      'Movers save time and backs; doing it yourself saves money. Many people split it: pack themselves and hire help for the heavy lifting.',
      'Put important documents in one clearly labeled folder that travels with you, not in the truck.',
      'Pack a first-night box with sheets, towels, chargers, toiletries, snacks and a kettle. Opening it first makes the new place feel livable right away.',
    ],
  },
];

/**
 * One filler session: one or two topics, each opened with its opener and
 * followed by up to `pairs` distinct user/assistant exchanges (never more than
 * the topic has, so a session does not repeat itself).
 */
export function fillerSession(rng: Rng, pairs: number, topics = 1): ChatMessage[] {
  const chosen = rng.shuffle(FILLER_TOPICS).slice(0, topics);
  const messages: ChatMessage[] = [];
  for (const topic of chosen) {
    const order = rng.shuffle(topic.user.map((_, i) => i)).slice(0, Math.min(pairs, topic.user.length));
    order.forEach((k, i) => {
      messages.push({ role: 'user', content: i === 0 ? `${topic.opener} ${topic.user[k]}` : topic.user[k]! });
      messages.push({ role: 'assistant', content: topic.assistant[k]! });
    });
  }
  return messages;
}
