import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import {
  applyPreferredCodexDefaultModel,
  checkCodexProviderStatus,
  mapCodexModelCapabilities,
} from "./CodexProvider.ts";

const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);

it.layer(NodeServices.layer)("Codex inventory discovery", (it) => {
  it.effect("keeps the successful inventory when the other request fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-inventory-" });
      const binaryPath = writeFakeCli({
        directory,
        name: "codex-inventory",
        source: [
          'import { createInterface } from "node:readline";',
          'createInterface({ input: process.stdin }).on("line", (line) => {',
          "  const request = JSON.parse(line);",
          "  if (request.id === undefined) return;",
          "  const responses = {",
          '    initialize: { userAgent: "codex/1.0.0", codexHome: process.cwd(), platformFamily: "unix", platformOs: "linux" },',
          '    "account/read": { account: { type: "apiKey" }, requiresOpenaiAuth: false },',
          '    "model/list": { data: [], nextCursor: null },',
          '    "skills/list": { data: [{ cwd: process.cwd(), errors: [], skills: [] }] },',
          "  };",
          "  const result = responses[request.method];",
          "  const response = request.method === process.env.T3_TEST_FAILED_INVENTORY || result === undefined",
          '    ? { id: request.id, error: { code: -32603, message: "Discovery failed" } }',
          "    : { id: request.id, result };",
          '  process.stdout.write(JSON.stringify(response) + "\\n");',
          "});",
        ].join("\n"),
      });
      const settings = yield* decodeCodexSettings({
        enabled: true,
        binaryPath,
        customModels: ["custom-model"],
      });
      for (const failedMethod of ["skills/list", "model/list"] as const) {
        const snapshot = yield* checkCodexProviderStatus(settings, undefined, {
          ...process.env,
          T3_TEST_FAILED_INVENTORY: failedMethod,
        });
        assert.strictEqual(snapshot.status, "warning");
        assert.strictEqual(snapshot.auth.status, "authenticated");
        assert.deepStrictEqual(
          snapshot.models.map((model) => model.slug),
          ["custom-model"],
        );
        assert.strictEqual(
          snapshot.inventory?.models,
          failedMethod === "model/list" ? "stale" : "authoritative",
        );
        assert.strictEqual(
          snapshot.inventory?.skills,
          failedMethod === "skills/list" ? "stale" : "authoritative",
        );
      }
    }),
  );
});

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});
