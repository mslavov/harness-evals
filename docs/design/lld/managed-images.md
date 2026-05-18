# LLD — Managed Runtime Images

> **HLD:** `../HDL.md`
> **Companion LLDs:** `agent-first-install-and-config.md`, `adapter-registry-and-contract.md`, `scenario-runner.md`, `validation-scoring-and-judging.md`, `cost-and-artifacts.md`, `output-providers.md`, `mock-mcps-and-clis.md`, `result-visualization.md`
> **Status:** Draft

## How this fits

This LLD defines how the harness resolves the Docker runtime image while preserving the HLD invariants for local image ownership, adapter-owned installation recipes, ready-image bypass, and deterministic measurement.

## 1. Domain Overview

The image resolver chooses the Docker image used for every selected test-case/agent run. It has two modes:

1. **Ready image:** The consumer supplies an image that already contains the required coding-agent CLIs and tools. The harness does not build or rebuild anything.
2. **Managed image:** The harness builds a local image from a base image plus adapter-provided installation recipes, tags it with a deterministic cache key, reuses it while the manifest still matches, and rebuilds when selected providers/adapters require different installed tools.

The image resolver does not know provider-specific installation details. Adapters produce install recipes and probes; the image resolver normalizes the recipes, computes the cache key, builds the local image, runs probes, and records image metadata. Callers can explicitly refresh a managed image when upstream packages or the base image changed without changing the install manifest. Harness-provided mock wrappers are staged by the mock resolver at runtime; adapters can add probes when their MCP mock integration requires a specific runtime such as `node`.

## 2. Data Model / Contracts

### YAML shape

```yaml
docker:
  image: ghcr.io/acme/ready-agent-image:latest # optional ready image; bypasses managed builds
```

Rules:

- `docker.image` means “use this ready image.” When set, managed image build is skipped.
- If `docker.image` is absent, the harness uses managed-image mode.
- Managed-image base image selection and local tag prefix are internal harness details, not user-facing YAML fields.

### Image resolver contracts

```ts
type ImageMode = 'ready' | 'managed';

interface DockerConfig {
  image?: string;
  repoPath: string;
  home: string;
  configRoot: string;
  timeoutMs: number;
  envAllowlist: string[];
}

interface ImageResolutionInput {
  projectRoot: string;
  docker: DockerConfig;
  selectedAgents: ResolvedAgentConfig[];
  adapterRegistry: AdapterRegistry;
  refreshManagedImage?: boolean;
}

interface InstallManifest {
  schemaVersion: 1;
  baseImage: string;
  recipes: NormalizedInstallRecipe[];
}

interface NormalizedInstallRecipe {
  adapter: string;
  adapterVersion?: string;
  agentName: string;
  commands: string[];
  probes: AdapterProbe[];
  cacheKey?: string;
}

interface ImageResolutionResult {
  mode: ImageMode;
  image: string;
  manifest?: InstallManifest;
  cacheKey?: string;
  cacheHit?: boolean;
  probes: ProbeResult[];
}
```

### Adapter install input

The image resolver asks each selected adapter for an install recipe using the resolved agent config.

```ts
interface AdapterInstallInput {
  projectRoot: string;
  agentName: string;
  agent: ResolvedAgentConfig;
  docker: DockerConfig;
}
```

Adapters can return no recipe when the internal managed base image is sufficient or when the agent only works with a ready image.

## 3. Lifecycle / State Transitions

### Ready image lifecycle

```text
start
  -> read docker.image
  -> collect selected adapter probes
  -> run probes against ready image
  -> use ready image | fail
```

Rules:

1. Ready image mode never builds or rebuilds local images.
2. Probe failure is an actionable configuration failure, not a cache miss.
3. The resolved image is exactly the consumer-supplied image reference.

### Managed image lifecycle

```text
start
  -> collect selected adapter recipes
  -> normalize install manifest
  -> compute cache key
  -> refresh requested?
       |-- yes -> build with --pull --no-cache
       `-- no  -> local image exists?
                  |-- yes -> run probes
                  |          |-- pass -> use cached image
                  |          `-- fail -> rebuild
                  `-- no  -> build
  -> run probes after build when a build happened
  -> use managed image | fail
```

Rules:

1. Managed image tags are deterministic and use an internal harness tag prefix plus the cache key.
2. The cache key includes the internal base image, harness image schema version, adapter names, adapter versions, agent names, recipe commands, recipe probes, and recipe `cacheKey` values.
3. Adding a selected provider/adapter changes the install manifest when that provider/adapter has a recipe, producing a different cache key.
4. If a cached managed image exists but required probes fail, the resolver rebuilds that image once for the same key.
5. When refresh is requested, the resolver skips cached-image inspection and probe-before-build reuse, builds with Docker `--pull` and `--no-cache`, then reports `cacheHit: false`.
6. Install commands run during image build and must not require runtime secrets.
7. Mock wrapper runtime requirements are represented through adapter recipes or probes when the internal base image is insufficient.
8. Probes run after build and before test-case execution.

## 4. Read Path / Write Path

### Read path

1. Read Docker image configuration.
2. Read selected test-case/agent matrix entries.
3. Resolve selected adapters from the adapter registry.
4. Ask adapters for install recipes, including any mock-wrapper runtime probes they require.
5. Inspect Docker for the deterministic local image tag.

### Write path

1. Write a generated Dockerfile/build context under the internal image cache workspace.
2. Build the local Docker image with the deterministic managed tag.
3. Emit image resolution metadata as an `image.resolution` record so every output provider can persist the run environment metadata.
4. Let output providers persist the record.
5. Reuse Docker’s local image cache for matching tags unless managed-image refresh is requested.

Image resolution metadata record:

```json
{
  "mode": "managed",
  "image": "harness-evals:abc123",
  "cacheKey": "abc123",
  "cacheHit": true,
  "manifest": {
    "baseImage": "oven/bun:1.2.10",
    "recipes": [
      { "adapter": "pi", "agentName": "pi-gemini", "cacheKey": "pi@1" }
    ]
  },
  "probes": [
    { "command": ["pi", "--version"], "exitCode": 0, "pass": true }
  ]
}
```

## 5. Failure Modes

| Failure mode | Symptom | Detection | Remediation |
| --- | --- | --- | --- |
| Ready image missing required CLI | Run fails before test-case execution | Adapter probe fails against `docker.image` | Supply a ready image with the CLI or remove `docker.image` to use managed build |
| Install command fails | Managed image build fails | Docker build exit code | Fix adapter install recipe or supply a ready image |
| Probe fails after managed build | Image resolution fails | Probe exit code mismatch after rebuild | Fix install recipe or probe declaration |
| Recipe requires secret | Build fails or risks secret leakage | Install command references secret env or config mount | Move secret usage to runtime config, not image build |
| Cache key omits required install input | Cached image lacks newly required provider/tool | Probe fails or wrong CLI behavior | Include that input in adapter recipe `cacheKey`, commands, or probes |
| Upstream package changed without manifest change | Cached managed image contains stale globally installed tools or old base image layers | Probe output or runtime version in `image-resolution.json` is stale | Run with `--refresh-managed-image` |
| Docker daemon unavailable | Image resolution fails immediately | Docker command error | Start Docker or run in an environment with Docker access |

## 6. Trade-Offs Accepted

- `docker.image` is a ready-image override and always bypasses managed builds because it gives consumers full control.
- Managed images are local Docker images, not published images.
- The resolver builds one compatible image for the selected run matrix so repeated test cases do not reinstall tools.
- Cache invalidation is manifest-driven rather than time-based; explicit refresh covers upstream changes outside the manifest.
- Adapter recipes are trusted project-controlled commands because they run during Docker build.
- Probes are required for adapters that install CLIs so ready images and cached managed images can be validated consistently.

## 7. Design Decisions

### Accepted decisions

- `docker.image` represents a consumer-provided ready image.
- Managed-image base image selection and tag prefix are internal harness details.
- Managed image cache keys are derived from a normalized install manifest.
- Adding a selected provider/adapter with a new install recipe invalidates the cache by changing the manifest key.
- Ready images are probed but never rebuilt.
- `--refresh-managed-image` only affects managed images and rebuilds the selected managed tag with Docker `--pull` and `--no-cache`.

### Open decisions

- Whether the resolver should keep multiple old managed images or provide a prune command.
