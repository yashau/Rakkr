"""Unit checks for the Ansible runner's inbound auth gate.

Run: `python deploy/ansible/runner_test.py` (the deploy runner has no CI test
harness; this is a runnable proof + contract documentation for `authorize`).
"""

import sys

from runner import TOKEN_PROVISION_ACTIONS, authorize


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

# Token minting must match the actions that actually rewrite recorder-agent.env
# in the recorder_node role (install_dependencies / update_binary). Minting
# revokes the node's current token, so minting on an action that does NOT
# rewrite the env (restart_service / rotate_trust) would lock the agent out of
# the controller with a 401 on its next heartbeat.
check("install_dependencies mints a token", "install_dependencies" in TOKEN_PROVISION_ACTIONS)
check("update_binary mints a token", "update_binary" in TOKEN_PROVISION_ACTIONS)
check(
    "restart_service does not mint (it does not rewrite the env)",
    "restart_service" not in TOKEN_PROVISION_ACTIONS,
)
check(
    "rotate_trust does not mint (it does not rewrite the env)",
    "rotate_trust" not in TOKEN_PROVISION_ACTIONS,
)
check("smoke_check does not mint", "smoke_check" not in TOKEN_PROVISION_ACTIONS)

print("all runner auth checks passed")
