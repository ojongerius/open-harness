/**
 * End-to-end test: tool execution → receipt creation → SQLite storage → verification.
 *
 * Tests the full pipeline without needing an LLM API key by using a runner
 * that executes a real tool and emits the same events an Agent would.
 */

import { describe, it, expect } from "vitest";
import {
	generateKeyPair,
	openStore,
	verifyReceipt,
	hashReceipt,
	verifyChain,
	type ActionReceipt,
	type TaxonomyMapping,
} from "@attest-protocol/attest-ts";
import type { Runner } from "../../runner.js";
import { apply } from "../../runner.js";
import { withActionReceipts } from "../../middleware/action-receipts.js";
import type { AgentEvent } from "../../agent.js";

// ── Helpers ─────────────────────────────────────────────────────────

async function collect(gen: AsyncGenerator<any>): Promise<any[]> {
	const result: any[] = [];
	for await (const event of gen) result.push(event);
	return result;
}

/**
 * A runner that executes real tool functions and emits the same events
 * an Agent would. This tests the middleware without going through
 * streamText / LLM API.
 */
function createToolRunner(
	toolCalls: Array<{
		toolName: string;
		input: Record<string, unknown>;
		execute: (input: any) => Promise<unknown>;
	}>,
): Runner {
	return async function* (_history, _input) {
		yield { type: "step.start", stepNumber: 1 } as AgentEvent;

		for (const call of toolCalls) {
			const toolCallId = `call_${crypto.randomUUID()}`;

			yield {
				type: "tool.start",
				toolCallId,
				toolName: call.toolName,
				input: call.input,
			} as AgentEvent;

			try {
				const output = await call.execute(call.input);
				yield {
					type: "tool.done",
					toolCallId,
					toolName: call.toolName,
					output,
				} as AgentEvent;
			} catch (err) {
				yield {
					type: "tool.error",
					toolCallId,
					toolName: call.toolName,
					error: String(err),
				} as AgentEvent;
			}
		}

		yield { type: "text.delta", text: "Done." } as AgentEvent;
		yield { type: "text.done", text: "Done." } as AgentEvent;
		yield {
			type: "step.done",
			stepNumber: 1,
			usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
			finishReason: "stop",
		} as AgentEvent;
		yield {
			type: "done",
			result: "complete",
			messages: [],
			totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
		} as AgentEvent;
	};
}

// ── Config ──────────────────────────────────────────────────────────

const keys = generateKeyPair();

const taxonomyMappings: TaxonomyMapping[] = [
	{ tool_name: "add", action_type: "system.command.execute" },
	{ tool_name: "readFile", action_type: "filesystem.file.read" },
];

// ── Tests ───────────────────────────────────────────────────────────

describe("withActionReceipts e2e", () => {
	it("tool execution produces a signed receipt in SQLite", async () => {
		const receipts: ActionReceipt[] = [];
		const store = openStore(":memory:");

		// Real tool: adds two numbers
		const runner = createToolRunner([
			{
				toolName: "add",
				input: { a: 2, b: 3 },
				execute: async ({ a, b }: { a: number; b: number }) => ({
					result: a + b,
				}),
			},
		]);

		const wrapped = apply(
			runner,
			withActionReceipts({
				privateKey: keys.privateKey,
				publicKey: keys.publicKey,
				verificationMethod: "did:agent:e2e-test#key-1",
				issuer: { id: "did:agent:e2e-test", name: "E2E Test Agent" },
				principal: { id: "did:user:test" },
				taxonomyMappings,
				onReceipt: (receipt, hash) => {
					receipts.push(receipt);
					store.insert(receipt, hash);
				},
			}),
		);

		const events = await collect(wrapped([], "What is 2 + 3?"));

		// ── Events flow through unchanged ───────────────────────────

		const toolStart = events.find(
			(e: any) => e.type === "tool.start" && e.toolName === "add",
		);
		expect(toolStart).toBeDefined();
		expect(toolStart.input).toEqual({ a: 2, b: 3 });

		const toolDone = events.find(
			(e: any) => e.type === "tool.done" && e.toolName === "add",
		);
		expect(toolDone).toBeDefined();
		expect(toolDone.output).toEqual({ result: 5 });

		const done = events.find((e: any) => e.type === "done");
		expect(done.result).toBe("complete");

		// ── Receipt was created ─────────────────────────────────────

		expect(receipts).toHaveLength(1);
		const receipt = receipts[0];

		// Classified via taxonomy mapping
		expect(receipt.credentialSubject.action.type).toBe("system.command.execute");
		expect(receipt.credentialSubject.action.risk_level).toBe("high");

		// Target records the tool
		expect(receipt.credentialSubject.action.target?.system).toBe("openharness");
		expect(receipt.credentialSubject.action.target?.resource).toBe("add");

		// Outcome is success
		expect(receipt.credentialSubject.outcome.status).toBe("success");

		// Parameters hashed, not stored
		expect(receipt.credentialSubject.action.parameters_hash).toMatch(/^sha256:/);
		expect(JSON.stringify(receipt)).not.toContain('"a":2');

		// Chain starts correctly
		expect(receipt.credentialSubject.chain.sequence).toBe(1);
		expect(receipt.credentialSubject.chain.previous_receipt_hash).toBeNull();

		// ── Signature is cryptographically valid ─────────────────────

		expect(verifyReceipt(receipt, keys.publicKey)).toBe(true);

		// ── Receipt persisted in SQLite ──────────────────────────────

		const stored = store.getById(receipt.id);
		expect(stored).toBeDefined();
		expect(stored!.id).toBe(receipt.id);

		const stats = store.stats();
		expect(stats.total).toBe(1);
		expect(stats.chains).toBe(1);

		store.close();
	});

	it("multiple tool calls produce a valid hash chain", async () => {
		const receipts: ActionReceipt[] = [];
		const hashes: string[] = [];
		const store = openStore(":memory:");

		const runner = createToolRunner([
			{
				toolName: "readFile",
				input: { path: "/tmp/test.txt" },
				execute: async () => "file contents",
			},
			{
				toolName: "add",
				input: { a: 10, b: 20 },
				execute: async ({ a, b }: { a: number; b: number }) => ({
					result: a + b,
				}),
			},
		]);

		const wrapped = apply(
			runner,
			withActionReceipts({
				privateKey: keys.privateKey,
				publicKey: keys.publicKey,
				verificationMethod: "did:agent:e2e-test#key-1",
				issuer: { id: "did:agent:e2e-test" },
				principal: { id: "did:user:test" },
				taxonomyMappings,
				onReceipt: (receipt, hash) => {
					receipts.push(receipt);
					hashes.push(hash);
					store.insert(receipt, hash);
				},
			}),
		);

		await collect(wrapped([], "Read file then add"));

		// ── Two receipts created ────────────────────────────────────

		expect(receipts).toHaveLength(2);

		// First receipt: filesystem.file.read (low risk)
		expect(receipts[0].credentialSubject.action.type).toBe("filesystem.file.read");
		expect(receipts[0].credentialSubject.action.risk_level).toBe("low");
		expect(receipts[0].credentialSubject.chain.sequence).toBe(1);
		expect(receipts[0].credentialSubject.chain.previous_receipt_hash).toBeNull();

		// Second receipt: system.command.execute (high risk)
		expect(receipts[1].credentialSubject.action.type).toBe("system.command.execute");
		expect(receipts[1].credentialSubject.chain.sequence).toBe(2);
		expect(receipts[1].credentialSubject.chain.previous_receipt_hash).toBe(hashes[0]);

		// ── Both signatures valid ───────────────────────────────────

		expect(verifyReceipt(receipts[0], keys.publicKey)).toBe(true);
		expect(verifyReceipt(receipts[1], keys.publicKey)).toBe(true);

		// ── Hash chain is intact ────────────────────────────────────

		const chainResult = verifyChain(receipts, keys.publicKey);
		expect(chainResult.valid).toBe(true);
		expect(chainResult.length).toBe(2);
		expect(chainResult.brokenAt).toBe(-1);

		// ── Store has both receipts ─────────────────────────────────

		const stats = store.stats();
		expect(stats.total).toBe(2);

		store.close();
	});

	it("failed tool call produces a failure receipt", async () => {
		const receipts: ActionReceipt[] = [];

		const runner = createToolRunner([
			{
				toolName: "add",
				input: { a: 1, b: "not a number" },
				execute: async () => {
					throw new Error("Invalid input: b must be a number");
				},
			},
		]);

		const wrapped = apply(
			runner,
			withActionReceipts({
				privateKey: keys.privateKey,
				publicKey: keys.publicKey,
				verificationMethod: "did:agent:e2e-test#key-1",
				issuer: { id: "did:agent:e2e-test" },
				principal: { id: "did:user:test" },
				taxonomyMappings,
				onReceipt: (receipt) => {
					receipts.push(receipt);
				},
			}),
		);

		const events = await collect(wrapped([], "Add broken input"));

		// Tool error event flowed through
		const toolError = events.find((e: any) => e.type === "tool.error");
		expect(toolError).toBeDefined();
		expect(toolError.error).toContain("Invalid input");

		// Receipt records the failure
		expect(receipts).toHaveLength(1);
		expect(receipts[0].credentialSubject.outcome.status).toBe("failure");
		expect(receipts[0].credentialSubject.outcome.error).toContain("Invalid input");

		// Signature still valid on failure receipts
		expect(verifyReceipt(receipts[0], keys.publicKey)).toBe(true);
	});
});
