# CLI with Action Receipts

An OpenHarness CLI agent that produces a cryptographically signed audit trail for every tool call.

Built with the [`withActionReceipts`](../../packages/core/src/middleware/action-receipts.ts) middleware and the [Attest Protocol](https://github.com/attest-protocol/spec) TypeScript SDK.

## What it does

Every time the agent calls a tool (read a file, run a command, etc.), the middleware:

1. **Classifies** the action using taxonomy mappings (`taxonomy.json`)
2. **Signs** a W3C Verifiable Credential with Ed25519
3. **Hash-chains** it to the previous receipt (SHA-256)
4. **Stores** it in a local SQLite database

The result is a tamper-evident, cryptographically verifiable audit trail of everything the agent did.

## Quick start

```sh
# From the repo root
pnpm install

# Run the agent (creates receipts.db alongside the script)
cd examples/cli-with-receipts
npm start

# After a conversation, inspect the receipts
npm run receipts              # summary stats
npm run receipts -- --chain   # list all receipts
npm run receipts -- --verify  # verify chain integrity
```

Requires an `OPENAI_API_KEY` in a `.env` file at the repo root.

## How it works

The key addition over the base CLI example is one middleware in the runner pipeline:

```typescript
const runner = apply(
  toRunner(agent),
  withActionReceipts({
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    verificationMethod: "did:agent:cli-demo#key-1",
    issuer: { id: "did:agent:cli-demo", name: "CLI Demo Agent" },
    principal: { id: "did:user:local" },
    dbPath: "receipts.db",
    taxonomyMappings,
    onReceipt: (receipt) => {
      // Print each receipt as it's created
    },
  }),
  withTurnTracking(),
  withCompaction({ contextWindow: 200_000, model: agent.model }),
  withRetry(),
);
```

The middleware is transparent — all events pass through unchanged. The agent and UI code don't need to know receipts exist.

## Files

| File | Purpose |
|------|---------|
| `cli.ts` | CLI agent with receipt middleware wired in |
| `receipts.ts` | Utility to inspect the SQLite receipt store |
| `taxonomy.json` | Maps tool names to action types and risk levels |

## Receipt format

Each receipt is a W3C Verifiable Credential containing:

- **Action**: type, risk level, target system/resource, parameter hash
- **Outcome**: success/failure, error message
- **Chain**: sequence number, previous receipt hash, chain ID
- **Proof**: Ed25519 signature

Parameters are SHA-256 hashed — raw inputs are never stored in receipts.
