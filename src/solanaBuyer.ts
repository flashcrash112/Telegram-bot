/** Buy an SPL token on Solana through the Jupiter aggregator.
 *
 * Flow: quote SOL -> token, ask Jupiter to build the swap transaction,
 * sign it locally, submit to the RPC, and confirm.
 */
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

import { config, rpcUrl } from "./config.js";
import { SOLANA_DEFAULT_RPC } from "./chains.js";
import { makeLog } from "./log.js";

const log = makeLog("solana_buyer");

const SOL_MINT = "So11111111111111111111111111111111111111112";
const QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
const SWAP_URL = "https://lite-api.jup.ag/swap/v1/swap";
const LAMPORTS_PER_SOL = 1_000_000_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Swap `amountSol` SOL for `tokenMint`. Returns the tx signature. */
export async function buy(tokenMint: string, amountSol: number): Promise<string> {
  if (!config.SOLANA_PRIVATE_KEY) throw new Error("SOLANA_PRIVATE_KEY is not set");

  const keypair = Keypair.fromSecretKey(bs58.decode(config.SOLANA_PRIVATE_KEY));
  const rpc = rpcUrl("solana", SOLANA_DEFAULT_RPC);
  const lamports = Math.trunc(amountSol * LAMPORTS_PER_SOL);

  const params = new URLSearchParams({
    inputMint: SOL_MINT,
    outputMint: tokenMint,
    amount: String(lamports),
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
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { priorityLevel: "high", maxLamports: 2_000_000 },
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const swap = await swapResp.json();
  if (swapResp.status !== 200 || !swap.swapTransaction) {
    throw new Error(`Jupiter swap build failed: ${JSON.stringify(swap)}`);
  }

  const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
  tx.sign([keypair]);

  const sendResp = await fetch(rpc, {
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

  log.info(`[Solana] buy sent: ${signature}`);
  await confirm(rpc, signature);
  return signature;
}

async function confirm(rpc: string, signature: string, tries = 30): Promise<void> {
  for (let i = 0; i < tries; i++) {
    await sleep(2000);
    let status: any;
    try {
      const resp = await fetch(rpc, {
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
