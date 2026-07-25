/** Swap SPL tokens on Solana through the Jupiter aggregator.
 *
 * Flow: quote input -> output, ask Jupiter to build the swap
 * transaction, sign it locally, submit to the RPC, and confirm.
 * `buy` swaps SOL into a token; `sell` swaps a token back into SOL.
 */
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

import { config, rpcUrl } from "./config.js";
import { SOLANA_DEFAULT_RPC } from "./chains.js";
import { makeLog } from "./log.js";

const log = makeLog("solana_swap");

export const SOL_MINT = "So11111111111111111111111111111111111111112";
const QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
const SWAP_URL = "https://lite-api.jup.ag/swap/v1/swap";
const LAMPORTS_PER_SOL = 1_000_000_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function keypair(): Keypair {
  if (!config.SOLANA_PRIVATE_KEY) throw new Error("SOLANA_PRIVATE_KEY is not set");
  return Keypair.fromSecretKey(bs58.decode(config.SOLANA_PRIVATE_KEY));
}

function rpc(): string {
  return rpcUrl("solana", SOLANA_DEFAULT_RPC);
}

/** Raw balance and decimals of an SPL token held by the bot's wallet. */
export async function tokenBalance(mint: string): Promise<{ raw: bigint; decimals: number }> {
  const owner = keypair().publicKey.toBase58();
  const resp = await fetch(rpc(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner",
      params: [owner, { mint }, { encoding: "jsonParsed" }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await resp.json();
  if (data.error) throw new Error(`getTokenAccountsByOwner failed: ${JSON.stringify(data.error)}`);

  let raw = 0n;
  let decimals = 0;
  for (const acct of data?.result?.value ?? []) {
    const amount = acct?.account?.data?.parsed?.info?.tokenAmount;
    if (!amount) continue;
    raw += BigInt(amount.amount ?? "0");
    decimals = amount.decimals ?? decimals;
  }
  return { raw, decimals };
}

/** Swap `amountRaw` base units of `inputMint` into `outputMint`. */
export async function swap(
  inputMint: string,
  outputMint: string,
  amountRaw: bigint
): Promise<string> {
  const kp = keypair();
  const endpoint = rpc();

  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amountRaw.toString(),
    slippageBps: String(config.SLIPPAGE_BPS),
  });
  const quoteResp = await fetch(`${QUOTE_URL}?${params}`, {
    signal: AbortSignal.timeout(10_000),
  });
  const quote = await quoteResp.json();
  if (quoteResp.status !== 200 || quote.error) {
    throw new Error(`Jupiter quote failed: ${JSON.stringify(quote)}`);
  }

  const swapResp = await fetch(SWAP_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: kp.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { priorityLevel: "high", maxLamports: 2_000_000 },
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const built = await swapResp.json();
  if (swapResp.status !== 200 || !built.swapTransaction) {
    throw new Error(`Jupiter swap build failed: ${JSON.stringify(built)}`);
  }

  const tx = VersionedTransaction.deserialize(Buffer.from(built.swapTransaction, "base64"));
  tx.sign([kp]);

  const sendResp = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "sendTransaction",
      params: [
        Buffer.from(tx.serialize()).toString("base64"),
        { encoding: "base64", skipPreflight: false, maxRetries: 3 },
      ],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const result = await sendResp.json();
  if (result.error) {
    throw new Error(`sendTransaction failed: ${JSON.stringify(result.error)}`);
  }
  const signature: string = result.result;

  log.info(`[Solana] swap sent: ${signature}`);
  await confirm(endpoint, signature);
  return signature;
}

/** Swap `amountSol` SOL for `tokenMint`. Returns the tx signature. */
export async function buy(tokenMint: string, amountSol: number): Promise<string> {
  return swap(SOL_MINT, tokenMint, BigInt(Math.trunc(amountSol * LAMPORTS_PER_SOL)));
}

/** Swap `amountRaw` base units of `tokenMint` back into SOL. */
export async function sell(tokenMint: string, amountRaw: bigint): Promise<string> {
  return swap(tokenMint, SOL_MINT, amountRaw);
}

async function confirm(endpoint: string, signature: string, tries = 30): Promise<void> {
  for (let i = 0; i < tries; i++) {
    await sleep(2000);
    let status: any;
    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "getSignatureStatuses",
          params: [[signature], { searchTransactionHistory: true }],
        }),
        signal: AbortSignal.timeout(6000),
      });
      status = ((await resp.json())?.result?.value ?? [null])[0];
    } catch {
      continue;
    }
    if (status) {
      if (status.err) throw new Error(`Solana transaction failed: ${JSON.stringify(status.err)}`);
      if (["confirmed", "finalized"].includes(status.confirmationStatus)) return;
    }
  }
  throw new Error(`Solana transaction not confirmed in time: ${signature}`);
}
