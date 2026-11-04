"""Read-only OCI inventory with GitHub OIDC federation.

All calls are GET/list via Oracle's maintained SDK. Never log credentials,
network addresses, OCIDs, instance names, request errors or token responses.
"""

import json
import os
import re
import sys
from urllib.parse import quote, urlsplit

REQUIRED = (
    "OCI_REGION",
    "OCI_TENANCY_OCID",
    "OCI_COMPARTMENT_OCID",
    "OCI_IDENTITY_DOMAIN_URL",
    "OCI_OAUTH_CLIENT_ID",
    "OCI_OAUTH_CLIENT_SECRET",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
)


def validate_runtime(env):
    issues = []
    if any(not env.get(key) for key in REQUIRED):
        issues.append("OCI_INVENTORY_CONFIGURATION_MISSING")
    if env.get("GITHUB_REPOSITORY") != "Shards-foundation/Shards-Agent-Trading-Network":
        issues.append("UNTRUSTED_REPOSITORY")
    if env.get("GITHUB_REF") != "refs/heads/main":
        issues.append("MAIN_BRANCH_REQUIRED")
    sha = env.get("GITHUB_SHA", "")
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        issues.append("EXACT_COMMIT_REQUIRED")
    if sha != env.get("SATNS_EXPECTED_SHA", ""):
        issues.append("COMMIT_MISMATCH")
    if env.get("EXECUTION_MODE") != "PAPER":
        issues.append("PAPER_MODE_REQUIRED")
    if env.get("LIVE_EXECUTION_ENABLED") != "false":
        issues.append("LIVE_EXECUTION_MUST_BE_DISABLED")
    try:
        domain = urlsplit(env.get("OCI_IDENTITY_DOMAIN_URL", ""))
        if (
            domain.scheme != "https"
            or domain.username
            or domain.password
            or domain.port not in (None, 443)
            or domain.path not in ("", "/")
            or domain.query
            or domain.fragment
            or not (
                domain.hostname == "identity.oraclecloud.com"
                or (domain.hostname or "").endswith(".identity.oraclecloud.com")
            )
        ):
            issues.append("OCI_DOMAIN_URL_INVALID")
    except ValueError:
        issues.append("OCI_DOMAIN_URL_INVALID")
    if not re.fullmatch(r"[a-z]{2}-[a-z0-9-]+-[1-9][0-9]*", env.get("OCI_REGION", "")):
        issues.append("OCI_REGION_INVALID")
    for key in ("OCI_TENANCY_OCID", "OCI_COMPARTMENT_OCID"):
        if not re.fullmatch(r"ocid1\\.[a-z0-9_.-]{8,}", env.get(key, "")):
            issues.append("OCI_IDENTIFIER_INVALID")
            break
    return issues


def main():
    issues = validate_runtime(os.environ)
    if issues:
        print(json.dumps({"event": "oci.inventory.blocked", "issues": issues}))
        return 1

    try:
        import oci
        import requests

        region = os.environ["OCI_REGION"]
        tenancy = os.environ["OCI_TENANCY_OCID"]
        compartment = os.environ["OCI_COMPARTMENT_OCID"]
        audience = "https://cloud.oracle.com"

        def github_token():
            url = os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"]
            sep = "&" if "?" in url else "?"
            response = requests.get(
                url + sep + "audience=" + quote(audience, safe=""),
                headers={
                    "Authorization": "Bearer " + os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]
                },
                timeout=15,
            )
            response.raise_for_status()
            token = response.json().get("value")
            if not isinstance(token, str) or not token:
                raise ValueError("OIDC_RESPONSE_INVALID")
            return token

        signer = oci.auth.signers.TokenExchangeSigner(
            github_token,
            os.environ["OCI_IDENTITY_DOMAIN_URL"].rstrip("/"),
            os.environ["OCI_OAUTH_CLIENT_ID"],
            os.environ["OCI_OAUTH_CLIENT_SECRET"],
        )
        config = {"region": region}
        identity = oci.identity.IdentityClient(config, signer=signer)
        subscriptions = oci.pagination.list_call_get_all_results(
            identity.list_region_subscriptions, tenancy
        ).data
        home = [x.region_name for x in subscriptions if x.is_home_region]
        if home != [region]:
            print(json.dumps({"event": "oci.inventory.blocked", "issues": ["NOT_HOME_REGION"]}))
            return 1

        compute = oci.core.ComputeClient(config, signer=signer)
        instances = oci.pagination.list_call_get_all_results(
            compute.list_instances, compartment
        ).data
        active = [
            x for x in instances if x.lifecycle_state not in ("TERMINATED", "TERMINATING")
        ]
        ampere = [x for x in active if x.shape == "VM.Standard.A1.Flex"]
        shape_details = all(
            x.shape_config is not None
            and x.shape_config.ocpus is not None
            and x.shape_config.memory_in_gbs is not None
            for x in ampere
        )
        ocpus = sum(float(x.shape_config.ocpus) for x in ampere) if shape_details else None
        memory = (
            sum(float(x.shape_config.memory_in_gbs) for x in ampere)
            if shape_details
            else None
        )

        domains = oci.pagination.list_call_get_all_results(
            identity.list_availability_domains, tenancy
        ).data
        block = oci.core.BlockstorageClient(config, signer=signer)
        boots = []
        for domain in domains:
            boots.extend(
                oci.pagination.list_call_get_all_results(
                    block.list_boot_volumes,
                    compartment_id=compartment,
                    availability_domain=domain.name,
                ).data
            )
        boots = [
            v for v in boots if v.lifecycle_state not in ("TERMINATED", "TERMINATING")
        ]
        network = oci.core.VirtualNetworkClient(config, signer=signer)
        vcns = oci.pagination.list_call_get_all_results(network.list_vcns, compartment).data

        print(
            json.dumps(
                {
                    "event": "oci.inventory.readonly.completed",
                    "selectedRegionIsHome": True,
                    "scope": "ONE_COMPARTMENT_ONLY",
                    "activeComputeCount": len(active),
                    "ampereA1Count": len(ampere),
                    "ampereA1OcpusInCompartment": ocpus,
                    "ampereA1MemoryGbInCompartment": memory,
                    "bootVolumeGbInCompartment": sum(v.size_in_gbs for v in boots),
                    "vcnCountInCompartment": len(vcns),
                    "tenancyWideQuotaVerified": False,
                    "liveCapacityVerified": False,
                    "billingApproval": False,
                    "resourcesCreated": 0,
                    "liveTradingEnabled": False,
                },
                sort_keys=True,
            )
        )
        return 0
    except Exception:
        # SDK exceptions can include request details; fail without printing them.
        print(json.dumps({"event": "oci.inventory.blocked", "issues": ["OCI_READ_FAILED"]}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
