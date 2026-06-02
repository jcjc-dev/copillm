#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { spawn } from "node:child_process";

import { startMockBackend, type MockBackend } from "../mock-backend/server.js";
import { seedFreshHome, type SeededHome } from "./seed-credentials.js";
import { startCopillmAgainstMock, type CopillmDaemon } from "./spawn-copillm.js";
import { codexLikeChat, discoverCodexModels } from "./clients/codexLikeClient.js";
import { claudeLikeChat, discoverClaudeModels } from "./clients/claudeLikeClient.js";
import { piLikeChat, pickPiProvider, readPiModelsConfig } from "./clients/piLikeClient.js";
import { buildAgentStubTarball, createAgentStub, createFakeNpm, writeNodeShim, type AgentName } from "./agent-stubs.js";

interface AssertionFailure {
  scenario: string;
  detail: string;
}

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CLI_ENTRY = path.join(REPO_ROOT, "dist", "cli.js");

async function main(): Promise<void> {
  const failures: AssertionFailure[] = [];
  let mock: MockBackend | null = null;
  let seeded: SeededHome | null = null;
  let daemon: CopillmDaemon | null = null;
  try {
    mock = await startMockBackend();
    log(`mock backend listening on ${mock.baseUrl}`);

    seeded = seedFreshHome();
    log(`seeded copillm home at ${seeded.copillmHome}`);

    daemon = await startCopillmAgainstMock({
      copillmHome: seeded.copillmHome,
      upstreamBaseUrl: mock.baseUrl,
      tokenExchangeUrl: mock.tokenExchangeUrl,
      githubUserUrl: mock.githubUserUrl,
      cliEntry: CLI_ENTRY
    });
    log(`copillm daemon up at ${daemon.baseUrl} (pid ${daemon.pid})`);

    await runScenario(failures, "codex-discovery", async () => {
      const models = await discoverCodexModels(daemon!.baseUrl);
      assertContains(models, "gpt-test-codex", "codex /models discovery should include gpt-test-codex");
      assertContains(models, "gpt-test", "codex /models discovery should include gpt-test");
      assertNotContains(models, "claude-test-opus", "codex /models discovery must not include claude-only models (no /responses support)");
    });

    await runScenario(failures, "codex-chat-streaming", async () => {
      const result = await codexLikeChat({
        copillmBaseUrl: daemon!.baseUrl,
        model: "gpt-test-codex",
        prompt: "ping"
      });
      assertEquals(result.modelInResponse, "gpt-test-codex", "codex response.created should report the requested model");
      assertEquals(result.fullText, "ok-from-mock:gpt-test-codex", "codex chat should yield expected reply text");
      assertGreaterThan(result.eventCount, 5, "codex SSE should emit multiple events (created/added/delta*/done/completed)");
    });

    await runScenario(failures, "claude-discovery", async () => {
      const models = await discoverClaudeModels(daemon!.baseUrl);
      const ids = models.map((m) => m.id);
      assertContains(ids, "claude-test-opus", "claude /models discovery should include claude-test-opus");
      assertContains(ids, "claude-test-sonnet", "claude /models discovery should include claude-test-sonnet");
      assertContains(ids, "claude-test-haiku", "claude /models discovery should include claude-test-haiku");
      const opus = models.find((m) => m.id === "claude-test-opus");
      assertEquals(opus?.display_name, "Claude Test Opus", "display_name should be propagated");
    });

    await runScenario(failures, "claude-chat-streaming", async () => {
      const result = await claudeLikeChat({
        copillmBaseUrl: daemon!.baseUrl,
        model: "claude-test-sonnet",
        prompt: "ping"
      });
      assertEquals(result.modelInResponse, "claude-test-sonnet", "claude message_start.model should be the requested model");
      assertEquals(result.fullText, "ok-from-mock:claude-test-sonnet", "claude chat should yield expected reply text");
      assertEquals(result.stopReason, "end_turn", "claude stop_reason should be end_turn for normal completion");
      assertGreaterThan(result.eventCount, 5, "claude SSE should emit multiple events");
    });

    await runScenario(failures, "client-disconnect-resilience", async () => {
      // Regression test: previously, a client disconnecting mid-stream (or an
      // upstream error after headers flushed) could cause the daemon process
      // to exit with ERR_HTTP_HEADERS_SENT / ERR_STREAM_DESTROYED. This
      // scenario aborts several streams in rapid succession across both
      // protocol shapes, then asserts the daemon's PID is unchanged and a
      // normal request still succeeds.
      const startingPid = daemon!.pid;

      // 3x abort against /codex/v1/responses
      for (let i = 0; i < 3; i += 1) {
        const controller = new AbortController();
        const response = await fetch(`${daemon!.baseUrl}/codex/v1/responses`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer copillm-local-test" },
          body: JSON.stringify({
            model: "gpt-test-codex",
            input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `abort-${i}` }] }],
            stream: true
          }),
          signal: controller.signal
        });
        if (response.body) {
          const reader = response.body.getReader();
          try {
            // Read one chunk so headers have committed, then abort.
            await reader.read();
          } catch { /* ignore */ }
          controller.abort();
          try { await reader.cancel(); } catch { /* ignore */ }
        }
      }

      // 3x abort against /anthropic/v1/messages
      for (let i = 0; i < 3; i += 1) {
        const controller = new AbortController();
        const response = await fetch(`${daemon!.baseUrl}/anthropic/v1/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer copillm-local-test",
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: "claude-test-sonnet",
            max_tokens: 64,
            stream: true,
            messages: [{ role: "user", content: `abort-${i}` }]
          }),
          signal: controller.signal
        });
        if (response.body) {
          const reader = response.body.getReader();
          try {
            await reader.read();
          } catch { /* ignore */ }
          controller.abort();
          try { await reader.cancel(); } catch { /* ignore */ }
        }
      }

      // Give the daemon a moment to settle (ping intervals, etc).
      await new Promise((r) => setTimeout(r, 1500));

      // Daemon process must still exist with the same PID.
      try {
        process.kill(startingPid, 0);
      } catch {
        throw new Error(`daemon pid ${startingPid} is no longer alive after 6 mid-stream aborts`);
      }

      // /livez must still respond.
      const livez = await fetch(`${daemon!.baseUrl}/livez`);
      if (livez.status !== 200) {
        throw new Error(`/livez returned ${livez.status} after abort storm`);
      }

      // A complete, normal request must still succeed end-to-end on both shapes.
      const codexResult = await codexLikeChat({
        copillmBaseUrl: daemon!.baseUrl,
        model: "gpt-test-codex",
        prompt: "after-abort"
      });
      assertEquals(codexResult.fullText, "ok-from-mock:gpt-test-codex", "post-abort codex chat should still complete");

      const claudeResult = await claudeLikeChat({
        copillmBaseUrl: daemon!.baseUrl,
        model: "claude-test-sonnet",
        prompt: "after-abort"
      });
      assertEquals(claudeResult.fullText, "ok-from-mock:claude-test-sonnet", "post-abort claude chat should still complete");

      // Re-confirm the PID after the post-recovery requests.
      try {
        process.kill(startingPid, 0);
      } catch {
        throw new Error(`daemon pid ${startingPid} died after the recovery request`);
      }
    });

    await runScenario(failures, "pi-config-written", async () => {
      // `copillm start` (via spawn-copillm) writes ~/.pi/agent/models.json into
      // the daemon's isolated $HOME. Verify it actually landed and is well-formed.
      const configPath = path.join(daemon!.fakeHome, ".pi", "agent", "models.json");
      if (!fs.existsSync(configPath)) {
        throw new Error(`expected pi models.json at ${configPath}; daemon may not have written it`);
      }
      const cfg = readPiModelsConfig(configPath);
      const anthroProvider = pickPiProvider(cfg, "copillm");
      if (!anthroProvider.baseUrl.endsWith("/anthropic")) {
        throw new Error(`pi anthropic provider baseUrl should end with /anthropic; got ${anthroProvider.baseUrl}`);
      }
      if (!anthroProvider.baseUrl.includes(`127.0.0.1:${daemon!.port}`)) {
        throw new Error(`pi provider baseUrl should target the running daemon port ${daemon!.port}; got ${anthroProvider.baseUrl}`);
      }
      const ids = anthroProvider.models.map((m) => m.id);
      assertContains(ids, "claude-test-sonnet", "pi models should include claude-test-sonnet from mock catalog");

      // Per-model contextWindow/maxTokens must be populated from the upstream
      // catalog. Without them pi falls back to 128_000 / 16_384 defaults and
      // auto-compacts conversations well before the real budget.
      const sonnet = anthroProvider.models.find((m) => m.id === "claude-test-sonnet");
      if (!sonnet) throw new Error("claude-test-sonnet missing from anthropic provider");
      assertEquals(sonnet.contextWindow, 200_000, "claude-test-sonnet contextWindow should come from upstream limits");
      assertEquals(sonnet.maxTokens, 8_192, "claude-test-sonnet maxTokens should come from upstream limits");

      // Models that only advertise /responses (no /chat/completions) must
      // surface in the second provider, not the Anthropic-messages one — the
      // /anthropic surface upstream-routes to /chat/completions and would 404.
      assertNotContains(ids, "gpt-test-codex", "responses-only model must not appear in anthropic provider");
      const responsesProvider = pickPiProvider(cfg, "copillm-responses", "openai-responses");
      if (responsesProvider.baseUrl !== `http://127.0.0.1:${daemon!.port}/codex/v1`) {
        throw new Error(`pi responses provider baseUrl should target /codex/v1; got ${responsesProvider.baseUrl}`);
      }
      const responsesIds = responsesProvider.models.map((m) => m.id);
      assertContains(responsesIds, "gpt-test-codex", "responses-only model should appear in openai-responses provider");
      const codex = responsesProvider.models.find((m) => m.id === "gpt-test-codex");
      assertEquals(codex?.contextWindow, 256_000, "gpt-test-codex contextWindow should come from upstream limits");
      assertEquals(codex?.maxTokens, 16_384, "gpt-test-codex maxTokens should come from upstream limits");
    });

    await runScenario(failures, "pi-chat-streaming", async () => {
      // Drive the exact path pi takes at launch: read models.json, then POST to
      // the configured baseUrl. This validates the wiring end-to-end.
      const configPath = path.join(daemon!.fakeHome, ".pi", "agent", "models.json");
      const cfg = readPiModelsConfig(configPath);
      const provider = pickPiProvider(cfg, "copillm");
      const result = await piLikeChat({
        provider,
        model: "claude-test-sonnet",
        prompt: "ping"
      });
      assertEquals(result.modelInResponse, "claude-test-sonnet", "pi message_start.model should be the requested model");
      assertEquals(result.fullText, "ok-from-mock:claude-test-sonnet", "pi chat should yield expected reply text");
      assertEquals(result.stopReason, "end_turn", "pi stop_reason should be end_turn for normal completion");
      assertGreaterThan(result.eventCount, 5, "pi SSE should emit multiple events");
      if (result.inputTokens === null) {
        throw new Error("pi message_start.usage.input_tokens should be populated");
      }
      // Mock backend's streaming path doesn't emit a final usage chunk, so
      // output_tokens flows through as 0. We assert it's at least present
      // (not null) — sufficient to prove the field plumbs end-to-end.
      if (typeof result.outputTokens !== "number") {
        throw new Error(`pi message_delta.usage.output_tokens should be a number; got ${result.outputTokens}`);
      }
    });

    await runScenario(failures, "env-claude-prints-block", async () => {
      const out = await runCli(["env", "claude"], { COPILLM_HOME: seeded!.copillmHome });
      assertEquals(out.status, 0, `env claude should exit 0 (got ${out.status}); stderr=${out.stderr}`);
      const lines = out.stdout.split("\n");
      if (lines[0] !== "# Claude Code \u2192 copillm") {
        throw new Error(`expected header line; got: ${JSON.stringify(lines[0])}`);
      }
      if (!out.stdout.includes(`export ANTHROPIC_BASE_URL="http://127.0.0.1:${daemon!.port}/anthropic"`)) {
        throw new Error(`expected ANTHROPIC_BASE_URL line; got:\n${out.stdout}`);
      }
      if (!out.stdout.includes(`export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY="1"`)) {
        throw new Error(`expected gateway flag in env block; got:\n${out.stdout}`);
      }
    });

    await runScenario(failures, "env-codex-prints-block", async () => {
      const out = await runCli(["env", "codex"], {
        COPILLM_HOME: seeded!.copillmHome,
        COPILLM_UPSTREAM_BASE_URL: mock!.baseUrl,
        COPILLM_TOKEN_EXCHANGE_URL: mock!.tokenExchangeUrl,
        COPILLM_GITHUB_USER_URL: mock!.githubUserUrl
      });
      assertEquals(out.status, 0, `env codex should exit 0 (got ${out.status}); stderr=${out.stderr}`);
      if (!out.stdout.startsWith("# Codex CLI \u2192 copillm")) {
        throw new Error(`expected codex header; got:\n${out.stdout}`);
      }
      if (!/export CODEX_HOME="[^"]+"/.test(out.stdout)) {
        throw new Error(`expected CODEX_HOME line; got:\n${out.stdout}`);
      }
    });

    await runScenario(failures, "env-claude-json", async () => {
      const out = await runCli(["env", "claude", "--json"], { COPILLM_HOME: seeded!.copillmHome });
      assertEquals(out.status, 0, `env claude --json should exit 0 (got ${out.status})`);
      const parsed = JSON.parse(out.stdout) as { agent: string; env: Record<string, string>; shell_block: string };
      assertEquals(parsed.agent, "claude", "json agent field should be claude");
      if (!parsed.env.ANTHROPIC_BASE_URL) throw new Error("json env should contain ANTHROPIC_BASE_URL");
      if (!parsed.shell_block.includes("export ANTHROPIC_BASE_URL")) {
        throw new Error("shell_block should contain the rendered export line");
      }
    });

    await runScenario(failures, "env-pi-prints-block", async () => {
      // `copillm env pi` regenerates pi's models.json into the caller's $HOME.
      // Point HOME at a throwaway dir to avoid clobbering the developer's real one.
      const piEnvHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-pi-env-"));
      try {
        const out = await runCli(["env", "pi"], {
          COPILLM_HOME: seeded!.copillmHome,
          COPILLM_UPSTREAM_BASE_URL: mock!.baseUrl,
          COPILLM_TOKEN_EXCHANGE_URL: mock!.tokenExchangeUrl,
          COPILLM_GITHUB_USER_URL: mock!.githubUserUrl,
          HOME: piEnvHome,
          USERPROFILE: piEnvHome
        });
        assertEquals(out.status, 0, `env pi should exit 0 (got ${out.status}); stderr=${out.stderr}`);
        if (!out.stdout.includes("# pi") && !out.stdout.includes("pi reads ~/.pi/agent/models.json")) {
          throw new Error(`expected pi env block (header or trailing note); got:\n${out.stdout}`);
        }
        // Verify the side effect: models.json should now live under the fake HOME.
        const configPath = path.join(piEnvHome, ".pi", "agent", "models.json");
        if (!fs.existsSync(configPath)) {
          throw new Error(`env pi should regenerate ~/.pi/agent/models.json under fake HOME; missing at ${configPath}`);
        }
        const cfg = readPiModelsConfig(configPath);
        pickPiProvider(cfg, "copillm");
      } finally {
        try { fs.rmSync(piEnvHome, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    });

    await runScenario(failures, "env-pi-json", async () => {
      const piEnvHome = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-pi-env-json-"));
      try {
        const out = await runCli(["env", "pi", "--json"], {
          COPILLM_HOME: seeded!.copillmHome,
          COPILLM_UPSTREAM_BASE_URL: mock!.baseUrl,
          COPILLM_TOKEN_EXCHANGE_URL: mock!.tokenExchangeUrl,
          COPILLM_GITHUB_USER_URL: mock!.githubUserUrl,
          HOME: piEnvHome,
          USERPROFILE: piEnvHome
        });
        assertEquals(out.status, 0, `env pi --json should exit 0 (got ${out.status}); stderr=${out.stderr}`);
        const parsed = JSON.parse(out.stdout) as {
          agent: string;
          package: string;
          pi_config_path: string;
          pi_model_count: number;
        };
        assertEquals(parsed.agent, "pi", "json agent field should be pi");
        assertEquals(parsed.package, "@earendil-works/pi-coding-agent", "package should be pi npm name");
        if (!parsed.pi_config_path || !parsed.pi_config_path.endsWith(path.join(".pi", "agent", "models.json"))) {
          throw new Error(`pi_config_path should end with .pi/agent/models.json; got ${parsed.pi_config_path}`);
        }
        if (typeof parsed.pi_model_count !== "number" || parsed.pi_model_count <= 0) {
          throw new Error(`pi_model_count should be > 0; got ${parsed.pi_model_count}`);
        }
      } finally {
        try { fs.rmSync(piEnvHome, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    });

    await runLauncherScenarios(failures, daemon, seeded, mock);
  } catch (error) {
    failures.push({ scenario: "fixture-setup", detail: error instanceof Error ? error.stack ?? error.message : String(error) });
  } finally {
    if (daemon) await daemon.stop();
    if (mock) await mock.close();
    if (seeded) seeded.cleanup();
  }

  if (failures.length > 0) {
    process.stderr.write(`\n\u2717 PR-gate runner: ${failures.length} failure(s)\n\n`);
    for (const f of failures) {
      process.stderr.write(`  [${f.scenario}] ${f.detail}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(`\n\u2713 PR-gate runner: all scenarios passed\n`);
}

async function runLauncherScenarios(
  failures: AssertionFailure[],
  daemon: CopillmDaemon,
  seeded: SeededHome,
  mock: MockBackend
): Promise<void> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copillm-launcher-"));
  const mockEnv: Record<string, string> = {
    COPILLM_UPSTREAM_BASE_URL: mock.baseUrl,
    COPILLM_TOKEN_EXCHANGE_URL: mock.tokenExchangeUrl,
    COPILLM_GITHUB_USER_URL: mock.githubUserUrl
  };
  try {
    for (const agent of ["codex", "claude", "pi"] as const) {
      // Scenario A: agent already installed on PATH
      await runScenario(failures, `launcher-${agent}-system-path`, async () => {
        const scenarioDir = path.join(tmpRoot, `path-${agent}`);
        fs.mkdirSync(scenarioDir, { recursive: true });
        const capturePath = path.join(scenarioDir, "capture.json");
        const stub = createAgentStub({ dir: scenarioDir, agent, capturePath });

        // Pi has no env-var override for its config dir; redirect HOME so its
        // launch-time read of ~/.pi/agent/models.json hits the seeded daemon
        // copy rather than the developer's real home.
        const extraEnv: Record<string, string> = agent === "pi"
          ? { HOME: daemon.fakeHome, USERPROFILE: daemon.fakeHome }
          : {};

        const expectedExtraArg = `--from-${agent}-pathtest`;
        const out = await runCli(["--", agent, expectedExtraArg], {
          ...mockEnv,
          ...extraEnv,
          COPILLM_HOME: seeded.copillmHome,
          // PATH lookup is opt-in now; this scenario exercises that legacy path.
          COPILLM_USE_SYSTEM_AGENT: "1",
          PATH: `${stub.binDir}${path.delimiter}${process.env.PATH ?? ""}`
        });
        assertEquals(out.status, 0, `launcher ${agent} (system PATH) should exit 0; stderr=${out.stderr}`);

        if (!fs.existsSync(capturePath)) {
          throw new Error(`stub ${agent} did not produce capture file at ${capturePath}; stdout=${out.stdout} stderr=${out.stderr}`);
        }
        const capture = JSON.parse(fs.readFileSync(capturePath, "utf8")) as {
          argv: string[];
          env: Record<string, string>;
          agent: string;
        };
        if (capture.agent !== agent) throw new Error(`captured agent mismatch: ${capture.agent}`);
        if (!capture.argv.includes(expectedExtraArg)) {
          throw new Error(`expected stub to receive ${expectedExtraArg} in argv; got ${JSON.stringify(capture.argv)}`);
        }
        if (agent === "codex") {
          if (!capture.env.CODEX_HOME) throw new Error("CODEX_HOME should be set when launching codex");
        } else if (agent === "claude") {
          if (capture.env.ANTHROPIC_BASE_URL !== `http://127.0.0.1:${daemon.port}/anthropic`) {
            throw new Error(`ANTHROPIC_BASE_URL mismatch: ${capture.env.ANTHROPIC_BASE_URL}`);
          }
          if (capture.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY !== "1") {
            throw new Error("expected gateway flag to be forwarded to claude stub");
          }
        } else {
          // pi: copillm forwards no env vars; instead it must have refreshed
          // ~/.pi/agent/models.json under the fake HOME before exec'ing pi.
          const configPath = path.join(daemon.fakeHome, ".pi", "agent", "models.json");
          if (!fs.existsSync(configPath)) {
            throw new Error(`copillm pi launcher should refresh models.json at ${configPath}`);
          }
          if (capture.env.HOME !== daemon.fakeHome) {
            throw new Error(`pi stub should inherit fake HOME=${daemon.fakeHome}; got ${capture.env.HOME}`);
          }
        }
        if (!out.stderr.includes("system PATH")) {
          throw new Error(`expected stderr to mention "system PATH"; got: ${out.stderr}`);
        }
      });

      // Scenario B: agent not on PATH; resolver must install via fake npm into cache
      await runScenario(failures, `launcher-${agent}-download`, async () => {
        const scenarioDir = path.join(tmpRoot, `dl-${agent}`);
        fs.mkdirSync(scenarioDir, { recursive: true });
        const capturePath = path.join(scenarioDir, "capture.json");
        const packageName = agent === "codex"
          ? "@openai/codex"
          : agent === "claude"
          ? "@anthropic-ai/claude-code"
          : "@earendil-works/pi-coding-agent";
        const version = "9.9.9-test";
        const tarball = buildAgentStubTarball({
          dir: scenarioDir,
          agent,
          capturePath,
          packageName,
          version
        });
        const fakeNpm = createFakeNpm({ dir: scenarioDir, packageName, version, tarballPath: tarball });

        // Reuse the running seeded daemon (so we don't need to auto-start a new one).
        // Sanitize PATH: keep system tools (so node works) but drop any pre-existing
        // codex/claude/pi on PATH.
        const sanitizedPath = sanitizedPathWithout(agent);
        const launcherPath = `${fakeNpm.binDir}${path.delimiter}${sanitizedPath}`;

        const extraEnv: Record<string, string> = agent === "pi"
          ? { HOME: daemon.fakeHome, USERPROFILE: daemon.fakeHome }
          : {};

        const expectedExtraArg = `--from-${agent}-dltest`;
        const out = await runCli(["--", agent, expectedExtraArg], {
          ...mockEnv,
          ...extraEnv,
          COPILLM_HOME: seeded.copillmHome,
          PATH: launcherPath
        });
        if (out.status !== 0) {
          throw new Error(`launcher ${agent} (download) exit ${out.status}; stderr=${out.stderr}; stdout=${out.stdout}`);
        }

        if (!fs.existsSync(capturePath)) {
          throw new Error(`installed stub did not write capture; stderr=${out.stderr}; stdout=${out.stdout}`);
        }
        const capture = JSON.parse(fs.readFileSync(capturePath, "utf8")) as {
          argv: string[];
          source: string;
        };
        if (capture.source !== "installed") throw new Error(`expected installed source marker, got ${capture.source}`);
        if (!capture.argv.includes(expectedExtraArg)) {
          throw new Error(`expected stub to receive ${expectedExtraArg} in argv; got ${JSON.stringify(capture.argv)}`);
        }

        const cacheDir = path.join(seeded.copillmHome, "bin", agent, version);
        if (!fs.existsSync(cacheDir)) {
          throw new Error(`expected cache dir at ${cacheDir} after install`);
        }
        const versionMarker = path.join(cacheDir, "version.txt");
        if (!fs.existsSync(versionMarker)) {
          throw new Error(`expected version.txt marker at ${versionMarker}`);
        }
        if (!out.stderr.includes("installing") && !out.stderr.includes("installed")) {
          throw new Error(`expected stderr to mention install activity; got: ${out.stderr}`);
        }
      });

      // Scenario B-prime: re-run uses cache (no install), proving idempotency
      await runScenario(failures, `launcher-${agent}-cache-hit`, async () => {
        const scenarioDir = path.join(tmpRoot, `dl-${agent}`); // reuse from previous scenario
        const capturePath = path.join(scenarioDir, "capture.json");
        if (fs.existsSync(capturePath)) fs.unlinkSync(capturePath);

        const sanitizedPath = sanitizedPathWithout(agent);
        // View-only npm shim — install MUST NOT be called (cache should hit).
        const cacheReuseNpm = path.join(scenarioDir, "cache-reuse-bin");
        fs.mkdirSync(cacheReuseNpm, { recursive: true });
        writeNodeShim(cacheReuseNpm);
        const viewOnlyShim =
          `#!/usr/bin/env node\n` +
          `if (process.argv[2] === "view") { process.stdout.write("9.9.9-test\\n"); process.exit(0); }\n` +
          `process.stderr.write("cache-reuse-npm: refusing " + process.argv.slice(2).join(" ") + "\\n");\n` +
          `process.exit(1);\n`;
        if (process.platform === "win32") {
          const jsPath = path.join(cacheReuseNpm, "npm.js");
          fs.writeFileSync(jsPath, viewOnlyShim);
          fs.writeFileSync(path.join(cacheReuseNpm, "npm.cmd"), `@node "${jsPath}" %*\r\n`);
        } else {
          fs.writeFileSync(path.join(cacheReuseNpm, "npm"), viewOnlyShim, { mode: 0o755 });
        }

        const out = await runCli(["--", agent, "--from-cache"], {
          ...mockEnv,
          ...(agent === "pi" ? { HOME: daemon.fakeHome, USERPROFILE: daemon.fakeHome } : {}),
          COPILLM_HOME: seeded.copillmHome,
          PATH: `${cacheReuseNpm}${path.delimiter}${sanitizedPath}`
        });
        if (out.status !== 0) {
          throw new Error(`cache-hit ${agent} exit ${out.status}; stderr=${out.stderr}; stdout=${out.stdout}`);
        }
        if (!fs.existsSync(capturePath)) {
          throw new Error(`cached stub did not run; stderr=${out.stderr}`);
        }
        if (!out.stderr.includes("cached")) {
          throw new Error(`expected stderr to mention "cached"; got: ${out.stderr}`);
        }
      });
    }
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best effort
    }
    // Best-effort cleanup of the bin cache we populated under the seeded home.
    try {
      fs.rmSync(path.join(seeded.copillmHome, "bin"), { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], extraEnv: Record<string, string>): Promise<CliResult> {
  // Drop a leading "--" sentinel that callers may use to defeat shell parsing.
  const cleanedArgs = args[0] === "--" ? args.slice(1) : args;
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  return new Promise<CliResult>((resolve) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...cleanedArgs], {
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, 180_000);
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: -1, stdout, stderr: stderr + `\nerror: ${err.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ status: -1, stdout, stderr: stderr + `\n[runCli timeout, signal=${signal ?? "?"}]` });
        return;
      }
      resolve({ status: code ?? (signal ? -1 : 0), stdout, stderr });
    });
  });
}

function sanitizedPathWithout(agent: AgentName): string {
  const PATH = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase())
    : [""];
  const filtered: string[] = [];
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    let hasAgent = false;
    for (const ext of exts) {
      try {
        if (fs.statSync(path.join(dir, `${agent}${ext}`)).isFile()) {
          hasAgent = true;
          break;
        }
      } catch {
        // not here
      }
    }
    if (!hasAgent) filtered.push(dir);
  }
  return filtered.join(sep);
}

async function runScenario(failures: AssertionFailure[], name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`  > ${name}... `);
  try {
    await fn();
    process.stdout.write("ok\n");
  } catch (error) {
    process.stdout.write("FAIL\n");
    failures.push({ scenario: name, detail: error instanceof Error ? error.message : String(error) });
  }
}

function assertContains(haystack: readonly string[], needle: string, msg: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${msg} (got: ${haystack.join(", ") || "<empty>"})`);
  }
}

function assertNotContains(haystack: readonly string[], needle: string, msg: string): void {
  if (haystack.includes(needle)) {
    throw new Error(`${msg} (unexpected: ${needle} in ${haystack.join(", ")})`);
  }
}

function assertEquals<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

function assertGreaterThan(actual: number, threshold: number, msg: string): void {
  if (!(actual > threshold)) {
    throw new Error(`${msg} (expected > ${threshold}, got ${actual})`);
  }
}

function log(line: string): void {
  process.stdout.write(`[pr-gate] ${line}\n`);
}

main().catch((error) => {
  process.stderr.write(`pr-gate runner crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
