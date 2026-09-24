# Workspace egress and private networks

On a CNI that enforces NetworkPolicy, the chart's default policy restricts inbound
daemon traffic to gateway pods. It does **not** restrict outbound traffic. Set
`networkPolicy.egress.enabled=true` to opt into outbound allow-listing; this
permits cluster DNS and the gateway Service, plus configured rules. An empty
extra rule list blocks Git/provider/package access on a CNI that enforces policy.

```yaml
networkPolicy:
  enabled: true
  egress:
    enabled: true
    rules:
      # Example: allow HTTPS destinations. Narrow CIDRs or use an egress proxy
      # for a real private deployment; this example is intentionally broad.
      - to: [{ipBlock: {cidr: 0.0.0.0/0}}]
        ports: [{protocol: TCP, port: 443}]
    profiles:
      - name: engineering
        rules:
          - to: [{ipBlock: {cidr: 10.20.0.0/16}}]
            ports: [{protocol: TCP, port: 443}]
```

Profile policies select the `paseo-gateway.manziman.github.io/credential-profile`
label. Rules are additive, so a broad global rule cannot be narrowed by a profile
rule. Keep global rules minimal when identities have different network access.
SSH Git requires TCP22 to the approved Git endpoint. DNS selectors assume the
standard `kube-system`/`k8s-app=kube-dns` deployment; adapt them for your cluster.

Standard Kubernetes NetworkPolicy accepts pod/namespace selectors and IP blocks,
not provider DNS names. CDNs and provider IP addresses change. Use a controlled
HTTPS egress proxy or your CNI's explicitly supported FQDN policy for hostname
allow-lists. Do not copy a stale IP list from this document. Include the endpoints
actually configured for Claude, Codex, OpenCode, GitHub API/Git, model gateways,
package registries and remote MCP services. Test catalog refresh and actual model
requests as well as TCP reachability. A mounted private CA is an operator choice,
not a reason to disable certificate validation.

Docker Desktop's Kubernetes backend/CNI may not enforce NetworkPolicy. A successful
local functional test is not evidence of egress isolation. Test allowed **and**
denied traffic on the intended EKS CNI configuration before claiming enforcement.
See the [Kubernetes NetworkPolicy documentation](https://kubernetes.io/docs/concepts/services-networking/network-policies/).

For tailnet-only destinations, configure networking outside this gateway: a
Tailscale Kubernetes Operator egress proxy or a subnet router with correctly
routed return traffic and tailnet grants. Authorize the operator/proxy identity
and selected services; a profile name is not itself a Tailscale identity. Match
NetworkPolicy to the proxy pod/namespace and service port, then test DNS and
end-to-end connections. Do not add a Tailscale daemon or authentication key to
every worker image. Follow Tailscale's [cluster egress guide](https://tailscale.com/kb/1438/kubernetes-operator-cluster-egress)
for the chosen topology and version. This project does not install or manage it.

## Trust boundary

Deploy one trusted owner's workloads per namespace. Credential profiles and scoped
gateway tokens constrain configuration and gateway requests; they do not provide
hostile multi-tenant isolation. The gateway ServiceAccount can read namespace-local
Secrets and manage or execute commands in workspace Pods. Workspace processes can
read their mounted provider/Git credentials. Restrict profile/project administration
and custom-image selection to trusted operators.

Workspace daemons currently share a namespace-level backend password. Enforced
ingress policy is required to prevent a worker from connecting directly to another
worker's daemon and bypassing scoped gateway routing. When the CNI does not enforce
that policy, this network isolation is absent. Gateway-to-daemon WebSockets are
unencrypted inside the cluster; use an appropriately protected cluster network,
and do not describe this as an encrypted multi-tenant boundary.

The generated Pods run without root, drop Linux capabilities, disable privilege
escalation, use RuntimeDefault seccomp, and disable workspace ServiceAccount token
mounting. These Pod settings do not enable namespace-wide Pod Security Admission.
The chart does not apply PSA enforcement labels or install a sandboxed runtime.
Test the full image and any customizations against the intended admission policy.
