/**
 * CLI agent with Action Receipt emission.
 *
 * Every tool call produces a cryptographically signed, hash-chained
 * receipt (W3C Verifiable Credential). Receipts are stored in a local
 * SQLite database and can be inspected with `npm run receipts`.
 */

import * as readline from "node:readline";
import { openai } from "@ai-sdk/openai";
import {
	generateKeyPair,
	loadTaxonomyConfig,
} from "@attest-protocol/attest-ts";
import chalk from "chalk";
import ora from "ora";
import {
	Agent,
	Conversation,
	toRunner,
	apply,
	withTurnTracking,
	withCompaction,
	withRetry,
	withActionReceipts,
	type AgentEvent,
	type ToolCallInfo,
	type SessionEvent,
} from "@openharness/core";
import {
	createFsTools,
	createBashTool,
	NodeFsProvider,
	NodeShellProvider,
} from "@openharness/core";

// ── Setup ─────────────────────────────────────────────────────────────

const fsProvider = new NodeFsProvider();
const shellProvider = new NodeShellProvider();
const fsTools = createFsTools(fsProvider);
const { readFile, listFiles, grep } = fsTools;
const { bash } = createBashTool(shellProvider);

// ── Action Receipts setup ───────────────────────────────────────────

const DB_PATH = "receipts.db";
const keys = generateKeyPair();
const taxonomyMappings = loadTaxonomyConfig(
	new URL("taxonomy.json", import.meta.url).pathname,
);

let receiptCount = 0;

// ── Readline setup ──────────────────────────────────────────────────

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
});

function ask(question: string): Promise<string> {
	return new Promise((resolve) => {
		rl.question(question, resolve);
	});
}

// ── Tool approval ───────────────────────────────────────────────────

let approvalQueue: Promise<void> = Promise.resolve();
const spinners = new Map<string, ReturnType<typeof ora>>();
const BAR = chalk.dim("│");

function formatInput(input: unknown): string {
	const json = JSON.stringify(input, null, 2);
	return json
		.split("\n")
		.map((line) => `  ${BAR}   ${chalk.dim(line)}`)
		.join("\n");
}

function approve(toolCall: ToolCallInfo): Promise<boolean> {
	const result = approvalQueue.then(() => promptApproval(toolCall));
	approvalQueue = result.then(
		() => {},
		() => {},
	);
	return result;
}

async function promptApproval({
	toolName,
	toolCallId,
	input,
}: ToolCallInfo): Promise<boolean> {
	console.log(`  ${BAR}`);
	console.log(
		`  ${chalk.yellow("○")} ${chalk.bold("Tool call:")} ${chalk.cyan(toolName)}`,
	);
	console.log(formatInput(input));
	console.log(`  ${BAR}`);

	const answer = await ask(
		`  ${BAR} ${chalk.yellow("?")} Allow? ${chalk.dim("[Y/n]")} `,
	);
	const denied = answer.trim().toLowerCase() === "n";

	if (denied) {
		console.log(`  ${BAR} ${chalk.red("✗")} Denied`);
		console.log(`  ${BAR}`);
		return false;
	}

	const spinner = ora({
		text: chalk.dim(toolName),
		prefixText: `  ${BAR}`,
		spinner: "dots",
	}).start();
	spinners.set(toolCallId, spinner);
	return true;
}

// ── Agent ───────────────────────────────────────────────────────────

const agent = new Agent({
	name: "cli-agent",
	systemPrompt:
		"You are an expert coding agent. You help the user analyze, understand, " +
		"and make changes to their project. Every tool call you make is recorded " +
		"as a cryptographically signed Action Receipt for audit purposes.",
	model: openai("gpt-4o"),
	tools: { ...fsTools, bash },
	maxSteps: 20,
	approve,
});

// ── Compose middleware (with Action Receipts) ───────────────────────

const runner = apply(
	toRunner(agent),
	withActionReceipts({
		privateKey: keys.privateKey,
		publicKey: keys.publicKey,
		verificationMethod: "did:agent:cli-demo#key-1",
		issuer: { id: "did:agent:cli-demo", name: "CLI Demo Agent" },
		principal: { id: "did:user:local" },
		dbPath: DB_PATH,
		taxonomyMappings,
		onReceipt: (receipt) => {
			receiptCount++;
			const action = receipt.credentialSubject.action;
			const chain = receipt.credentialSubject.chain;
			console.log(
				`  ${chalk.dim("⛓")} Receipt #${chain.sequence}: ${chalk.cyan(action.type)} ` +
					`[${action.risk_level}] ${chalk.dim(receipt.id.slice(0, 24) + "…")}`,
			);
		},
	}),
	withTurnTracking(),
	withCompaction({ contextWindow: 200_000, model: agent.model }),
	withRetry(),
);

const chat = new Conversation({ runner });

// ── Main loop ───────────────────────────────────────────────────────

async function main() {
	console.log();
	console.log(
		`  ${chalk.bold.cyan("open-harness + attest")} ${chalk.dim("gpt-4o · fs tools · action receipts")}`,
	);
	console.log(`  ${chalk.dim(`Receipts → ${DB_PATH} | Run "npm run receipts" to inspect`)}`);
	console.log(`  ${chalk.dim('Type "exit" to quit.')}`);

	while (true) {
		console.log();
		const input = await ask(`  ${chalk.green("❯")} `);
		if (input.trim().toLowerCase() === "exit") break;
		if (!input.trim()) continue;

		console.log();

		let doneEvent: Extract<SessionEvent, { type: "done" }> | undefined;
		let streaming = false;

		for await (const event of chat.send(input)) {
			switch (event.type) {
				case "turn.start":
					break;

				case "text.delta":
					if (!streaming) {
						process.stdout.write(`  ${BAR} `);
						streaming = true;
					}
					process.stdout.write(event.text);
					break;

				case "text.done":
					if (streaming) {
						process.stdout.write("\n");
						streaming = false;
					}
					break;

				case "tool.start":
					break;

				case "tool.done": {
					const s = spinners.get(event.toolCallId);
					if (s) {
						s.succeed(chalk.dim(event.toolName));
					} else {
						console.log(
							`  ${BAR} ${chalk.green("✔")} ${chalk.dim(event.toolName)}`,
						);
					}
					spinners.delete(event.toolCallId);
					break;
				}

				case "tool.error": {
					const s = spinners.get(event.toolCallId);
					if (s) {
						s.fail(
							`${chalk.dim(event.toolName)} ${chalk.red(event.error)}`,
						);
					} else {
						console.log(
							`  ${BAR} ${chalk.red("✗")} ${chalk.dim(event.toolName)} ${chalk.red(event.error)}`,
						);
					}
					spinners.delete(event.toolCallId);
					break;
				}

				case "step.done":
					break;

				case "error":
					for (const s of spinners.values()) s.stop();
					spinners.clear();
					console.error(
						`  ${chalk.red("✗")} ${event.error.message}`,
					);
					break;

				case "done":
					doneEvent = event;
					break;

				case "compaction.start":
					console.log(
						`  ${chalk.dim("⟳")} Compacting... (${event.tokensBefore} estimated tokens)`,
					);
					break;

				case "compaction.done":
					console.log(
						`  ${chalk.green("✔")} Compacted: ${event.tokensBefore} → ${event.tokensAfter} estimated tokens`,
					);
					break;

				case "retry":
					console.log(
						`  ${chalk.yellow("⟳")} Retrying in ${event.delayMs}ms... (attempt ${event.attempt + 1}/${event.maxRetries})`,
					);
					break;

				case "turn.done": {
					const parts: string[] = [`Turn ${event.turnNumber}`];
					if (event.usage.totalTokens) {
						parts.push(`${event.usage.totalTokens} tokens`);
					}
					parts.push(`${receiptCount} receipts`);
					console.log(`  ${chalk.dim(parts.join(" · "))}`);
					break;
				}
			}
		}

		if (streaming) {
			process.stdout.write("\n");
		}

		if (doneEvent) {
			const { totalUsage } = doneEvent;
			const parts: string[] = [doneEvent.result];
			if (totalUsage.totalTokens) {
				parts.push(`${totalUsage.totalTokens} tokens`);
			}
			console.log(`  ${chalk.dim(parts.join(" · "))}`);
		}
	}

	console.log();
	console.log(
		`  ${chalk.dim(`${receiptCount} receipts stored in ${DB_PATH}`)}`,
	);
	console.log(`  ${chalk.dim("Goodbye.")}`);
	console.log();
	await agent.close();
	rl.close();
}

main();
