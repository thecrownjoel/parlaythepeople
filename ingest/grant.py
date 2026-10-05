#!/usr/bin/env python3
"""Grant a plan by hand (until billing is connected): creates the account if the email hasn't signed in yet.

  python3 ingest/grant.py joel@example.com pro "founder: lifetime Pro, no charge"
  python3 ingest/grant.py joel@example.com free            # end a grant
  python3 ingest/grant.py owner@campaign.org team "pilot" --org "Smith for Senate"   # a team: the owner adds members at /account/team/

The plan renews monthly on its own (the AI allowance resets each 30 days from today) and stays until changed.
"""
import json
import os
import secrets
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
WR = ["npx", "--yes", "wrangler@4"]
PLANS = {"free", "pro", "team", "enterprise"}
SEATS = {"team": 5, "enterprise": 25}


def d1(sql):
    r = subprocess.run(WR + ["d1", "execute", "parlay-accounts", "--remote", "--json", "--command", sql],
                       capture_output=True, text=True, cwd=os.path.dirname(HERE))
    try:
        return json.loads(r.stdout)[-1]["results"]
    except Exception:
        sys.exit(f"d1 failed: {(r.stderr or r.stdout)[-400:]}")


def q(s):
    return "'" + str(s).replace("'", "''") + "'"


def main():
    if len(sys.argv) < 3 or sys.argv[2] not in PLANS:
        sys.exit(__doc__)
    email, plan = sys.argv[1].strip().lower(), sys.argv[2]
    args = [a for a in sys.argv[3:]]
    org_name = None
    if "--org" in args:
        i = args.index("--org")
        org_name = args[i + 1] if i + 1 < len(args) else None
        del args[i:i + 2]
    note = args[0] if args else "granted by hand"
    now = int(time.time())
    d1(f"INSERT INTO users (id, email, created, last_seen) VALUES ({q(secrets.token_urlsafe(12))}, {q(email)}, {now}, NULL) "
       "ON CONFLICT(email) DO NOTHING")
    user = d1(f"SELECT id, org_id FROM users WHERE email = {q(email)}")[0]
    if plan in SEATS and not user["org_id"]:
        # a team plan belongs to an organization: create one with this person as its owner
        if not org_name:
            sys.exit("A team plan needs --org \"Organization name\".")
        org_id = secrets.token_urlsafe(9)
        d1(f"INSERT INTO orgs (id, name, owner_id, seats, created) VALUES ({q(org_id)}, {q(org_name)}, {q(user['id'])}, {SEATS[plan]}, {now})")
        d1(f"UPDATE users SET org_id = {q(org_id)} WHERE id = {q(user['id'])}")
        user["org_id"] = org_id
    subject = f"o:{user['org_id']}" if user["org_id"] else f"u:{user['id']}"
    if plan == "free":
        d1(f"DELETE FROM subscriptions WHERE subject = {q(subject)}")
    else:
        d1("INSERT INTO subscriptions (subject, plan, status, period_start, period_end, note, updated) VALUES "
           f"({q(subject)}, {q(plan)}, 'active', {now}, {now + 30 * 86400}, {q(note)}, {now}) "
           "ON CONFLICT(subject) DO UPDATE SET plan = excluded.plan, status = 'active', note = excluded.note, updated = excluded.updated")
    print(json.dumps(d1(f"SELECT * FROM subscriptions WHERE subject = {q(subject)}") or [{"subject": subject, "plan": "free"}], indent=1))


if __name__ == "__main__":
    main()
