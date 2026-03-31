/**
 * Inspect the Action Receipt store.
 *
 * Usage:
 *   npm run receipts                  # show summary stats
 *   npm run receipts -- --chain       # list all receipts in chain order
 *   npm run receipts -- --verify      # verify chain integrity
 */

import { openStore, verifyStoredChain, generateKeyPair } from "@attest-protocol/attest-ts";
import chalk from "chalk";

const DB_PATH = "receipts.db";

function main() {
	let store;
	try {
		store = openStore(DB_PATH);
	} catch {
		console.log(chalk.red(`No receipt store found at ${DB_PATH}`));
		console.log(chalk.dim("Run the CLI agent first: npm start"));
		process.exit(1);
	}

	const stats = store.stats();
	const args = process.argv.slice(2);

	if (args.includes("--chain")) {
		// List all receipts
		const receipts = store.query({});
		console.log();
		console.log(chalk.bold(`  ${receipts.length} receipts in store`));
		console.log();

		for (const r of receipts) {
			const action = r.credentialSubject.action;
			const chain = r.credentialSubject.chain;
			const outcome = r.credentialSubject.outcome;
			const status =
				outcome.status === "success"
					? chalk.green("✔")
					: chalk.red("✗");

			console.log(
				`  ${status} #${String(chain.sequence).padStart(3)} ${chalk.cyan(action.type.padEnd(28))} ` +
					`${riskColor(action.risk_level)} ${chalk.dim(action.timestamp)}`,
			);
		}
		console.log();
	} else if (args.includes("--verify")) {
		// Verify all chains
		console.log();
		console.log(chalk.bold("  Chain verification"));
		console.log();

		// We don't have the public key stored, so just report structure
		const allReceipts = store.query({});
		const chainIds = [...new Set(allReceipts.map((r) => r.credentialSubject.chain.chain_id))];

		for (const chainId of chainIds) {
			const chain = store.getChain(chainId);
			const sequences = chain.map((r) => r.credentialSubject.chain.sequence);
			const isSequential = sequences.every((s, i) => i === 0 || s === sequences[i - 1] + 1);
			const hasLinks = chain.every(
				(r, i) =>
					i === 0
						? r.credentialSubject.chain.previous_receipt_hash === null
						: r.credentialSubject.chain.previous_receipt_hash !== null,
			);

			const ok = isSequential && hasLinks;
			const icon = ok ? chalk.green("✔") : chalk.red("✗");
			console.log(
				`  ${icon} Chain ${chalk.dim(chainId.slice(0, 20) + "…")} — ` +
					`${chain.length} receipts, sequences ${ok ? "valid" : "BROKEN"}`,
			);
		}
		console.log();
	} else {
		// Summary
		console.log();
		console.log(chalk.bold("  Receipt Store Summary"));
		console.log();
		console.log(`  Total receipts:  ${stats.total}`);
		console.log(`  Chains:          ${stats.chains}`);
		console.log();

		if (stats.byRisk.length > 0) {
			console.log(chalk.bold("  By risk level:"));
			for (const { risk_level, count } of stats.byRisk) {
				console.log(`    ${riskColor(String(risk_level))} ${count}`);
			}
			console.log();
		}

		if (stats.byAction.length > 0) {
			console.log(chalk.bold("  By action type:"));
			for (const { action_type, count } of stats.byAction) {
				console.log(
					`    ${chalk.cyan(String(action_type).padEnd(30))} ${count}`,
				);
			}
			console.log();
		}

		if (stats.byStatus.length > 0) {
			console.log(chalk.bold("  By outcome:"));
			for (const { status, count } of stats.byStatus) {
				const icon = status === "success" ? chalk.green("✔") : chalk.red("✗");
				console.log(`    ${icon} ${String(status).padEnd(10)} ${count}`);
			}
			console.log();
		}
	}

	store.close();
}

function riskColor(level: string): string {
	switch (level) {
		case "low":
			return chalk.green(level.padEnd(8));
		case "medium":
			return chalk.yellow(level.padEnd(8));
		case "high":
			return chalk.red(level.padEnd(8));
		case "critical":
			return chalk.bgRed.white(level.padEnd(8));
		default:
			return level.padEnd(8);
	}
}

main();
