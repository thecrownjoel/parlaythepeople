"""What Parlay the People collects. Edit this file to follow new kinds of markets.

Cycles are not listed here: a market's election year is read from the market itself,
so 2030, 2032 and later cycles appear on their own once the exchanges list them.
"""

# Polymarket tags to scan. Each tag is paged through in full on every run.
POLYMARKET_TAGS = ["midterms", "us-presidential-election"]

# Kalshi categories to scan (every open event in these categories is classified).
KALSHI_CATEGORIES = {"Elections", "Politics"}

# Election Day for each cycle we know about; later cycles fall back to the rule
# "Tuesday after the first Monday in November".
ELECTION_DAYS = {2026: "2026-11-03", 2028: "2028-11-07"}

# Race history: keep every 10-minute point for this many days, then one per hour.
HISTORY_FULL_DAYS = 7

# A build that finds less than this for the next upcoming cycle is treated as a
# failed pull and is not published.
MIN_RACES_NEXT_CYCLE = 50

# Person-only markets where neither exchange tags a party. Keyed by race id.
PARTY_HINTS = {
    "2026-senate-alaska": {"peltola": "D", "sullivan": "R"},
}
