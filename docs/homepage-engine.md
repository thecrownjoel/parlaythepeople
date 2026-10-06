# The homepage engine: a front page that follows the calendar

Status: approved 2026-10-06. Decisions: the site becomes "the U.S. government, with the odds" (markets as the spine of every hub); election night switches automatically (editor can override); the Pentagon / national-security hub comes right after Congress. Phase 1 in progress.

## The problem

Today's homepage is a midterm dashboard: control odds, the closest races, the money map. On November 4 most of it goes stale, and the site has to cover politics and the whole U.S. government (Congress, the White House, the Pentagon and national security, the courts and the agencies) between elections. The front page needs to change with the calendar, and to react on its own to big moments, without someone rebuilding it each time.

## How it works

The front page is built from two things:

1. **The season.** A function of the date and the election calendar says what period we're in. Each season has a lead (the hero at the top) and an ordered list of modules.
2. **Moments.** Time-boxed takeovers that sit on top of the season: election night, a shutdown deadline, a Supreme Court decision day, a debate, a market shock. They come from the calendar, from the newsroom's signals (automatically), or from the editor (pinned in the admin).

```
season(date)  ──►  lead + modules, in order
moments(now)  ──►  hero override, banner, or a module pushed to the top
editor pins   ──►  win over both
```

Every module (the existing sections plus new ones) declares when it's relevant and how much, so a season is mostly a weighting, not a separate page. The same modules appear on the topic hub pages (below), so building one gives us two places it shows up.

## The seasons, 2026–2028

| Season | When | Lead | Top modules |
| --- | --- | --- | --- |
| Midterm stretch | now → Nov 3, 2026 | Control of Congress, days to go | Closest races, movers, money, forecasters vs. markets, polls |
| **Election night** | Nov 3, 6pm ET → most races called | Live results board (`/results/2026/` exists) | Calls as they come, market odds live, Senate/House tally |
| Count and aftermath | Nov 4 → mid-Dec | Who won and what changed | Uncalled races, Georgia runoff (Dec 1), recounts, how the markets and the forecasters did (track record) |
| Transition | mid-Dec → Jan 20 | The new Congress | Leadership elections, new members, committee seats, first bills |
| **Governing** | 2027 (most of the time) | "This week in Washington" | Congress (bills moving, votes), White House (executive orders), Pentagon and national security, courts, agencies, politics markets, the 2027 governor races (VA, NJ), 2028 early odds |
| 2028 primaries | late 2027 → June 2028 | The nomination race | Primary calendar, delegate math, nomination markets, debates |
| 2028 general | July → Nov 2028 | Who wins the presidency | Conventions, electoral map, Senate/House again |

## Moments (examples)

| Moment | Comes from | What happens |
| --- | --- | --- |
| Election night, primary nights | Calendar | Results board takes the hero |
| Government shutdown / debt limit deadline | Calendar + Congress.gov bills + markets | Countdown banner, the bills and the odds of a shutdown |
| State of the Union, debates | Calendar | Hero with live market moves |
| Supreme Court decision days (June) | Calendar + court opinions | Decisions as they land, related markets |
| Market shock (control of Congress flips, a war/ceasefire market jumps) | Newsroom signals | Hero for 24 hours, with the story the newsroom writes |
| Breaking national-security news | News volume + markets + Pentagon releases | Banner and a module at the top |
| Editor pin | Admin | Anything, for a set time |

## Covering the whole government (free sources only)

Each area gets a hub page that updates itself daily. That's where the search traffic is ("Pentagon budget 2027", "NDAA", "executive orders this week"), and the homepage modules draw from the hubs.

| Hub | Free sources | Notes |
| --- | --- | --- |
| `/congress/` | Congress.gov (live now: members, bills), House roll-call votes | Built on what shipped today |
| `/pentagon/` (national security) | defense.gov news releases and daily contract announcements (RSS), DSCA arms-sale notices, NDAA and defense appropriations bills (Congress.gov), war and ceasefire markets | The biggest new beat |
| `/white-house/` | Federal Register API (executive orders, proclamations; no key), White House releases | Executive orders tracker |
| `/courts/` | Supreme Court opinions and calendar, court-related markets | Decision days are moments |
| `/agencies/` | Federal Register rules, USAspending.gov API, GAO and CBO reports | Rules and spending |
| `/politics/` | Kalshi and Polymarket politics markets (exists) | Stays the market spine |

The newsroom gets new beats to match (national security and the Pentagon, the White House, courts, agencies), with new tools on these sources, and hires writers for them from the admin.

## Build plan

1. **Before Nov 3 (time-critical).** The engine: season resolver, module registry, moments, and an editor "Homepage" page in the Newsroom admin (pin a moment, preview any date). Election-night and aftermath seasons fully built and tested by previewing those dates.
2. **November.** `/congress/` and `/pentagon/` hubs; national-security newsroom beat and tools.
3. **December.** Transition season; `/white-house/` and `/courts/` hubs.
4. **January.** The governing season goes live as the default; `/agencies/`.
5. **Late 2027.** The 2028 primary season.

## Decisions for the owner

- Positioning: does the site stay "election odds" with government coverage added, or become "the U.S. government, with the odds"? (affects the name line, the homepage lead and titles)
- Election night: switch automatically at the first poll close, or wait for the editor?
- Hub order after Congress: Pentagon first (recommended), then White House, courts, agencies?
- Markets as the spine of every hub (recommended): each hub leads with the Kalshi and Polymarket markets on its topic, which is what no other government site has.
