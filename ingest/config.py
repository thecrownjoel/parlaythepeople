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

# Race history retention. HISTORY_KEEP_ALL keeps every 10-minute point forever (the record the
# forecasting model and AI analyst are built on). If storage ever needs trimming, set it to False:
# every point is kept for HISTORY_FULL_DAYS, then one per hour until HISTORY_HOURLY_DAYS, then one
# per day. Election weeks always keep every point. (archive.py also stores a full snapshot of every
# contract each run in R2, so trimming D1 never loses data.)
HISTORY_KEEP_ALL = True
HISTORY_FULL_DAYS = 7
HISTORY_HOURLY_DAYS = 90

# Live site, used to skip races whose odds haven't changed since the last run.
SITE_URL = "https://parlaythepeople.com"

# A pull is treated as failed (and not published) when either exchange returns fewer open events than
# this. It checks the exchanges answered, not how many races the next cycle has: right after an election,
# the finished cycle's markets close and the following cycle starts small (2028 had 45 races in Oct 2026).
MIN_KALSHI_EVENTS = 200
MIN_POLYMARKET_EVENTS = 50

# Election rollover: for this many days after a cycle's Election Day the site stays on that cycle
# (index.phase = "results") while the exchanges settle and results are recorded every run; then the
# next cycle with races becomes the site's focus on its own (index.phase = "campaign").
RESULTS_WINDOW_DAYS = 10
# The site leads with the next cycle that has at least this many races (off-year cycles with a handful of
# governor races keep their own pages but don't take over the homepage).
MIN_FOCUS_RACES = 20

# Person-only markets where neither exchange tags a party. Keyed by race id.
PARTY_HINTS = {
    "2026-senate-alaska": {"peltola": "D", "sullivan": "R"},
}

# LunarCrush social data ("The Pulse"). Candidates are taken from the race data automatically:
# every Senate and governor candidate, House candidates in competitive races (leader below
# SOCIAL_HOUSE_MAX_LEAD), and the top presidential contenders. Fetched about once an hour.
SOCIAL_HOUSE_MAX_LEAD = 0.80
SOCIAL_PRES_TOP = 12
SOCIAL_EXTRA_TOPICS = ["midterms", "white house", "donald trump", "republicans", "democrats", "congress", "senate", "polymarket", "kalshi"]
SOCIAL_POSTS_PER_TOPIC = 4

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
