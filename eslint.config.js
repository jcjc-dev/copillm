// Flat config (ESLint 9). Enforces architectural import boundaries
// between src/ subfolders via eslint-plugin-boundaries v6.
//
// The allowed-import map encodes the CURRENT shape of the codebase
// (see investigation.md §5). Its purpose is to freeze that shape and
// prevent regressions — not to refactor existing imports.

import tsParser from "@typescript-eslint/parser";
import boundaries from "eslint-plugin-boundaries";

const allow = (...types) => types.map((type) => ({ to: { type } }));

export default [
  {
    files: ["src/**/*.ts"],
    ignores: ["src/*.ts"], // top-level entry files (e.g. src/cli.ts)
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: "module",
    },
    plugins: { boundaries },
    settings: {
      "import/resolver": {
        typescript: { alwaysTryTypes: true },
      },
      "boundaries/include": ["src/**/*.ts"],
      "boundaries/elements": [
        { type: "agentconfig", pattern: "src/agentconfig/**" },
        { type: "agents", pattern: "src/agents/**" },
        { type: "auth", pattern: "src/auth/**" },
        { type: "cli", pattern: "src/cli/**" },
        { type: "config", pattern: "src/config/**" },
        { type: "integrations", pattern: "src/integrations/**" },
        { type: "models", pattern: "src/models/**" },
        { type: "server", pattern: "src/server/**" },
        { type: "translation", pattern: "src/translation/**" },
        { type: "types", pattern: "src/types/**" },
      ],
    },
    rules: {
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          rules: [
            // cli is the top-level entry; it may import any element.
            {
              from: { type: "cli" },
              allow: allow(
                "agentconfig",
                "agents",
                "auth",
                "cli",
                "config",
                "integrations",
                "models",
                "server",
                "translation",
                "types",
              ),
            },

            // server depends on auth, models, translation, config, types
            // (plus its own upstream/ subfolder which is intra-element).
            {
              from: { type: "server" },
              allow: allow("auth", "models", "translation", "config", "types", "server"),
            },

            // translation currently imports a helper from server
            // (isBenignSocketError). Frozen as-is; see follow-up.
            {
              from: { type: "translation" },
              allow: allow("server", "translation", "types"),
            },

            // auth currently imports server/debugInfo.js. Frozen as-is;
            // see follow-up to invert that dependency.
            {
              from: { type: "auth" },
              allow: allow("auth", "config", "server", "types"),
            },

            // integrations imports auth + server lock/schema today.
            // Frozen as-is; intended target is models/config/types only.
            {
              from: { type: "integrations" },
              allow: allow(
                "auth",
                "config",
                "integrations",
                "models",
                "server",
                "types",
              ),
            },

            // agents currently only touches the integrations registry.
            {
              from: { type: "agents" },
              allow: allow("agents", "integrations"),
            },

            // agentconfig is a leaf consumer of config + types.
            {
              from: { type: "agentconfig" },
              allow: allow("agentconfig", "config", "types"),
            },

            // models is a leaf consumer of config + types.
            {
              from: { type: "models" },
              allow: allow("models", "config", "types"),
            },

            // config is a leaf consumer of types only.
            {
              from: { type: "config" },
              allow: allow("config", "types"),
            },

            // types must remain dependency-free.
            {
              from: { type: "types" },
              allow: allow("types"),
            },
          ],
        },
      ],
    },
  },
];
