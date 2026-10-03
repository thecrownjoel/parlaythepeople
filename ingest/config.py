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

# Race history retention: every 10-minute point for HISTORY_FULL_DAYS, then one per hour until
# HISTORY_HOURLY_DAYS, then one per day forever. Election weeks keep every point forever.
HISTORY_FULL_DAYS = 7
HISTORY_HOURLY_DAYS = 90

# Live site, used to skip races whose odds haven't changed since the last run.
SITE_URL = "https://parlaythepeople.com"

# A build that finds less than this for the next upcoming cycle is treated as a
# failed pull and is not published.
MIN_RACES_NEXT_CYCLE = 50

# Person-only markets where neither exchange tags a party. Keyed by race id.
PARTY_HINTS = {
    "2026-senate-alaska": {"peltola": "D", "sullivan": "R"},
}

# Headlines for the homepage "Latest" strip, from Google News search feeds (free, no key).
# (label, search query, how many headlines to take). Edit the queries or counts to change the mix.
NEWS_QUERIES = [
    ("White House", '"White House"', 6),
    ("GOP", 'Republicans Congress OR "GOP" OR "Senate Republicans"', 5),
    ("Administration", '"Trump administration"', 4),
    ("Midterms", '"2026 midterms" OR "midterm elections"', 3),
    ("Democrats", '"Democrats" Congress', 2),
]
NEWS_MAX_AGE_HOURS = 48
