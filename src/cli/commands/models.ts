import type { Command } from "commander";
import { loadStoredCredential } from "../../auth/credentials.js";
import { CopilotTokenManager } from "../../auth/copilotToken.js";
import { loadConfig, saveConfig } from "../../config/config.js";
import { listModels, resolveModelSelections } from "../../models/discovery.js";
import { writeCommandOutput } from "../shared/output.js";

export function register(program: Command): void {
  const models = program.command("models").description("Model commands");

  models
    .command("list")
    .description("List entitled models")
    .option("--json", "JSON output")
    .action(async (opts: { json?: boolean }) => {
      const config = loadConfig();
      const creds = await loadStoredCredential();
      if (!creds) {
        throw new Error("Not authenticated. Run `copillm login`.");
      }
      const tokenManager = new CopilotTokenManager(creds.token);
      await tokenManager.ensureToken(false);
      const result = await listModels(config.accountType, creds.token);
      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            {
              models: result.models,
              discovery: {
                source: result.source,
                stale: result.stale,
                cache_age_seconds: result.cacheAgeSeconds,
                warning: result.warning
              }
            },
            null,
            2
          ) + "\n"
        );
        return;
      }
      process.stdout.write(result.models.map((model) => model.id).join("\n") + "\n");
      if (result.stale) {
        process.stdout.write("⚠ using stale model snapshot (upstream discovery unavailable)\n");
      }
    });

  models
    .command("select")
    .requiredOption("--models <ids>", "Comma-separated model ids")
    .description("Select exposed models")
    .option("--json", "JSON output")
    .action(async (opts: { models: string; json?: boolean }) => {
      const config = loadConfig();
      const requested = Array.from(
        new Set(
          opts.models
        .split(",")
        .map((value) => value.trim())
            .filter((value) => value.length > 0)
        )
      );
      if (requested.length === 0) {
        throw new Error("At least one model must be selected.");
      }
      const creds = await loadStoredCredential();
      if (!creds) {
        throw new Error("Not authenticated. Run `copillm login`.");
      }
      const tokenManager = new CopilotTokenManager(creds.token);
      await tokenManager.ensureToken(false);
      const discovery = await listModels(config.accountType, creds.token);
      const resolution = resolveModelSelections(requested, discovery.models);
      if (resolution.unresolved.length > 0) {
        const available = discovery.models.map((model) => model.id).join(", ");
        throw new Error(
          `Unknown model selection(s): ${resolution.unresolved.join(", ")}. Available models: ${available}`
        );
      }
      const resolvedSelected = Array.from(new Set(resolution.resolved.map((entry) => entry.resolvedId)));
      saveConfig({ ...config, selectedModels: resolvedSelected });
      const usedAlias = resolution.resolved.some((entry) => entry.input !== entry.resolvedId);
      writeCommandOutput(
        opts,
        `Selected ${resolvedSelected.length} model(s)${usedAlias ? " (resolved aliases)." : "."}${
          discovery.stale ? " Using stale snapshot." : ""
        }`,
        {
        status: "ok",
        selected_models: resolvedSelected,
        requested_models: requested,
        resolutions: resolution.resolved,
        discovery: {
          source: discovery.source,
          stale: discovery.stale,
          cache_age_seconds: discovery.cacheAgeSeconds,
          warning: discovery.warning
        }
      }
      );
    });
}
