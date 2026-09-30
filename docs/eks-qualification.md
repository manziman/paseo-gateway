# EKS qualification (pending)

EKS is a qualification target, not a supported deployment claim yet. This
runbook describes evidence required for a single gateway and independently
scoped workspace Pods. Keep environment names, account IDs, cluster names,
private endpoints, image repositories, credentials, and raw command output in
operator-local files. Public evidence may include only sanitized versions,
candidate image digests, check status, and issue links.

## Read-only preflight

Copy [example EKS values](eks-values.example.yaml) to a local file, fill both
candidate digests and the actual encrypted StorageClass, and adapt egress to an
approved proxy. Set an explicit external gateway host allowlist and distinct
TLS Secret names. Choose the target context, existing test namespace, EBS CSI
StorageClass, and that local values file deliberately. The script never uses the current kubecontext
or default namespace. It invokes only Kubernetes GET/version and `auth can-i`
queries; it does not read Secret values or mutate cluster resources.

```sh
node scripts/eks-preflight.mjs \
  --context "$QUALIFICATION_CONTEXT" \
  --namespace "$QUALIFICATION_NAMESPACE" \
  --storage-class "$QUALIFICATION_STORAGE_CLASS" \
  --network-mode "$QUALIFICATION_NETWORK_MODE" \
  --values "$QUALIFICATION_VALUES" \
  > "$LOCAL_REDACTED_PREFLIGHT"
```

Exit code 1 means at least one requirement is blocked. The report intentionally
does not print context or namespace names, Kubernetes object YAML, kubectl errors,
image references, CNI arguments, or private endpoints. Keep the local values
file outside public artifacts. The check observes an Active namespace UID, API
version, EBS CSI driver and class, a chart StorageClass matching the inspected
class, explicit `encrypted: "true"`, established namespaced CRDs serving
`v1alpha1`, operator RBAC, and requested chart policy settings. It rejects
empty or unrestricted egress rules; specific rule syntax still needs chart
lint/render and operator review. Select `--network-mode standard` or
`--network-mode auto` explicitly; the StorageClass provisioner does not
identify networking mode. For standard EKS it reads the VPC CNI policy
agent and strict startup
setting; for Auto Mode it reads the `amazon-vpc-cni` controller ConfigMap. Auto
Mode manages networking differently and has no required `aws-node` DaemonSet;
review the selected NodeClass policy in private and perform a startup probe. It cannot prove a
volume is encrypted after provisioning or that a policy actually denies packets.
Missing access is **BLOCKED**, never PASS. A different CNI requires an equivalent
manual review and live probes; this preflight only recognizes the EKS VPC CNI.
The chart's three CRDs are cluster-scoped install prerequisites. The preflight
only reads them; any missing or incompatible CRD needs a separate operator plan.
Its RBAC check concerns the operator's fixture verbs, while gateway ServiceAccount
authorization remains a live-install check.

Record exact `kubectl`, Helm, EKS platform, VPC CNI, EBS CSI, chart, gateway and
workspace candidate versions in a private operator worksheet. Independently
verify image pull from the selected registry by exact digest during the isolated
fixture. If the StorageClass relies on account-wide EBS encryption by default,
verify the effective volume setting through the cloud API after provisioning;
the preflight cannot infer that default. Validate any custom KMS key permissions.
Record available node capacity and taints, selected NodeClass, gateway runtime
command, registry authentication, and the credential migration/restore plan
privately. A Secret's name or existence does not prove its contents; never print
Secret values during preflight.

## Isolated fixture and acceptance order

1. Obtain a dedicated namespace and unique release prefix. Record namespace UID,
   ownership labels, exact candidate digests, chart version, and created object
   UIDs in a private manifest. Install no cluster add-ons or shared node changes.
   Scope credentials and Git access to fixture projects. The chart fixes the
   gateway Deployment at one replica; do not scale it manually.
2. Before any workload, establish a protected gateway ingress path and enable
   chart TLS for gateway-to-workspace and backend transport with certificate
   validation. Provision separate gateway and workspace Secrets containing
   `tls.crt`, `tls.key`, and `ca.crt`. Gateway certificate SANs must cover its
   Service and client hostname; workspace SANs must cover its Services. Prefer
   separate issuers/trust bundles so a workspace key cannot impersonate the
   gateway. Review [transport security](transport-security.md). The preflight
   checks configuration only; verify real handshakes and rotation separately.
   NetworkPolicy restricts connections; it does not encrypt them.
3. Render and inspect chart values, apply only within the fixture namespace, then
   verify CRD schema compatibility, installed gateway ServiceAccount permissions,
   exact image digests, Pod readiness, PVC binding and actual
   `spec.accessModes: [ReadWriteOncePod]` on newly created claims, volume encryption,
   events, and denied image pull behavior. Test provider catalog and one private
   scheduled orchestrator-to-worker job using scoped credentials and approved
   egress. Redact prompts and model outputs in evidence.
4. From separately labeled fixture Pods, prove allowed gateway-to-workspace,
   workspace-to-DNS, approved provider and private destination traffic. Prove
   denied cross-workspace daemon, disallowed external, and metadata-service
   traffic. Exercise the Pod at startup as well as steady state; record startup
   enforcement as a separate acceptance check. Record packet
   destination category and outcome, without private addresses. A rendered
   NetworkPolicy or enabled CNI flag alone is insufficient. Avoid `hostNetwork`.
   The restricted source Pod must carry `app.kubernetes.io/component: workspace`
   so the chart policy selects it; the paired control Pod must omit that label.
   Verify both selectors against the rendered policy before interpreting results.
   After the operator creates two disposable Pods with Node installed, use
   `scripts/eks-network-probes.mjs` for TCP checks. It requires `--run-probes`,
   explicit `--context`/`--namespace`, namespace and both Pod UIDs, a shared
   `paseo-gateway.manziman.github.io/qualification-run` label, both Pod/container names, numeric
   `--allowed-ip`/`--allowed-port`, `--cross-workspace-ip`/port and
   `--denied-ip`/port. It verifies UID/label/container ownership before any
   `kubectl exec`; it creates or deletes nothing. The control Pod must reach
   cross-workspace and denied-egress targets while the restricted Pod cannot.
   The control Pod must also reach the metadata endpoint while the restricted
   Pod cannot; an infrastructure-wide metadata disablement leaves policy
   attribution BLOCKED. The script tests TCP connection, not TLS identity or
   application authorization.
5. Replace a workspace Pod and gateway Pod, then verify PVC data, identity,
   history, client reconnect with a fresh full directory generation, and no
   duplicate prompt after an ambiguous response. Exercise suspend/resume,
   chart upgrade/rollback, and reinstall with requested data retained.
6. Inject unavailable API, unschedulable/capacity, OOM, and eviction conditions
   only in an isolated fixture. Verify bounded timeouts, visible `lastError`,
   actionable events, and retention of data after failed teardown.
7. Run node-loss and writer-fencing tests **only** on a disposable dedicated
   failure fixture with an explicit operator gate. Partition the old writer,
   attempt replacement, and prove the old writer is stopped or fenced before
   the new one writes. Do not force-delete a Pod and infer safety from
   `ReadWriteOnce`, `ReadWriteOncePod`, or a single gateway replica. Preserve both event streams and
   check for duplicate prompts.

Do not run step 7 on shared nodes or a production workload. A test without a
dedicated fixture remains BLOCKED; it cannot be replaced by a simulator result.

## Cleanup and public evidence

Before deletion, compare each candidate resource's namespace, ownership label,
recorded UID, ownerReference UID, and release prefix to the private manifest.
Abort on a mismatch. Delete only fixture resources in reverse dependency order.
Choose explicit PVC retention; never remove retained PVCs, identity Secrets, or
history because Helm was uninstalled. List remaining fixture resources and
verify requested data remains. No cluster-wide resource or add-on cleanup is
part of this procedure.

Publish a matrix with `PASS`, `FAIL`, or `BLOCKED` per probe, exact candidate
versions/digests, sanitized observations, and blocking issue links. Mark every
unexecuted probe BLOCKED. No blanket EKS claim follows from preflight alone.
The local evidence gate `node scripts/eks-acceptance.mjs --evidence LOCAL_JSON_FILE`
prints only check IDs and status. Each passing key requires `status: "PASS"`,
`kind: "live-eks"`, and a nonempty private `evidence` reference. The
`failure.old-writer-fenced` key additionally requires
`dedicatedFailureFixture: true`. This grader validates completeness, not the
underlying observations; reviewers must inspect the private evidence separately.
In particular, live CRD/ServiceAccount RBAC, RWOP binding, certificate identity,
and startup enforcement each need their own evidence; a preflight flag or
rendered manifest cannot satisfy those keys.

## Source constraints

- [Kubernetes Persistent Volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/): `ReadWriteOnce` is not pod-level fencing; even access modes do not enforce write protection after mount. `ReadWriteOncePod` needs compatible CSI and still requires failure validation.
- [Kubernetes NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/): enforcement depends on the plugin, policies are layer 3/4 controls, and TLS is outside this API.
- [EKS VPC CNI policy configuration](https://docs.aws.amazon.com/eks/latest/userguide/cni-network-policy-configure.html): policy must be enabled; standard startup begins default allow, while strict mode begins default deny. Host networking is excluded from that strict startup protection.
- [EKS Auto Mode NetworkPolicy](https://docs.aws.amazon.com/eks/latest/userguide/auto-net-pol.html) and [Auto Mode networking](https://docs.aws.amazon.com/eks/latest/userguide/auto-networking.html): Auto Mode uses a managed networking capability; its controller ConfigMap and NodeClass replace the standard `aws-node` configuration path.
- [EKS EBS CSI driver](https://docs.aws.amazon.com/eks/latest/userguide/ebs-csi.html) and [EKS StorageClass](https://docs.aws.amazon.com/eks/latest/userguide/create-storage-class.html): check the correct provisioner for the selected EKS mode, encryption setting, topology, and KMS permissions.
