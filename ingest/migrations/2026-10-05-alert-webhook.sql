-- Run once on parlay-accounts: alerts can also go to a Slack (or Discord, or any JSON) webhook.
ALTER TABLE alert_prefs ADD COLUMN webhook TEXT;
