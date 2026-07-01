"""Unit checks for the Ansible runner's inbound auth gate.

Run: `python deploy/ansible/runner_test.py` (the deploy runner has no CI test
harness; this is a runnable proof + contract documentation for `authorize`).
"""

import sys

from runner import authorize


def check(name, condition):
    if condition is not True:
        print(f"FAIL: {name}")
        sys.exit(1)
    print(f"ok: {name}")


# No token configured -> unauthenticated (dev/compose); startup prints a warning.
check("unset token allows a missing header", authorize(None, "") is True)
check("unset token allows any header", authorize("Bearer whatever", "") is True)

# Token configured -> /runs requires a matching Bearer token.
check("correct bearer token is accepted", authorize("Bearer s3cret", "s3cret") is True)
check("wrong token is rejected", authorize("Bearer nope", "s3cret") is False)
check("missing header is rejected", authorize(None, "s3cret") is False)
check("missing Bearer prefix is rejected", authorize("s3cret", "s3cret") is False)
check("empty bearer value is rejected", authorize("Bearer ", "s3cret") is False)

print("all runner auth checks passed")
