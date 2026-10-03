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

# Headlines for the homepage "Latest" strip. All free: publishers' own RSS feeds plus Google News
# search feeds. Each entry takes up to N headlines per refresh, so N sets the mix. Feeds marked
# political=False carry other news too and are filtered to politics keywords.
NEWS_FEEDS = [
    # (label shown, feed url, headlines per refresh, already politics-only?)
    ("The White House", "https://www.whitehouse.gov/news/feed/", 4, True),
    ("Fox News", "https://moxie.foxnews.com/google-publisher/politics.xml", 4, True),
    ("New York Post", "https://nypost.com/politics/feed/", 3, True),
    ("Washington Examiner", "https://www.washingtonexaminer.com/feed/", 3, False),
    ("Daily Caller", "https://dailycaller.com/feed/", 2, False),
    ("National Review", "https://www.nationalreview.com/feed/", 2, False),
    ("Washington Free Beacon", "https://freebeacon.com/feed/", 1, False),
    ("The Federalist", "https://thefederalist.com/feed/", 1, False),
    ("RealClearPolitics", "https://www.realclearpolitics.com/index.xml", 1, False),
]
# Google News searches round out the mix (midterm coverage and some Democratic news for balance)
NEWS_QUERIES = [
    ("Midterms", '"2026 midterms" OR "midterm elections"', 3),
    ("GOP", '"Senate Republicans" OR "House Republicans"', 2),
    ("Democrats", '"Democrats" Congress', 1),
]
NEWS_MAX_AGE_HOURS = 48
NEWS_POLITICS_WORDS = ["trump", "vance", "white house", "congress", "senate", "house", "gop", "republican", "democrat", "election",
                       "midterm", "governor", "campaign", "poll", "vote", "voter", "administration", "supreme court", "biden",
                       "harris", "newsom", "president", "lawmaker", "speaker", "ballot", "primary", "pelosi", "schumer", "thune", "johnson"]
