import unittest
from inventory import validate_runtime


class InventoryGateTests(unittest.TestCase):
    def setUp(self):
        self.valid = {
            "OCI_REGION": "uk-london-1",
            "OCI_TENANCY_OCID": "ocid1.tenancy.oc1..exampletoken",
            "OCI_COMPARTMENT_OCID": "ocid1.compartment.oc1..exampletoken",
            "OCI_IDENTITY_DOMAIN_URL": "https://idcs-example.identity.oraclecloud.com",
            "OCI_OAUTH_CLIENT_ID": "synthetic-client",
            "OCI_OAUTH_CLIENT_SECRET": "synthetic-secret",
            "ACTIONS_ID_TOKEN_REQUEST_URL": "https://example.invalid/token?x=y",
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "synthetic-github-access",
            "GITHUB_REPOSITORY": "Shards-foundation/Shards-Agent-Trading-Network",
            "GITHUB_REF": "refs/heads/main",
            "GITHUB_SHA": "a" * 40,
            "SATNS_EXPECTED_SHA": "a" * 40,
            "EXECUTION_MODE": "PAPER",
            "LIVE_EXECUTION_ENABLED": "false",
        }

    def test_valid_synthetic_readonly_environment(self):
        self.assertEqual(validate_runtime(self.valid), [])

    def test_rejects_wrong_repository_ref_or_sha(self):
        config = dict(self.valid)
        config.update({
            "GITHUB_REPOSITORY": "attacker/repo",
            "GITHUB_REF": "refs/heads/feature",
            "SATNS_EXPECTED_SHA": "b" * 40,
        })
        issues = validate_runtime(config)
        self.assertIn("UNTRUSTED_REPOSITORY", issues)
        self.assertIn("MAIN_BRANCH_REQUIRED", issues)
        self.assertIn("COMMIT_MISMATCH", issues)

    def test_rejects_insecure_identity_domain(self):
        for value in (
            "http://idcs-example.identity.oraclecloud.com",
            "https://user:pass@idcs-example.identity.oraclecloud.com",
            "https://attacker.example.com",
        ):
            config = dict(self.valid)
            config["OCI_IDENTITY_DOMAIN_URL"] = value
            self.assertIn("OCI_DOMAIN_URL_INVALID", validate_runtime(config))

    def test_rejects_live_execution(self):
        config = dict(self.valid)
        config["EXECUTION_MODE"] = "LIVE_RESTRICTED"
        config["LIVE_EXECUTION_ENABLED"] = "true"
        issues = validate_runtime(config)
        self.assertIn("PAPER_MODE_REQUIRED", issues)
        self.assertIn("LIVE_EXECUTION_MUST_BE_DISABLED", issues)

    def test_missing_credentials_never_returned(self):
        config = dict(self.valid)
        config["OCI_OAUTH_CLIENT_SECRET"] = ""
        issues = validate_runtime(config)
        self.assertIn("OCI_INVENTORY_CONFIGURATION_MISSING", issues)
        self.assertNotIn("synthetic-client", str(issues))


if __name__ == "__main__":
    unittest.main()
